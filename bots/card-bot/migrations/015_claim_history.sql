-- Permanent log of every card claim. Card sessions are deleted
-- when the user clicks Used/Error/Return, so we need a separate persistent
-- log to compute daily claim stats.


CREATE TABLE IF NOT EXISTS claim_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,        -- 'card'
  user_id     TEXT NOT NULL,
  provider    TEXT,                 -- provider_id
  claimed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claim_history_user_time_idx ON claim_history(user_id, claimed_at);
CREATE INDEX IF NOT EXISTS claim_history_time_idx ON claim_history(claimed_at);
