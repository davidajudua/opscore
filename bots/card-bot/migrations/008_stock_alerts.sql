-- Tracks which low-stock alerts have already been posted, so a single sub-threshold
-- alert fires once per crossing instead of after every claim. Re-armed when /load,
-- a Return, or a manual Erase/Delete brings stock back above the threshold.

CREATE TABLE IF NOT EXISTS stock_alerts (
  alert_key TEXT    PRIMARY KEY,  -- 'card:<providerId>'
  fired_at  INTEGER NOT NULL
);
