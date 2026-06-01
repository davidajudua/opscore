-- Dedup table for Discord message IDs of webhook-sourced SafeKey codes.
-- Mirrors served_codes (which dedups IMAP UIDs) but uses TEXT PK since
-- Discord snowflakes are large unsigned 64-bit values better stored as strings.
--
-- Same TTL pattern: a periodic purge keeps the table bounded. INSERT OR IGNORE
-- gives atomic claim semantics so two concurrent fetchers (currently only one,
-- but the race plumbing supports more) can't serve the same message twice.

CREATE TABLE IF NOT EXISTS served_webhook_codes (
  message_id TEXT PRIMARY KEY,
  served_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS served_webhook_codes_served_at_idx ON served_webhook_codes(served_at);
