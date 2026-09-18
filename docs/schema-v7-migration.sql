-- v6 -> v7: persist the fixed customer-rail ownership of editable subcategories.
-- The backfill uses the stable category IDs defined by the customer catalog.
BEGIN IMMEDIATE;

ALTER TABLE categories ADD COLUMN section_key TEXT NOT NULL DEFAULT 'seasonal'
  CHECK (section_key IN ('drink', 'food', 'winter', 'seasonal'));

UPDATE categories SET section_key = 'drink'
WHERE category_id IN ('beer', 'highball', 'sour', 'shochu', 'sake', 'soft-drink', 'nonalcohol');
UPDATE categories SET section_key = 'food'
WHERE category_id IN ('food-ready', 'food-chicken', 'food-kushi', 'food-gifu', 'food-teppan', 'special-hine', 'special-reservation', 'recommended');
UPDATE categories SET section_key = 'winter'
WHERE category_id IN ('winter-hotpot', 'winter-shime');
-- Any unrecognised legacy ID must abort the migration instead of being guessed.
UPDATE categories SET section_key = '__unmapped__'
WHERE category_id NOT IN (
  'beer', 'highball', 'sour', 'shochu', 'sake', 'soft-drink', 'nonalcohol',
  'food-ready', 'food-chicken', 'food-kushi', 'food-gifu', 'food-teppan',
  'special-hine', 'special-reservation', 'winter-hotpot', 'winter-shime', 'recommended'
);

CREATE UNIQUE INDEX uq_categories_section_name
  ON categories (section_key, name);

CREATE TEMP TABLE system_state_backup AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 7),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 7, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup;

PRAGMA user_version = 7;
COMMIT;
