-- Allow multiple deploy panels — one per code provider (currently 'amex' or 'eno').
-- The original deploy_message was a singleton (id=1 CHECK constraint). Now keyed
-- on provider so /deploy amex and /deploy eno can each have their own panel
-- in different channels, running queues independently.
--
-- Existing deploys are preserved as 'amex' (the only provider that existed).

CREATE TABLE deploy_message_v2 (
  provider   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO deploy_message_v2 (provider, channel_id, message_id, updated_at)
SELECT 'amex', channel_id, message_id, updated_at FROM deploy_message;

DROP TABLE deploy_message;

ALTER TABLE deploy_message_v2 RENAME TO deploy_message;
