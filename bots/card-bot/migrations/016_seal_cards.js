// Replace the plaintext card columns in `cards` and `card_sessions` with sealed
// ones (see src/card-vault.js). Each table is rebuilt: copy every row into a new
// table in sealed form, drop the old table and its indexes, rename the new one.
// The bot turns on secure_delete before migrating, so the pages that held
// plaintext are zeroed instead of left in the file's free list.
//
// A table that no longer has a card_number column is already sealed and is
// skipped, so running this twice changes nothing.

const SEALED = 'key_id, nonce, tag, ciphertext, fingerprint, last4';

function hasPlaintext(db, table) {
  return db.all(`PRAGMA table_info(${table})`).some((col) => col.name === 'card_number');
}

function sealCards(db, vault) {
  db.runScript(`
    CREATE TABLE cards_sealed (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT    NOT NULL,
      key_id      TEXT    NOT NULL,
      nonce       BLOB    NOT NULL,
      tag         BLOB    NOT NULL,
      ciphertext  BLOB    NOT NULL,
      fingerprint TEXT    NOT NULL,
      last4       TEXT    NOT NULL,
      added_at    INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);
  for (const row of db.all(`SELECT * FROM cards ORDER BY id`)) {
    const s = vault.seal(row);
    db.run(
      `INSERT INTO cards_sealed (id, provider_id, ${SEALED}, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.provider_id, s.key_id, s.nonce, s.tag, s.ciphertext, s.fingerprint, s.last4, row.added_at,
    );
  }
  db.runScript(`
    DROP TABLE cards;
    ALTER TABLE cards_sealed RENAME TO cards;
    CREATE INDEX cards_provider_idx ON cards(provider_id);
    CREATE UNIQUE INDEX cards_provider_fingerprint_unique ON cards(provider_id, fingerprint);
  `);
}

function sealSessions(db, vault) {
  db.runScript(`
    CREATE TABLE card_sessions_sealed (
      message_id  TEXT    PRIMARY KEY,
      user_id     TEXT    NOT NULL,
      provider_id TEXT    NOT NULL,
      key_id      TEXT    NOT NULL,
      nonce       BLOB    NOT NULL,
      tag         BLOB    NOT NULL,
      ciphertext  BLOB    NOT NULL,
      fingerprint TEXT    NOT NULL,
      last4       TEXT    NOT NULL,
      claimed_at  INTEGER NOT NULL
    )
  `);
  for (const row of db.all(`SELECT * FROM card_sessions`)) {
    const s = vault.seal(row);
    db.run(
      `INSERT INTO card_sessions_sealed (message_id, user_id, provider_id, ${SEALED}, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.message_id, row.user_id, row.provider_id,
      s.key_id, s.nonce, s.tag, s.ciphertext, s.fingerprint, s.last4, row.claimed_at,
    );
  }
  db.runScript(`
    DROP TABLE card_sessions;
    ALTER TABLE card_sessions_sealed RENAME TO card_sessions;
    CREATE INDEX card_sessions_user_idx ON card_sessions(user_id);
  `);
}

export function up(db, { vault }) {
  if (hasPlaintext(db, 'cards')) sealCards(db, vault);
  if (hasPlaintext(db, 'card_sessions')) sealSessions(db, vault);
}
