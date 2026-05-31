-- Generic key/value settings table. Used for admin-tweakable state that doesn't
-- belong in their own structured table (e.g. card mode, prices).

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
