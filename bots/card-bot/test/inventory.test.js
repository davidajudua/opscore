import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCardVault } from '../src/card-vault.js';
import {
  openInventory,
  addProvider,
  editProvider,
  listProviders,
  fireAlert,
  isAlertFired,
  clearAlertsForPrefix,
} from '../src/inventory.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function withDb(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'card-bot-'));
  const vault = createCardVault(randomBytes(32));
  const db = await openInventory({ dbPath: path.join(dir, 'card.db'), migrationsDir: MIGRATIONS, vault });
  try {
    await fn(db, vault);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('editProvider rename preserves the display name (does not overwrite it with the new id)', () =>
  withDb((db) => {
    addProvider(db, { id: 'visa', name: 'Visa Classic', zip: '10001', expDate: '12/28' });
    const r = editProvider(db, { id: 'visa', newId: 'visa2' });
    assert.equal(r.renamed, true);
    const p = listProviders(db).find((x) => x.id === 'visa2');
    assert.ok(p, 'provider should now have the new id');
    assert.equal(p.name, 'Visa Classic', 'display name must be preserved, not replaced by the id');
  }));

test('clearAlertsForPrefix treats _ and % literally (no LIKE-wildcard over-deletion)', () =>
  withDb((db) => {
    fireAlert(db, 'card:a_b:lowstock'); // the provider we mean to clear
    fireAlert(db, 'card:axb:lowstock'); // a DIFFERENT provider that '_' would wrongly match
    clearAlertsForPrefix(db, 'card:a_b');
    assert.equal(isAlertFired(db, 'card:a_b:lowstock'), false, 'target prefix cleared');
    assert.equal(isAlertFired(db, 'card:axb:lowstock'), true, 'unrelated provider must NOT be cleared by a literal _');
  }));
