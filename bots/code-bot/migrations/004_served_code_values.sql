-- Cross-source dedup keyed on the code VALUE itself (e.g. '194084'). Both
-- fetchers (IMAP + webhook) claim into this table after their per-source
-- claim succeeds; if the value is already claimed by another source within
-- the TTL window, they skip the candidate and keep looking.
--
-- Why a separate table: served_codes (IMAP UID) and served_webhook_codes
-- (Discord message_id) prevent the SAME physical message from being served
-- twice. This table prevents the same CODE VALUE from being served twice
-- across both sources (e.g. Amex sometimes sends the same code via both
-- email AND SMS — without this, worker A could get the SMS code and worker
-- B could later get the email version of the same expired code).

CREATE TABLE IF NOT EXISTS served_code_values (
  code       TEXT PRIMARY KEY,
  served_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS served_code_values_served_at_idx ON served_code_values(served_at);
