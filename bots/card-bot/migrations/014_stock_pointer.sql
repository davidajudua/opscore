-- /stock is now a one-time deploy command (mirroring payment-bot's /dashboard).
-- The deployed message auto-refreshes on every state-changing event (card
-- claim/use/load, provider mode/edit/delete) so the panel
-- always see current stock without re-running the command.
--
-- One row per channel; channel_id is the primary key. The message_id is the
-- last-deployed stock panel in that channel. Re-running /stock in the same
-- channel updates the pointer (old message becomes orphaned and is left alone).

CREATE TABLE IF NOT EXISTS stock_pointer (
  channel_id  TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  deployed_at INTEGER NOT NULL
);
