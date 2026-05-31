-- Per-provider flag for the "Mix" card-selection mode. When the bot is in Mix
-- mode (settings.card_mode = 'mix'), `/card` only draws from providers where
-- in_mix = 1. Single-active mode and All mode ignore this column.
ALTER TABLE providers ADD COLUMN in_mix INTEGER NOT NULL DEFAULT 0;
