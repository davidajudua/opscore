import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  recordPayment,
  recordAdjustment,
  recordCashout,
  computeTotals,
  purgeAll,
} from '../src/ledger.js';

// Minimal stand-in for bot-core's db wrapper (run/get/all/transaction over node:sqlite),
// with the real ledger schema incl. the PARTIAL unique index on (method, external_id).
function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, method TEXT,
      amount REAL NOT NULL, sender_name TEXT, note TEXT, external_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX ledger_method_external_idx ON ledger(method, external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE imap_cursor (provider TEXT PRIMARY KEY, last_uid INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE dashboard_pointer (channel_id TEXT, message_id TEXT PRIMARY KEY, posted_at INTEGER, current_page INTEGER);
  `);
  return {
    run: (sql, ...p) => d.prepare(sql).run(...p),
    get: (sql, ...p) => d.prepare(sql).get(...p),
    all: (sql, ...p) => d.prepare(sql).all(...p),
    transaction: (fn) => (...args) => {
      d.exec('BEGIN');
      try {
        const r = fn(...args);
        d.exec('COMMIT');
        return r;
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

test('computeTotals reports TRUE gross (before adjustments), with net + balance preserved', () => {
  const db = makeDb();
  recordPayment(db, { method: 'zelle', amount: 100, name: 'A', externalId: 'z1' });
  recordPayment(db, { method: 'venmo', amount: 50, name: 'B', externalId: 'v1' });
  recordAdjustment(db, { method: 'zelle', amount: 30, note: 'chargeback' });
  recordCashout(db, { amount: 20, note: 'atm' });

  const t = computeTotals(db, {});
  // grossIncome must be the true gross of payments (NOT net of adjustments)
  assert.equal(t.grossIncome, 150, 'grossIncome should be payments only (100 + 50)');
  assert.equal(t.adjustments, 30, 'adjustments should be reported separately');
  // byMethod stays net-per-method for display (zelle 100-30=70, venmo 50)
  assert.equal(t.byMethod.zelle, 70);
  assert.equal(t.byMethod.venmo, 50);
  // balance unchanged: gross - adjustments - cashouts = 150 - 30 - 20 = 100
  assert.equal(t.balance, 100, 'balance = gross - adjustments - cashouts');
});

test('purgeAll returns the deleted counts and empties the tables', () => {
  const db = makeDb();
  recordPayment(db, { method: 'zelle', amount: 10, externalId: 'a' });
  recordPayment(db, { method: 'venmo', amount: 20, externalId: 'b' });
  const counts = purgeAll(db);
  assert.equal(counts.ledger, 2, 'reports the number of ledger rows deleted');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ledger').n, 0, 'ledger emptied');
});
