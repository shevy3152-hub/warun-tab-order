-- Adds runtime-managed customer rail theme definitions and image metadata.
BEGIN IMMEDIATE;

CREATE TABLE customer_theme_assets (
  theme_key TEXT PRIMARY KEY CHECK (length(theme_key) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  asset_filename TEXT NOT NULL CHECK (length(asset_filename) BETWEEN 1 AND 80),
  image_width INTEGER NOT NULL CHECK (image_width BETWEEN 1 AND 12000),
  image_height INTEGER NOT NULL CHECK (image_height BETWEEN 1 AND 24000),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

PRAGMA user_version = 24;
COMMIT;
