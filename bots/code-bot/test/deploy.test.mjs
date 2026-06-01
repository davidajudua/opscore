import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshDeployMessage } from '../src/deploy.js';

// Minimal fake db that backs a single deploy_message row for one provider.
function makeDb(initial) {
  let rec = initial ? { ...initial } : null;
  return {
    cleared: false,
    get(sql, provider) {
      if (/FROM deploy_message/.test(sql)) return rec;
      return undefined;
    },
    all() {
      return rec ? [rec] : [];
    },
    run(sql) {
      if (/DELETE FROM deploy_message/.test(sql)) {
        rec = null;
        this.cleared = true;
      }
    },
  };
}

const baseRec = {
  provider: 'amex',
  channel_id: 'chan',
  message_id: 'msg',
  updated_at: 0,
};

function makeClient({ throwErr } = {}) {
  return {
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          messages: {
            async fetch() {
              if (throwErr) throw throwErr;
              return { async edit() {} };
            },
          },
        };
      },
    },
  };
}

const bot = { customId: (...a) => a.join(':') };
const queue = { list: () => [] };

test('refreshDeployMessage clears the record on a 10008 Unknown Message error', async () => {
  const db = makeDb(baseRec);
  const err = new Error('Unknown Message');
  err.code = 10008;
  await refreshDeployMessage({
    client: makeClient({ throwErr: err }),
    db,
    bot,
    queue,
    provider: 'amex',
  });
  assert.equal(db.cleared, true, 'record should be cleared on a true Unknown Message');
});

test('refreshDeployMessage does NOT clear the record on a transient error (rate limit)', async () => {
  const db = makeDb(baseRec);
  const err = new Error('rate limited');
  err.code = 429;
  await refreshDeployMessage({
    client: makeClient({ throwErr: err }),
    db,
    bot,
    queue,
    provider: 'amex',
  });
  assert.equal(db.cleared, false, 'transient errors must not wipe the dashboard pointer');
});

test('refreshDeployMessage does NOT clear on a network error with no code', async () => {
  const db = makeDb(baseRec);
  const err = new Error('ECONNRESET');
  await refreshDeployMessage({
    client: makeClient({ throwErr: err }),
    db,
    bot,
    queue,
    provider: 'amex',
  });
  assert.equal(db.cleared, false, 'unknown errors must not wipe the dashboard pointer');
});
