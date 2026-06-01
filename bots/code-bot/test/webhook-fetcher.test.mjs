import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookSafekeyFetcher } from '../src/webhook-fetcher.js';

// In-memory stand-ins for the served_* tables and Discord channel.
function makeDb() {
  const webhook = new Set();
  const values = new Set();
  return {
    run(sql, a) {
      if (/INSERT OR IGNORE INTO served_webhook_codes/.test(sql)) {
        if (webhook.has(a)) return { changes: 0 };
        webhook.add(a);
        return { changes: 1 };
      }
      if (/INSERT OR IGNORE INTO served_code_values/.test(sql)) {
        if (values.has(a)) return { changes: 0 };
        values.add(a);
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    get(sql, a) {
      if (/served_webhook_codes/.test(sql)) return webhook.has(a) ? 1 : undefined;
      return undefined;
    },
  };
}

function makeBot(messages) {
  const collection = new Map(messages.map((m) => [m.id, m]));
  return {
    client: {
      channels: {
        cache: { get: () => null },
        async fetch() {
          return {
            messages: {
              async fetch() {
                return collection;
              },
            },
          };
        },
      },
    },
  };
}

const env = {
  WEBHOOK_CODE_CHANNEL_ID: 'chan',
  WEBHOOK_CODE_AUTHOR_ID: 'author',
};

test('webhook fetcher finds a code received 60s before the click (5-min window)', async () => {
  const clickTime = Date.now();
  const msg = {
    id: 'm1',
    author: { id: 'author' },
    createdTimestamp: clickTime - 60_000, // 60s before click — beyond a 30s window
    content: '194084 is your Amex SafeKey Verification Code. Never share this code.',
  };
  const fetcher = new WebhookSafekeyFetcher({ env, db: makeDb(), bot: makeBot([msg]), logger: null });
  const hit = await fetcher.fetchOnce({ clickTime });
  assert.ok(hit, 'a code received 60s before the click should still be found');
  assert.equal(hit.code, '194084');
});

test('webhook fetcher ignores messages older than the 5-min window', async () => {
  const clickTime = Date.now();
  const msg = {
    id: 'm2',
    author: { id: 'author' },
    createdTimestamp: clickTime - 10 * 60_000, // 10 min before click — too old
    content: '194084 is your Amex SafeKey Verification Code.',
  };
  const fetcher = new WebhookSafekeyFetcher({ env, db: makeDb(), bot: makeBot([msg]), logger: null });
  const hit = await fetcher.fetchOnce({ clickTime });
  assert.equal(hit, null, 'a 10-min-old message is outside the window');
});
