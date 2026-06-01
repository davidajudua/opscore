-- Dedup safety net for the cards table. Previously there was no DB-level
-- constraint preventing the same card from being appended twice — only the
-- admin's discipline. Adding a UNIQUE index lets us safely use INSERT OR IGNORE
-- in loadCards() and report skipped duplicates back to the admin.

-- Pre-deduplicate before adding the constraint: a database loaded multiple
-- times before this migration could already contain duplicate
-- (provider_id, card_number) rows, and SQLite rejects CREATE UNIQUE INDEX
-- outright if any duplicates exist — which would abort startup. Keep the
-- earliest-loaded copy (lowest id) of each card.
DELETE FROM cards
WHERE id NOT IN (
  SELECT MIN(id) FROM cards GROUP BY provider_id, card_number
);

CREATE UNIQUE INDEX IF NOT EXISTS cards_provider_card_unique ON cards(provider_id, card_number);
