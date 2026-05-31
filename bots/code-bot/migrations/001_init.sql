-- Code Bot schema (v0.1)
-- The queue table itself is created by bot-core's WorkerQueue (queue_codebot).
-- This migration only sets up the bot-specific tables.

CREATE TABLE IF NOT EXISTS deploy_message (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
