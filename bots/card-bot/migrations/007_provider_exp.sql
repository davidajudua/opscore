-- Per-provider default expiration date. Same fallback shape as `zip`: card-level
-- value wins; otherwise the embed renders the provider's default.

ALTER TABLE providers ADD COLUMN exp_date TEXT;
