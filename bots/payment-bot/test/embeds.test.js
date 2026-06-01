import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardPayload,
  historyPayload,
  refundPendingEmbed,
} from '../src/embeds.js';

// Minimal bot stub: customId just joins parts so payload builders work.
const bot = { customId: (...parts) => parts.join(':') };

function period({ byMethod = {}, cashouts = 0, balance } = {}) {
  return { byMethod, cashouts, balance };
}

test('dashboardPayload does not throw when a period balance is undefined', () => {
  // "today" with no transactions: aggregation returns no balance row.
  const payload = dashboardPayload({
    today: period({ balance: undefined }),
    week: period({ balance: 100 }),
    month: period({ balance: 200 }),
    allTime: period({ balance: 300 }),
    locked: false,
    bot,
  });
  assert.ok(payload.components);
  // Missing balance should render as $0.00, not crash.
  const text = JSON.stringify(payload);
  assert.match(text, /\$0\.00/);
});

test('historyPayload does not throw on an empty days array', () => {
  const payload = historyPayload({ days: [], index: 0, bot });
  assert.ok(payload.components);
});

// Eastern calendar date string (YYYY-MM-DD) for a given Date.
function easternDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

test('historyPayload labels the newest entry "Today" only when its day is actually today', () => {
  // Newest entry is a *completed* day = yesterday's Eastern window.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const days = [
    { dayStart: yesterday.getTime(), dayEnd: now.getTime(), total: 10, byMethod: {} },
  ];
  const payload = historyPayload({ days, index: 0, bot });
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('Today'), 'yesterday should not be labelled "Today"');
});

test('historyPayload labels the newest entry "Today" when its day is the current Eastern day', () => {
  const now = new Date();
  const days = [
    { dayStart: now.getTime(), dayEnd: now.getTime(), total: 10, byMethod: {} },
  ];
  const payload = historyPayload({ days, index: 0, bot });
  const text = JSON.stringify(payload);
  // Only meaningful guard: heading should contain Today for the current day.
  assert.ok(text.includes('Today'), 'current Eastern day should be labelled "Today"');
  // sanity: easternDateStr is used to keep the helper referenced
  assert.equal(typeof easternDateStr(now), 'string');
});

test('refundPendingEmbed does not throw on an unrecognised method', () => {
  // Stale/typo method key: must degrade gracefully, not crash.
  const embed = refundPendingEmbed({
    user: { username: 'tester', displayAvatarURL: () => 'http://x/avatar.png' },
    method: 'mystery',
    values: { amount: '50', reason: 'because', ticketLink: '' },
    screenshotUrl: null,
  });
  assert.ok(embed);
});
