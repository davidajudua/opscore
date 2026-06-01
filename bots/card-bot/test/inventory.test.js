import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  addProvider,
  editProvider,
  listProviders,
  fireAlert,
  isAlertFired,
  clearAlertsForPrefix,
} from '../src/inventory.js';

function makeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, zip TEXT, exp_date TEXT, is_active INTEGER DEFAULT 0, created_at INTEGER);
    CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT, card_number TEXT, mm TEXT, yy TEXT, cvv TEXT, zip TEXT);
    CREATE TABLE stock_alerts (alert_key TEXT PRIMARY KEY, fired_at INTEGER);
  `);
  return {
    run: (sql, ...p) => d.prepare(sql).run(...p),
    get: (sql, ...p) => d.prepare(sql).get(...p),
    all: (sql, ...p) => d.prepare(sql).all(...p),
    transaction: (fn) => (...a) => { d.exec('BEGIN'); try { const r = fn(...a); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } },
  };
}

test('editProvider rename preserves the display name (does not overwrite it with the new id)', () => {
  const db = makeDb();
  addProvider(db, { id: 'visa', name: 'Visa Classic', zip: '10001', expDate: '12/28' });
  const r = editProvider(db, { id: 'visa', newId: 'visa2' });
  assert.equal(r.renamed, true);
  const p = listProviders(db).find((x) => x.id === 'visa2');
  assert.ok(p, 'provider should now have the new id');
  assert.equal(p.name, 'Visa Classic', 'display name must be preserved, not replaced by the id');
});

test('clearAlertsForPrefix treats _ and % literally (no LIKE-wildcard over-deletion)', () => {
  const db = makeDb();
  fireAlert(db, 'card:a_b:lowstock'); // the provider we mean to clear
  fireAlert(db, 'card:axb:lowstock'); // a DIFFERENT provider that '_' would wrongly match
  clearAlertsForPrefix(db, 'card:a_b');
  assert.equal(isAlertFired(db, 'card:a_b:lowstock'), false, 'target prefix cleared');
  assert.equal(isAlertFired(db, 'card:axb:lowstock'), true, 'unrelated provider must NOT be cleared by a literal _');
});
