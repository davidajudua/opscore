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
  loadCards,
  claimCard,
  cardCount,
  openCardSession,
  getCardSession,
  returnCardToPool,
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

test('renaming a provider moves its stock and open claims, and Return still works', () =>
  withDb((db, vault) => {
    addProvider(db, { id: 'amex', name: 'Amex' });
    const card = { card_number: '378282246310005', mm: '09', yy: '2031', cvv: '7351' };
    loadCards(db, vault, 'amex', [card, { ...card, card_number: '371449635398431' }]);
    const claimed = claimCard(db, vault);
    openCardSession(db, { messageId: 'm1', userId: 'u1', providerId: 'amex', sealed: claimed.sealed });

    editProvider(db, { id: 'amex', newId: 'amexblue' });

    assert.equal(cardCount(db, 'amexblue'), 1);
    returnCardToPool(db, getCardSession(db, 'm1'));
    assert.equal(cardCount(db, 'amexblue'), 2, 'the returned card lands in the renamed provider');
    assert.deepEqual(claimCard(db, vault).card, { ...card, zip: null });
  }));

test('clearAlertsForPrefix treats _ and % literally (no LIKE-wildcard over-deletion)', () =>
  withDb((db) => {
    fireAlert(db, 'card:a_b:lowstock'); // the provider we mean to clear
    fireAlert(db, 'card:axb:lowstock'); // a DIFFERENT provider that '_' would wrongly match
    clearAlertsForPrefix(db, 'card:a_b');
    assert.equal(isAlertFired(db, 'card:a_b:lowstock'), false, 'target prefix cleared');
    assert.equal(isAlertFired(db, 'card:axb:lowstock'), true, 'unrelated provider must NOT be cleared by a literal _');
  }));

test('Return allocates a global head id without touching another provider', () =>
  withDb((db, vault) => {
    addProvider(db, { id: 'a', name: 'A' });
    addProvider(db, { id: 'b', name: 'B' });
    const card = { card_number: '378282246310005', mm: '09', yy: '2031', cvv: '7351' };
    loadCards(db, vault, 'a', [card]);
    loadCards(db, vault, 'b', [{ ...card, card_number: '371449635398431' }]);
    const original = db.get(`SELECT * FROM cards WHERE provider_id = 'a'`);
    db.run(`UPDATE providers SET is_active = CASE WHEN id = 'b' THEN 1 ELSE 0 END`);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('card_mode', 'single')`);
    const claimed = claimCard(db, vault);
    assert.equal(claimed.provider.id, 'b');
    openCardSession(db, { messageId: 'm1', userId: 'u1', providerId: 'b', sealed: claimed.sealed });
    assert.equal(returnCardToPool(db, getCardSession(db, 'm1')), 'restocked');
    assert.deepEqual(db.get(`SELECT * FROM cards WHERE provider_id = 'a'`), original);
    assert.equal(cardCount(db, 'b'), 1);
    assert.deepEqual(claimCard(db, vault).card, claimed.card);
  }));

test('Return reconciles a reloaded card and duplicate returns do nothing', () =>
  withDb((db, vault) => {
    addProvider(db, { id: 'amex', name: 'Amex' });
    const card = { card_number: '378282246310005', mm: '09', yy: '2031', cvv: '7351' };
    loadCards(db, vault, 'amex', [card]);
    const claimed = claimCard(db, vault);
    openCardSession(db, { messageId: 'm1', userId: 'u1', providerId: 'amex', sealed: claimed.sealed });
    const session = getCardSession(db, 'm1');
    loadCards(db, vault, 'amex', [card]);
    assert.equal(returnCardToPool(db, session), 'already-in-stock');
    assert.equal(getCardSession(db, 'm1'), undefined);
    assert.equal(cardCount(db, 'amex'), 1);
    assert.equal(returnCardToPool(db, session), 'no-session');
    assert.equal(cardCount(db, 'amex'), 1);
  }));
