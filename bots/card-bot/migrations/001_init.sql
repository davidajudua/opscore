-- Card Bot v0.1 schema.

-- Card providers (e.g. "A", "C1", "C2"). The "active" flag pins which provider /card
-- pulls from first; if no provider is active, /card walks providers in insertion order.
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,    -- short, lowercase
  name       TEXT NOT NULL,        -- display name
  zip        TEXT,                 -- default zip when card lines have only 4 fields
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Pre-loaded cards. Claimed cards are deleted on /card so a card is never given out twice.
CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  card_number TEXT NOT NULL,
  mm          TEXT NOT NULL,
  yy          TEXT NOT NULL,
  cvv         TEXT NOT NULL,
  zip         TEXT,                 -- nullable: falls back to provider.zip
  added_at    INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cards_provider_idx ON cards(provider_id);

-- Channel whitelist. Each row whitelists one channel for the card feature.
CREATE TABLE IF NOT EXISTS whitelist (
  channel_id TEXT NOT NULL,
  feature    TEXT NOT NULL,        -- 'card'
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, feature)
);
