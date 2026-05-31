/**
 * Ledger helpers — append payments / cashouts / adjustments and compute totals.
 *
 * `payment`     positive amount, method = 'zelle' | 'venmo' | 'paypal' | 'crypto'
 * `cashout`     positive amount, method = NULL — represents money taken out (subtracted from balance)
 * `adjustment`  positive amount, method = a provider — chargebacks/refunds, subtracted at read
 */

/**
 * Wipe every Payment Bot table. Used by /purge for "starting over" — e.g. switching
 * the bot to a new business. Returns the row counts that were deleted.
 */
export function purgeAll(db) {
  const counts = {
    ledger: db.get(`SELECT COUNT(*) AS n FROM ledger`).n,
    imap_cursor: db.get(`SELECT COUNT(*) AS n FROM imap_cursor`).n,
    dashboard_pointer: db.get(`SELECT COUNT(*) AS n FROM dashboard_pointer`).n,
  };
  const txn = db.transaction(() => {
    db.run(`DELETE FROM ledger`);
    db.run(`DELETE FROM imap_cursor`);
    db.run(`DELETE FROM dashboard_pointer`);
  });
  txn();
  return counts;
}

/* ---------------------------------------------- dashboard pointers ---- */

export function saveDashboardPointer(db, { channelId, messageId }) {
  db.run(
    `INSERT INTO dashboard_pointer (channel_id, message_id, posted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET posted_at = excluded.posted_at`,
    channelId,
    messageId,
    Date.now(),
  );
}

export function listDashboardPointers(db) {
  return db.all(
    `SELECT channel_id, message_id, posted_at, current_page
     FROM dashboard_pointer ORDER BY posted_at DESC`,
  );
}

export function removeDashboardPointer(db, messageId) {
  db.run(`DELETE FROM dashboard_pointer WHERE message_id = ?`, messageId);
}

/**
 * Flip a dashboard pointer to the given page so the next refresh
 * (button click OR ledger event) re-renders that view.
 */
export function setDashboardPage(db, messageId, page) {
  db.run(
    `UPDATE dashboard_pointer SET current_page = ? WHERE message_id = ?`,
    page,
    messageId,
  );
}

export function recordPayment(db, { method, amount, name, externalId, receivedAt }) {
  if (!method || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('recordPayment: method and positive amount required');
  }
  try {
    db.run(
      `INSERT INTO ledger (kind, method, amount, sender_name, external_id, created_at)
       VALUES ('payment', ?, ?, ?, ?, ?)`,
      method,
      amount,
      name ?? null,
      externalId ?? null,
      (receivedAt instanceof Date ? receivedAt.getTime() : receivedAt) ?? Date.now(),
    );
    return { inserted: true };
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(err.message)) return { inserted: false };
    throw err;
  }
}

export function recordCashout(db, { amount, note }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('recordCashout: positive amount required');
  }
  db.run(
    `INSERT INTO ledger (kind, amount, note, created_at) VALUES ('cashout', ?, ?, ?)`,
    amount,
    note ?? null,
    Date.now(),
  );
}

export function recordAdjustment(db, { method, amount, note }) {
  if (!method) throw new Error('recordAdjustment: method required');
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('recordAdjustment: positive amount required');
  }
  db.run(
    `INSERT INTO ledger (kind, method, amount, note, created_at)
     VALUES ('adjustment', ?, ?, ?, ?)`,
    method,
    amount,
    note ?? null,
    Date.now(),
  );
}

/**
 * Compute totals as net (payments - adjustments - cashouts) per method, plus an overall balance.
 * Optional `since` filter (ms epoch). Method-less rows (cashouts) only affect the overall balance.
 */
export function computeTotals(db, { since } = {}) {
  const cutoff = since ?? 0;
  const rows = db.all(
    `SELECT kind, method, amount FROM ledger WHERE created_at >= ?`,
    cutoff,
  );
  const byMethod = {};
  let cashouts = 0;

  for (const r of rows) {
    if (r.kind === 'cashout') {
      cashouts += r.amount;
      continue;
    }
    const m = r.method ?? 'unknown';
    if (!byMethod[m]) byMethod[m] = 0;
    byMethod[m] += r.kind === 'adjustment' ? -r.amount : r.amount;
  }

  const grossIncome = Object.values(byMethod).reduce((a, b) => a + b, 0);
  return {
    byMethod,
    cashouts,
    balance: grossIncome - cashouts,
    grossIncome,
  };
}

/* ---------------------------------------------- eastern-time helpers ---- */

// All time-bucketing must follow New York wall-clock midnight regardless of
// where the bot is hosted. The previous implementation round-tripped via
// `toLocaleString` + `new Date(...)` which parses in the *server's* timezone —
// silently correct only when the server happened to be in America/New_York,
// and silently wrong everywhere else (e.g. UTC, Pacific). DST is handled by
// querying NY's actual offset at the moment in question rather than by
// stepping 86,400,000 ms (which is wrong on the two transition days).

const NY_TZ = 'America/New_York';
const NY_OFFSET_RE = /GMT([+-])(\d{2}):(\d{2})/;

/** Calendar date as observed in New York at `date`. */
function nyYmdAt(date) {
  // en-CA yields ISO-ish "YYYY-MM-DD" which parses cleanly.
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .split('-')
    .map(Number);
  return { y, m, d };
}

/** New York's UTC offset in ms at the given moment (-4h in EDT, -5h in EST). */
function nyOffsetMs(date) {
  const longOffset = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-04:00"
  const parsed = longOffset.match(NY_OFFSET_RE);
  if (!parsed) return -5 * 60 * 60_000; // EST fallback — should never trigger
  const sign = parsed[1] === '-' ? -1 : 1;
  return sign * (Number(parsed[2]) * 60 + Number(parsed[3])) * 60_000;
}

/** Epoch ms for 00:00 New York on the given NY calendar date. */
function epochForNyMidnight({ y, m, d }) {
  const utcMidnight = Date.UTC(y, m - 1, d);
  // NY offset at *that day's* midnight — handles EDT/EST automatically.
  // DST transitions happen at 02:00 local, so the offset at 00:00 local is
  // unambiguous and matches the offset we want to subtract.
  return utcMidnight - nyOffsetMs(new Date(utcMidnight));
}

/**
 * Epoch ms for the start of (today − daysAgo) in NY, walking by calendar date
 * rather than fixed ms steps. Survives DST transitions cleanly (Mar/Nov).
 */
function startOfNyDay(daysAgo = 0) {
  // Anchor at noon UTC for today's NY date — well clear of any local-midnight
  // DST transition either side — then subtract whole days to land on the
  // correct calendar date in any reasonable timezone.
  const { y, m, d } = nyYmdAt(new Date());
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const target = new Date(noonUtc - daysAgo * 86_400_000);
  return epochForNyMidnight({
    y: target.getUTCFullYear(),
    m: target.getUTCMonth() + 1,
    d: target.getUTCDate(),
  });
}

/** Epoch ms for 00:00 New York today. */
export function startOfTodayEastern() {
  return epochForNyMidnight(nyYmdAt(new Date()));
}

/** Epoch ms for 00:00 New York on the most recent Monday (Monday-anchored week). */
export function startOfWeekEastern() {
  // Day-of-week in NY for "right now". Probe a moment slightly after today's
  // start so the value is unambiguous even at the boundary.
  const todayStart = startOfTodayEastern();
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
  }).format(new Date(todayStart + 60_000));
  const idx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[dow] ?? 0;
  return startOfNyDay(idx);
}

/** Epoch ms for 00:00 New York on the first of the current NY calendar month. */
export function startOfMonthEastern() {
  const { y, m } = nyYmdAt(new Date());
  return epochForNyMidnight({ y, m, d: 1 });
}

/**
 * Daily revenue (kind='payment') for each of the most recent N days, Eastern
 * time. The first row (i=0) is today (00:00 NY → now, in-progress); each
 * subsequent row is a strict 00:00 → 00:00 NY window. Walks calendar dates
 * so DST transitions don't leave a 23/25-hour gap on the two switch days.
 *
 * Returns newest-first:
 *   [{ dayStart, dayEnd, total, byMethod: { zelle, venmo, paypal, crypto } }, ...]
 */
export function dailyRevenueHistory(db, { days = 8 } = {}) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const dayStart = startOfNyDay(i);
    const dayEnd = startOfNyDay(i - 1);
    const rows = db.all(
      `SELECT kind, method, amount FROM ledger
       WHERE kind IN ('payment', 'adjustment') AND created_at >= ? AND created_at < ?`,
      dayStart,
      dayEnd,
    );
    let total = 0;
    const byMethod = {};
    for (const r of rows) {
      const delta = r.kind === 'adjustment' ? -r.amount : r.amount;
      total += delta;
      const m = r.method ?? 'unknown';
      byMethod[m] = (byMethod[m] ?? 0) + delta;
    }
    out.push({ dayStart, dayEnd, total, byMethod });
  }
  return out;
}
