-- Tracks an in-flight card claim from /card so its embed buttons (Used / Error / Return)
-- have something to act on. Keyed by the Discord message id; rows are deleted as soon
-- as the user clicks any of the three action buttons.

CREATE TABLE IF NOT EXISTS card_sessions (
  message_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  card_number  TEXT NOT NULL,
  mm           TEXT NOT NULL,
  yy           TEXT NOT NULL,
  cvv          TEXT NOT NULL,
  zip          TEXT,
  claimed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS card_sessions_user_idx ON card_sessions(user_id);
