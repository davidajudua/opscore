-- Dedup table for IMAP UIDs we've already served. Previously held in-memory in
-- the SafekeyFetcher; a PM2 restart wiped it, which let a freshly-served code
-- be re-delivered to the next worker if their click landed inside the fetcher's
-- 30s back-window. Persisting to disk closes that hole.

CREATE TABLE served_codes (
  uid       INTEGER PRIMARY KEY,
  served_at INTEGER NOT NULL
);

-- Purge query: DELETE FROM served_codes WHERE served_at < ?
CREATE INDEX served_codes_served_at_idx ON served_codes(served_at);
