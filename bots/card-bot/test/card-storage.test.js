import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '@platform/bot-core/db';
import { createCardVault } from '../src/card-vault.js';
import {
  addProvider,
  claimCard,
  exportCardsForProvider,
  loadCards,
  openCardSession,
  openInventory,
  parseCardFile,
  returnCardToPool,
} from '../src/inventory.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Published test numbers. Four-digit CVVs keep a chance match against random
// ciphertext bytes far too unlikely to make the byte search flaky.
const CARDS = [
  { card_number: '378282246310005', mm: '09', yy: '2031', cvv: '7351', zip: '90210' },
  { card_number: '371449635398431', mm: '10', yy: '2032', cvv: '8462' },
  { card_number: '4111111111111111', mm: '11', yy: '2033', cvv: '9573', zip: '10001' },
];

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'card-bot-'));
}

/** Every file SQLite keeps for this database: the main file, its WAL and shm. */
function rawBytes(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f));
}

function plaintextFound(dbPath, cards) {
  const files = rawBytes(dbPath);
  return cards
    .flatMap((c) => [c.card_number, c.cvv])
    .filter((secret) => files.some((buf) => buf.includes(secret)));
}

async function freshInventory(vault = createCardVault(randomBytes(32))) {
  const dir = tempDir();
  const dbPath = path.join(dir, 'card.db');
  const db = await openInventory({ dbPath, migrationsDir: MIGRATIONS, vault });
  addProvider(db, { id: 'amex', name: 'Amex' });
  return { dir, dbPath, db, vault, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A database in the shape the bot had before cards were sealed, holding plaintext rows. */
async function plaintextDatabase(dir, deletedCards = []) {
  const oldMigrations = path.join(dir, 'old-migrations');
  mkdirSync(oldMigrations);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(path.join(MIGRATIONS, f), path.join(oldMigrations, f));
  }
  const dbPath = path.join(dir, 'card.db');
  const db = openDb({ dbPath });
  await runMigrations({ db, migrationsDir: oldMigrations });
  db.run(`INSERT INTO providers (id, name, is_active, created_at) VALUES ('amex', 'Amex', 0, 1)`);
  for (const c of CARDS.slice(0, 2)) {
    db.run(
      `INSERT INTO cards (provider_id, card_number, mm, yy, cvv, zip, added_at) VALUES ('amex', ?, ?, ?, ?, ?, 1)`,
      c.card_number, c.mm, c.yy, c.cvv, c.zip ?? null,
    );
  }
  const s = CARDS[2];
  db.run(
    `INSERT INTO card_sessions (message_id, user_id, provider_id, card_number, mm, yy, cvv, zip, claimed_at)
     VALUES ('m1', 'u1', 'amex', ?, ?, ?, ?, ?, 1)`,
    s.card_number, s.mm, s.yy, s.cvv, s.zip,
  );
  db.runScript('PRAGMA secure_delete = OFF');
  for (const c of deletedCards) {
    db.run(
      `INSERT INTO cards (provider_id, card_number, mm, yy, cvv, added_at) VALUES ('amex', ?, ?, ?, ?, 1)`,
      c.card_number, c.mm, c.yy, c.cvv,
    );
    db.run(
      `INSERT INTO card_sessions (message_id, user_id, provider_id, card_number, mm, yy, cvv, claimed_at)
       VALUES (?, 'u1', 'amex', ?, ?, ?, ?, 1)`,
      c.card_number, c.card_number, c.mm, c.yy, c.cvv,
    );
  }
  db.run(`DELETE FROM cards WHERE id > 2`);
  db.run(`DELETE FROM card_sessions WHERE message_id != 'm1'`);
  db.close();
  return dbPath;
}

test('a sealed card opens to the same card, and each seal uses a fresh nonce', () => {
  const vault = createCardVault(randomBytes(32));
  const a = vault.seal(CARDS[0]);
  const b = vault.seal(CARDS[0]);
  assert.deepEqual(vault.open(a), CARDS[0]);
  assert.equal(a.last4, '0005');
  assert.equal(a.fingerprint, b.fingerprint, 'same card, same fingerprint');
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('the wrong key never opens a card, even with a forged key id', () => {
  const right = createCardVault(randomBytes(32));
  const wrong = createCardVault(randomBytes(32));
  const sealed = right.seal(CARDS[0]);

  assert.throws(() => wrong.open(sealed), /sealed with key id/);
  assert.throws(() => wrong.open({ ...sealed, key_id: wrong.keyId }), /unable to authenticate/i);
});

test('a tampered ciphertext or a swapped fingerprint does not open', () => {
  const vault = createCardVault(randomBytes(32));
  const sealed = vault.seal(CARDS[0]);
  const flipped = Buffer.from(sealed.ciphertext);
  flipped[0] ^= 1;
  assert.throws(() => vault.open({ ...sealed, ciphertext: flipped }), /unable to authenticate/i);
  const other = vault.seal(CARDS[1]);
  assert.throws(() => vault.open({ ...sealed, fingerprint: other.fingerprint }), /unable to authenticate/i);
});

test('the byte search finds card numbers and CVVs in a plaintext database', async () => {
  const dir = tempDir();
  try {
    const dbPath = await plaintextDatabase(dir);
    assert.deepEqual(
      plaintextFound(dbPath, CARDS).sort(),
      CARDS.flatMap((c) => [c.card_number, c.cvv]).sort(),
      'the probe can see plaintext, so its silence below means something',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loaded, claimed and returned cards never reach the database file or WAL in plaintext', async () => {
  const inv = await freshInventory();
  try {
    loadCards(inv.db, inv.vault, 'amex', CARDS);
    const claimed = claimCard(inv.db, inv.vault);
    openCardSession(inv.db, { messageId: 'm1', userId: 'u1', providerId: 'amex', sealed: claimed.sealed });
    assert.deepEqual(plaintextFound(inv.dbPath, CARDS), [], 'nothing found while the WAL is live');

    returnCardToPool(inv.db, { ...claimed.sealed, message_id: 'm1' });
    inv.db.close();
    assert.deepEqual(plaintextFound(inv.dbPath, CARDS), [], 'nothing found after close');
  } finally {
    rmSync(inv.dir, { recursive: true, force: true });
  }
});

test('claiming hands over the first loaded card in plaintext and removes it from stock', async () => {
  const inv = await freshInventory();
  try {
    loadCards(inv.db, inv.vault, 'amex', CARDS);
    const claimed = claimCard(inv.db, inv.vault);
    assert.deepEqual(claimed.card, { ...CARDS[0] });
    assert.equal(claimed.sealed.last4, '0005');
    assert.equal(inv.db.get('SELECT COUNT(*) AS n FROM cards').n, 2);

    returnCardToPool(inv.db, { ...claimed.sealed, message_id: null });
    assert.deepEqual(claimCard(inv.db, inv.vault).card, CARDS[0], 'a returned card is next in line');
  } finally {
    inv.cleanup();
  }
});

test('a card that will not open stays in stock', async () => {
  const inv = await freshInventory();
  try {
    loadCards(inv.db, inv.vault, 'amex', CARDS.slice(0, 1));
    const otherKey = createCardVault(randomBytes(32));
    assert.throws(() => claimCard(inv.db, otherKey), /sealed with key id/);
    assert.equal(inv.db.get('SELECT COUNT(*) AS n FROM cards').n, 1);
  } finally {
    inv.cleanup();
  }
});

test('loading the same card twice into one provider skips the duplicate', async () => {
  const inv = await freshInventory();
  try {
    addProvider(inv.db, { id: 'venture', name: 'Venture' });
    assert.deepEqual(loadCards(inv.db, inv.vault, 'amex', CARDS), { inserted: 3, skipped: 0 });
    assert.deepEqual(loadCards(inv.db, inv.vault, 'amex', CARDS), { inserted: 0, skipped: 3 });
    assert.deepEqual(
      loadCards(inv.db, inv.vault, 'venture', CARDS.slice(0, 1)),
      { inserted: 1, skipped: 0 },
      'uniqueness is per provider',
    );
  } finally {
    inv.cleanup();
  }
});

test('/export output parses back into the cards that were loaded', async () => {
  const inv = await freshInventory();
  try {
    const file = CARDS.map((c) => [c.card_number, c.mm, c.yy, c.cvv, c.zip].filter(Boolean).join(',')).join('\n');
    loadCards(inv.db, inv.vault, 'amex', parseCardFile(file));
    const exported = exportCardsForProvider(inv.db, inv.vault, 'amex');
    assert.equal(exported, file);
    assert.deepEqual(parseCardFile(exported), parseCardFile(file));
  } finally {
    inv.cleanup();
  }
});

test('booting seals live rows and scrubs previously deleted cards and sessions, once', async () => {
  const dir = tempDir();
  const vault = createCardVault(randomBytes(32));
  try {
    const deleted = Array.from({ length: 400 }, (_, i) => ({
      card_number: String(5555555500000000n + BigInt(i)), mm: '09', yy: '2031', cvv: '6847',
    }));
    const dbPath = await plaintextDatabase(dir, deleted);
    assert.ok(plaintextFound(dbPath, deleted).includes(deleted[0].card_number));

    let db = await openInventory({ dbPath, migrationsDir: MIGRATIONS, vault });
    const columns = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const table of ['cards', 'card_sessions']) {
      for (const col of ['card_number', 'mm', 'yy', 'cvv', 'zip']) {
        assert.ok(!columns(table).includes(col), `${table}.${col} is gone`);
      }
    }
    const cardsAfterFirstBoot = db.all('SELECT * FROM cards ORDER BY id');
    const session = db.get(`SELECT * FROM card_sessions WHERE message_id = 'm1'`);
    assert.deepEqual(cardsAfterFirstBoot.map((row) => vault.open(row)), CARDS.slice(0, 2).map((c) => ({ zip: null, ...c })));
    assert.deepEqual(vault.open(session), CARDS[2]);
    assert.deepEqual(plaintextFound(dbPath, [...CARDS, ...deleted]), [], 'no plaintext in database or live WAL');
    db.close();
    assert.deepEqual(plaintextFound(dbPath, [...CARDS, ...deleted]), [], 'no plaintext left in the file');

    db = await openInventory({ dbPath, migrationsDir: MIGRATIONS, vault });
    assert.deepEqual(db.all('SELECT * FROM cards ORDER BY id'), cardsAfterFirstBoot, 'second boot changes nothing');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('booting with a different key than the cards were sealed with fails', async () => {
  const inv = await freshInventory();
  try {
    loadCards(inv.db, inv.vault, 'amex', CARDS);
    inv.db.close();
    const otherKey = createCardVault(randomBytes(32));
    await assert.rejects(
      openInventory({ dbPath: inv.dbPath, migrationsDir: MIGRATIONS, vault: otherKey }),
      new RegExp(`sealed with key id ${inv.vault.keyId}`),
    );
  } finally {
    rmSync(inv.dir, { recursive: true, force: true });
  }
});
