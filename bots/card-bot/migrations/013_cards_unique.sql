-- Dedup safety net for the cards table. Previously there was no DB-level
-- constraint preventing the same card from being appended twice — only the
-- admin's discipline. Adding a UNIQUE index lets us safely use INSERT OR IGNORE
-- in loadCards() and report skipped duplicates back to the admin.

CREATE UNIQUE INDEX cards_provider_card_unique ON cards(provider_id, card_number);
