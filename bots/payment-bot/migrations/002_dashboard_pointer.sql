-- Pointer to the live /dashboard message(s) that should be auto-refreshed when
-- a payment / cashout / adjustment lands. Composite key allows multiple dashboards
-- per channel (one per separate /dashboard invocation), but each row maps to a
-- unique Discord message.

CREATE TABLE IF NOT EXISTS dashboard_pointer (
  channel_id  TEXT    NOT NULL,
  message_id  TEXT    NOT NULL PRIMARY KEY,
  posted_at   INTEGER NOT NULL
);
