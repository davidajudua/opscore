-- Payment Bot v0.1 schema.

CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,    -- 'payment' | 'cashout' | 'adjustment'
  method      TEXT,                -- 'zelle' | 'venmo' | 'paypal' | 'crypto' | NULL for cashout
  amount      REAL    NOT NULL,    -- positive for income, positive for cashout/adjustment (subtracted at read)
  sender_name TEXT,
  note        TEXT,
  external_id TEXT,                -- IMAP UID or tx hash, used for dedup
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_method_created_idx ON ledger(method, created_at);
CREATE INDEX IF NOT EXISTS ledger_kind_created_idx   ON ledger(kind, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_method_external_idx ON ledger(method, external_id) WHERE external_id IS NOT NULL;

-- Track the most recent successfully processed UID per provider so the bot can resume
-- after restart without rescanning the entire inbox.
CREATE TABLE IF NOT EXISTS imap_cursor (
  provider     TEXT PRIMARY KEY,
  last_uid     INTEGER,
  updated_at   INTEGER NOT NULL
);
