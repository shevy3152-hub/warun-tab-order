-- Adds the server-persisted customer-side rail theme setting.
-- The row is intentionally created on first administrative save so an unset
-- installation remains a standard/red rail through the public fallback.

BEGIN IMMEDIATE;

CREATE TABLE customer_theme_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  theme_key TEXT NOT NULL CHECK (theme_key IN ('standard', 'camellia')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE customer_theme_variants (
  theme_key TEXT PRIMARY KEY CHECK (theme_key IN ('standard', 'camellia')),
  prompt_text TEXT NOT NULL CHECK (length(prompt_text) <= 4000),
  production_notes TEXT NOT NULL CHECK (length(production_notes) <= 4000),
  position_x REAL NOT NULL CHECK (position_x >= 0 AND position_x <= 1),
  position_y REAL NOT NULL CHECK (position_y >= 0 AND position_y <= 1),
  zoom REAL NOT NULL CHECK (zoom >= 0.5 AND zoom <= 3),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO customer_theme_variants (
  theme_key, prompt_text, production_notes,
  position_x, position_y, zoom, created_at_ms, updated_at_ms
) VALUES
  (
    'standard',
    '画像は使用しない標準の赤レール。文字やロゴを画像に描かず、UIが重なる領域に重要な絵柄を置かない。',
    '未設定・画像読込失敗時のfallback。客席レールは従来の赤表示。',
    0.5, 0.5, 1, 0, 0
  ),
  (
    'camellia',
    '和紙に描いた椿の縦長模様。文字・ロゴを画像に描かない。UIが重なる領域に重要な絵柄を置かない。客席端末の展開時レールに使う背景素材。',
    '既存asset: 426×1587 px、縦長比率 426:1587（約0.268:1、縦が横の約3.73倍）。展開時のみ表示し、折り畳み時は赤レールへ戻す。',
    0.5, 0.5, 1, 0, 0
  );

-- PRAGMA user_version is the database migration marker.  The legacy
-- system_state.schema_version remains the v16 event-metadata version because
-- its v16 CHECK constraint cannot be changed without rebuilding that shared
-- table.  The application accepts that legacy marker while requiring
-- PRAGMA user_version = 17 and the additive theme tables below.
PRAGMA user_version = 17;
COMMIT;
