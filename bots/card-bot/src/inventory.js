/**
 * Card / provider / whitelist persistence helpers.
 *
 * The cards table is "consume on claim" — claimed cards are deleted so the same card
 * is never handed out twice across restarts.
 */

/**
 * Wipe every table. Used by /purge for "starting over" (e.g. switching the bot to a
 * new pool). Returns the counts of rows that were deleted.
 */
export function purgeAll(db) {
  // Count and delete in one transaction so the returned counts match exactly what
  // was deleted, even under a concurrent write.
  const txn = db.transaction(() => {
    const counts = {
      cards: db.get(`SELECT COUNT(*) AS n FROM cards`).n,
      stock_alerts: db.get(`SELECT COUNT(*) AS n FROM stock_alerts`).n,
      providers: db.get(`SELECT COUNT(*) AS n FROM providers`).n,
      whitelist: db.get(`SELECT COUNT(*) AS n FROM whitelist`).n,
      card_sessions: db.get(`SELECT COUNT(*) AS n FROM card_sessions`).n,
      stock_pointer: db.get(`SELECT COUNT(*) AS n FROM stock_pointer`).n,
    };
    db.run(`DELETE FROM cards`);
    db.run(`DELETE FROM providers`);
    db.run(`DELETE FROM whitelist`);
    db.run(`DELETE FROM card_sessions`);
    db.run(`DELETE FROM stock_alerts`);
    db.run(`DELETE FROM claim_history`);
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM stock_pointer`);
    return counts;
  });
  return txn();
}

/* ---------------------------------------------- low-stock alert state */

export const LOW_STOCK_THRESHOLD = 10;

export function isAlertFired(db, key) {
  return Boolean(db.get(`SELECT 1 FROM stock_alerts WHERE alert_key = ?`, key));
}

export function fireAlert(db, key) {
  db.run(
    `INSERT INTO stock_alerts (alert_key, fired_at) VALUES (?, ?)
     ON CONFLICT(alert_key) DO UPDATE SET fired_at = excluded.fired_at`,
    key,
    Date.now(),
  );
}

export function clearAlert(db, key) {
  db.run(`DELETE FROM stock_alerts WHERE alert_key = ?`, key);
}

export function clearAlertsForPrefix(db, prefix) {
  // Escape LIKE wildcards in the (caller-supplied) prefix so a provider id containing
  // '_' or '%' doesn't match unrelated alert keys. '\' is the escape char below.
  const escaped = String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`);
  db.run(`DELETE FROM stock_alerts WHERE alert_key LIKE ? ESCAPE '\\'`, `${escaped}:%`);
}

export function cardCount(db, providerId) {
  return db.get(`SELECT COUNT(*) AS n FROM cards WHERE provider_id = ?`, providerId).n;
}

/* ---------------------------------------------- exports (for /export) */

/**
 * Dump every card in a provider to the same line format /load expects:
 *   number,mm,yy,cvv[,zip]
 * Returns a single string with one line per card.
 */
export function exportCardsForProvider(db, providerId) {
  const rows = db.all(
    `SELECT card_number, mm, yy, cvv, zip FROM cards WHERE provider_id = ? ORDER BY id`,
    providerId,
  );
  return rows
    .map((c) => {
      const base = [c.card_number, c.mm, c.yy, c.cvv];
      if (c.zip) base.push(c.zip);
      return base.join(',');
    })
    .join('\n');
}

/* ---------------------------------------------- providers */

export function addProvider(db, { id, name, zip, expDate }) {
  db.run(
    `INSERT INTO providers (id, name, zip, exp_date, is_active, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    name,
    zip ?? null,
    expDate ?? null,
    Date.now(),
  );
}

/**
 * Update mutable fields on a provider. Pass `newId` to rename — that updates
 * providers.id (the primary key) AND every cards.provider_id row pointing at
 * the old id, in a single transaction so the join never breaks. Renaming is a
 * no-op when newId equals the current id.
 *
 * Returns { changed: bool, renamed: bool }.
 */
export function editProvider(db, { id, newId, zip, expDate }) {
  const txn = db.transaction(() => {
    let renamed = false;
    if (newId && newId !== id) {
      // Re-point the FK first, then move the providers row. Doing it in this
      // order avoids momentarily orphaning cards rows.
      db.run(`UPDATE cards SET provider_id = ? WHERE provider_id = ?`, newId, id);
      // Rename changes only the id (primary key). The human-readable name must be
      // preserved — binding newId to `name` here would overwrite it with the id.
      db.run(`UPDATE providers SET id = ? WHERE id = ?`, newId, id);
      renamed = true;
    }

    const targetId = renamed ? newId : id;
    const sets = [];
    const params = [];
    if (zip !== undefined) {
      sets.push('zip = ?');
      params.push(zip || null);
    }
    if (expDate !== undefined) {
      sets.push('exp_date = ?');
      params.push(expDate || null);
    }
    if (sets.length > 0) {
      params.push(targetId);
      db.run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }

    return { changed: renamed || sets.length > 0, renamed };
  });
  return txn();
}

export function listProviders(db) {
  return db.all(`SELECT * FROM providers ORDER BY created_at`);
}

/**
 * Remove a provider and all its cards. Returns the row count of removed cards
 * so the caller can report what was wiped.
 */
export function deleteProvider(db, providerId) {
  const txn = db.transaction(() => {
    const cardsDeleted = db.get(
      `SELECT COUNT(*) AS n FROM cards WHERE provider_id = ?`,
      providerId,
    ).n;
    db.run(`DELETE FROM cards WHERE provider_id = ?`, providerId);
    db.run(`DELETE FROM providers WHERE id = ?`, providerId);
    // Clean orphaned alert keys inside the txn so a rollback can't leave alert
    // state cleared while the provider/cards still exist.
    clearAlertsForPrefix(db, `card:${providerId}`);
    return { cardsDeleted };
  });
  return txn();
}

/**
 * Wipe just the cards for a provider, keeping the provider itself.
 * Returns the count of cards removed.
 */
export function eraseProviderCards(db, providerId) {
  // Stock zeroed → re-arm so a /load → drain fires alerts again.
  clearAlertsForPrefix(db, `card:${providerId}`);
  const before = db.get(
    `SELECT COUNT(*) AS n FROM cards WHERE provider_id = ?`,
    providerId,
  ).n;
  db.run(`DELETE FROM cards WHERE provider_id = ?`, providerId);
  return before;
}

/**
 * Card-selection mode determines how /card picks a provider:
 *   'all'    — no provider pinned, /card iterates all providers in insertion order
 *   'single' — one provider has is_active=1, /card draws from it (falls through if empty)
 *   'mix'    — providers with in_mix=1 form the eligible pool, /card iterates them
 *
 * Mode is stored in settings.card_mode so it survives restarts and is independent
 * of accidental is_active / in_mix drift. Helpers below keep all three pieces
 * (mode + is_active + in_mix) in sync — never poke them directly.
 */
export function getCardMode(db) {
  const row = db.get(`SELECT value FROM settings WHERE key = 'card_mode'`);
  return row?.value ?? 'all';
}

function writeCardMode(db, mode) {
  db.run(
    `INSERT INTO settings (key, value) VALUES ('card_mode', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    mode,
  );
}

/**
 * Pin a single provider. Side-effects: sets is_active=1 only on this one,
 * clears every in_mix flag, and writes card_mode='single'. Pass null to
 * fall back to 'all' mode (clears everything).
 */
export function setActiveProvider(db, providerId) {
  const txn = db.transaction(() => {
    db.run(`UPDATE providers SET is_active = 0, in_mix = 0`);
    if (providerId) {
      db.run(`UPDATE providers SET is_active = 1 WHERE id = ?`, providerId);
      writeCardMode(db, 'single');
    } else {
      writeCardMode(db, 'all');
    }
  });
  txn();
}

/**
 * Switch into Mix mode. Clears is_active everywhere but preserves whatever
 * in_mix flags were already set (so re-entering Mix mode doesn't wipe the
 * previous selection). Sets card_mode='mix'.
 */
export function setMixMode(db) {
  const txn = db.transaction(() => {
    db.run(`UPDATE providers SET is_active = 0`);
    writeCardMode(db, 'mix');
  });
  txn();
}

// Round-robin pointer for Mix mode — remembers which provider served the last
// card so claimCard can pick the NEXT one. Persisted in the settings k/v table
// so the rotation survives bot restarts. Returns null if no claim yet.
export function getLastMixProvider(db) {
  const row = db.get(`SELECT value FROM settings WHERE key = 'last_mix_provider'`);
  return row?.value ?? null;
}

export function setLastMixProvider(db, providerId) {
  db.run(
    `INSERT INTO settings (key, value) VALUES ('last_mix_provider', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    providerId,
  );
}

/**
 * Toggle a provider's in_mix flag. Only meaningful in Mix mode.
 * Returns the new boolean state.
 */
export function toggleProviderInMix(db, providerId) {
  const row = db.get(`SELECT in_mix FROM providers WHERE id = ?`, providerId);
  if (!row) return false;
  const next = row.in_mix ? 0 : 1;
  db.run(`UPDATE providers SET in_mix = ? WHERE id = ?`, next, providerId);
  return next === 1;
}

export function getMixProviderIds(db) {
  return db
    .all(`SELECT id FROM providers WHERE in_mix = 1 ORDER BY created_at`)
    .map((r) => r.id);
}

/**
 * Append a batch of cards to a provider. Returns { inserted, skipped }.
 * `parsed` is an array of { card_number, mm, yy, cvv, zip? }.
 * `mode` is 'append' (default) or 'replace' (clears existing cards for that provider).
 */
export function loadCards(db, providerId, parsed, { mode = 'append' } = {}) {
  // Loading more cards re-arms low-stock alerts for this provider.
  clearAlertsForPrefix(db, `card:${providerId}`);
  const txn = db.transaction(() => {
    if (mode === 'replace') db.run(`DELETE FROM cards WHERE provider_id = ?`, providerId);
    let inserted = 0;
    let skipped = 0;
    for (const c of parsed) {
      // INSERT OR IGNORE — UNIQUE(provider_id, card_number) silently dedups.
      const result = db.run(
        `INSERT OR IGNORE INTO cards (provider_id, card_number, mm, yy, cvv, zip, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        providerId,
        c.card_number,
        c.mm,
        c.yy,
        c.cvv,
        c.zip ?? null,
        Date.now(),
      );
      if (result.changes === 1) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  });
  return txn();
}

/**
 * Claim the next available card. Selection respects the current card_mode:
 *   'single' — try the pinned provider first, then fall through to the rest
 *              (so a Single-mode user still gets a card if their pinned provider
 *              is empty).
 *   'mix'    — round-robin across providers with in_mix=1. Each claim picks the
 *              NEXT provider after the last served one; if that provider is empty,
 *              falls through to the others (so a single-empty provider doesn't
 *              stall the queue). If the mix is empty we fall back to the full list.
 *   'all'    — iterate every provider in insertion order.
 * Returns the claimed card row + provider, or null if all stocks are empty.
 */
export function claimCard(db) {
  const txn = db.transaction(() => {
    const mode = getCardMode(db);
    const providers = listProviders(db);

    let order;
    if (mode === 'mix') {
      const mix = providers.filter((p) => p.in_mix);
      if (mix.length === 0) {
        order = providers;
      } else {
        // Rotate the mix so the provider AFTER the last served one comes first.
        const lastId = getLastMixProvider(db);
        const lastIdx = lastId ? mix.findIndex((p) => p.id === lastId) : -1;
        const startIdx = lastIdx === -1 ? 0 : (lastIdx + 1) % mix.length;
        order = [...mix.slice(startIdx), ...mix.slice(0, startIdx)];
      }
    } else if (mode === 'single') {
      order = [...providers.filter((p) => p.is_active), ...providers.filter((p) => !p.is_active)];
    } else {
      order = providers;
    }

    for (const p of order) {
      const card = db.get(
        `SELECT * FROM cards WHERE provider_id = ? ORDER BY id LIMIT 1`,
        p.id,
      );
      if (card) {
        db.run(`DELETE FROM cards WHERE id = ?`, card.id);
        if (mode === 'mix') setLastMixProvider(db, p.id);
        return { card, provider: p };
      }
    }
    return null;
  });
  return txn();
}

/* ---------------------------------------------- card sessions ----- */

/**
 * Record a session for an in-flight card claim. Keyed by the Discord message id of the
 * `/card` reply so the Used / Error / Return buttons can look up the session by message.
 */
export function openCardSession(db, { messageId, userId, providerId, card }) {
  const now = Date.now();
  db.run(
    `INSERT INTO card_sessions
       (message_id, user_id, provider_id, card_number, mm, yy, cvv, zip, claimed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    messageId,
    userId,
    providerId,
    card.card_number,
    card.mm,
    card.yy,
    card.cvv,
    card.zip ?? null,
    now,
  );
  db.run(
    `INSERT INTO claim_history (kind, user_id, provider, claimed_at) VALUES (?, ?, ?, ?)`,
    'card', userId, providerId, now,
  );
}

export function getCardSession(db, messageId) {
  return db.get(`SELECT * FROM card_sessions WHERE message_id = ?`, messageId);
}

export function closeCardSession(db, messageId) {
  db.run(`DELETE FROM card_sessions WHERE message_id = ?`, messageId);
}

/**
 * Delete card_sessions older than maxAgeMs. Returns the number of rows removed.
 * Users often claim a card, use it, and forget to click Used/Return, leaving the
 * session row around. This reaper keeps the table from growing indefinitely.
 * Cards are NOT returned to the pool (the overwhelming majority of stale sessions
 * = card was used, just not clicked).
 */
export function expireOldSessions(db, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.run(`DELETE FROM card_sessions WHERE claimed_at < ?`, cutoff);
  return result.changes;
}

/* ---------------------------------------------- stock pointer ----- */

/**
 * Save (or update) the deployed /stock message for a given channel. One row
 * per channel — re-running /stock in the same channel overwrites the pointer.
 */
export function saveStockPointer(db, { channelId, messageId }) {
  db.run(
    `INSERT INTO stock_pointer (channel_id, message_id, deployed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       message_id  = excluded.message_id,
       deployed_at = excluded.deployed_at`,
    channelId,
    messageId,
    Date.now(),
  );
}

export function listStockPointers(db) {
  return db.all(`SELECT channel_id, message_id, deployed_at FROM stock_pointer`);
}

export function removeStockPointer(db, messageId) {
  db.run(`DELETE FROM stock_pointer WHERE message_id = ?`, messageId);
}

/**
 * Put a card session's card data back into the active card pool. Used by the Return button.
 * Inserts at the head of the provider's stock so the next /card claim picks it up first.
 */
export function returnCardToPool(db, session) {
  // Returning a card to the pool re-arms low-stock alerts for that provider.
  clearAlertsForPrefix(db, `card:${session.provider_id}`);
  // To put it FIRST, take the current minimum id and use min - 1 (allowed in SQLite).
  const txn = db.transaction(() => {
    const minRow = db.get(
      `SELECT MIN(id) AS min_id FROM cards WHERE provider_id = ?`,
      session.provider_id,
    );
    const newId = minRow?.min_id != null ? minRow.min_id - 1 : 1;
    db.run(
      `INSERT INTO cards (id, provider_id, card_number, mm, yy, cvv, zip, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      session.provider_id,
      session.card_number,
      session.mm,
      session.yy,
      session.cvv,
      session.zip ?? null,
      Date.now(),
    );
    db.run(`DELETE FROM card_sessions WHERE message_id = ?`, session.message_id);
  });
  txn();
}

export function cardCounts(db) {
  return db.all(
    `SELECT p.id, p.name, p.is_active, p.in_mix, p.zip, COUNT(c.id) AS count
     FROM providers p
     LEFT JOIN cards c ON c.provider_id = p.id
     GROUP BY p.id ORDER BY p.created_at`,
  );
}

/* --------------------------------------------------------------- whitelist */

export function isChannelWhitelisted(db, channelId, feature) {
  return Boolean(
    db.get(`SELECT 1 FROM whitelist WHERE channel_id = ? AND feature = ?`, channelId, feature),
  );
}

export function setWhitelist(db, channelId, feature, enabled) {
  if (enabled) {
    db.run(
      `INSERT INTO whitelist (channel_id, feature, added_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id, feature) DO NOTHING`,
      channelId,
      feature,
      Date.now(),
    );
  } else {
    db.run(
      `DELETE FROM whitelist WHERE channel_id = ? AND feature = ?`,
      channelId,
      feature,
    );
  }
}

export function listWhitelist(db, channelId) {
  return db
    .all(`SELECT feature FROM whitelist WHERE channel_id = ?`, channelId)
    .map((r) => r.feature);
}

/* ---------------------------------------------------------- file parsers */

/**
 * Parse a card file. Accepts comma- or slash-separated values, with 4 fields
 * (number,mm,yy,cvv) or 5 fields (number,mm,yy,cvv,zip). Skips header rows
 * (first field non-numeric) and blank lines.
 */
export function parseCardFile(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[,/]/).map((s) => s.trim());
    if (parts.length < 4) continue;
    if (!/^\d+$/.test(parts[0])) continue; // header
    const [card_number, mm, yy, cvv, zip] = parts;
    out.push({ card_number, mm, yy, cvv, zip: zip || undefined });
  }
  return out;
}

/* ----------------------------------------------- prices + daily stats */

export const PRICE_KINDS = ['card'];

export function getPrices(db) {
  const out = { card: 0 };
  const rows = db.all(`SELECT key, value FROM settings WHERE key LIKE 'price_%_cents'`);
  for (const r of rows) {
    const m = r.key.match(/^price_(card)_cents$/);
    if (m) out[m[1]] = Number(r.value) || 0;
  }
  return out;
}

export function setPrice(db, kind, cents) {
  if (!PRICE_KINDS.includes(kind)) throw new Error(`unknown price kind: ${kind}`);
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    `price_${kind}_cents`,
    String(cents),
  );
}

export function getDailyWorkerStats(db, sinceMs) {
  const cardRows = db.all(
    `SELECT user_id, COUNT(*) AS n FROM claim_history
     WHERE kind = 'card' AND claimed_at >= ? GROUP BY user_id`,
    sinceMs,
  );
  const byUser = new Map();
  const slot = (id) => {
    if (!byUser.has(id)) byUser.set(id, { userId: id, cards: 0 });
    return byUser.get(id);
  };
  for (const r of cardRows) slot(r.user_id).cards = r.n;
  return Array.from(byUser.values());
}

export function getStatsClearAt(db) {
  const row = db.get(`SELECT value FROM settings WHERE key = 'stats_clear_at'`);
  return row?.value ? Number(row.value) : 0;
}

export function setStatsClearAt(db, ms) {
  db.run(
    `INSERT INTO settings (key, value) VALUES ('stats_clear_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(ms),
  );
}

export function purgeClaimHistory(db) {
  db.run(`DELETE FROM claim_history`);
}

export function purgeStockAlerts(db) {
  db.run(`DELETE FROM stock_alerts`);
}

/**
 * Drop card_sessions rows older than 24h — abandoned claims where the user never
 * clicked Used/Error/Return. Safe at midnight since no legit claim sits open that long.
 */
export function purgeOrphanSessions(db) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM card_sessions WHERE claimed_at < ?`, cutoff);
}

/* --------------------------------------------------------- timezone helpers */

const NY_TZ = 'America/New_York';
const NY_OFFSET_RE = /GMT([+-])(\d{2}):(\d{2})/;

function nyYmdAt(date) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).split('-').map(Number);
  return { y, m, d };
}

function nyOffsetMs(date) {
  const longOffset = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, timeZoneName: 'longOffset',
  }).formatToParts(date).find((p) => p.type === 'timeZoneName').value;
  const parsed = longOffset.match(NY_OFFSET_RE);
  if (!parsed) return -5 * 60 * 60_000;
  const sign = parsed[1] === '-' ? -1 : 1;
  return sign * (Number(parsed[2]) * 60 + Number(parsed[3])) * 60_000;
}

function epochForNyMidnight({ y, m, d }) {
  const utcMidnight = Date.UTC(y, m - 1, d);
  return utcMidnight - nyOffsetMs(new Date(utcMidnight));
}

export function startOfTodayEastern() {
  return epochForNyMidnight(nyYmdAt(new Date()));
}

export function startOfWeekEastern() {
  const todayStart = startOfTodayEastern();
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, weekday: 'short',
  }).format(new Date(todayStart + 60_000));
  const idx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[dow] ?? 0;
  const { y, m, d } = nyYmdAt(new Date());
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const target = new Date(noonUtc - idx * 86_400_000);
  return epochForNyMidnight({
    y: target.getUTCFullYear(),
    m: target.getUTCMonth() + 1,
    d: target.getUTCDate(),
  });
}
