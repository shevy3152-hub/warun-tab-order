-- Rebuilds only the two customer rail theme tables to remove theme-key CHECK
-- constraints. Keys are validated against the shared application definition.
-- The caller owns the surrounding transaction and validates the copied rows
-- before replacing the original tables.

CREATE TABLE customer_theme_settings_v21 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  theme_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO customer_theme_settings_v21 (
  singleton_id, theme_key, version, created_at_ms, updated_at_ms
)
SELECT singleton_id, theme_key, version, created_at_ms, updated_at_ms
FROM customer_theme_settings;

CREATE TABLE customer_theme_variants_v21 (
  theme_key TEXT PRIMARY KEY,
  prompt_text TEXT NOT NULL CHECK (length(prompt_text) <= 4000),
  production_notes TEXT NOT NULL CHECK (length(production_notes) <= 4000),
  position_x REAL NOT NULL CHECK (position_x >= 0 AND position_x <= 1),
  position_y REAL NOT NULL CHECK (position_y >= 0 AND position_y <= 1),
  zoom REAL NOT NULL CHECK (zoom >= 0.5 AND zoom <= 3),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO customer_theme_variants_v21 (
  theme_key, prompt_text, production_notes, position_x, position_y, zoom,
  created_at_ms, updated_at_ms
)
SELECT theme_key, prompt_text, production_notes, position_x, position_y, zoom,
  created_at_ms, updated_at_ms
FROM customer_theme_variants;
