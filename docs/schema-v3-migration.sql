-- warun-tab-order additive SQLite migration: schema v2 -> v3
-- Prices remain integer tax-included yen. Existing operational rows are preserved.

BEGIN IMMEDIATE;

DROP TRIGGER trg_event_log_current_epoch;
DROP TRIGGER trg_order_items_immutable_snapshots;
DROP INDEX uq_order_items_order_menu;

ALTER TABLE menu_items ADD COLUMN section_key TEXT
  CHECK (section_key IS NULL OR length(trim(section_key)) BETWEEN 1 AND 40);

CREATE TABLE menu_item_details (
  menu_item_id TEXT PRIMARY KEY,
  detail_enabled INTEGER NOT NULL DEFAULT 0 CHECK (detail_enabled IN (0, 1)),
  detail_image_uri TEXT,
  reading TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  producer TEXT NOT NULL DEFAULT '',
  taste TEXT NOT NULL DEFAULT '',
  aroma TEXT NOT NULL DEFAULT '',
  sweetness TEXT NOT NULL DEFAULT '',
  finish TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  detail_description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE menu_item_variants (
  variant_id TEXT PRIMARY KEY
    CHECK (length(variant_id) BETWEEN 1 AND 64 AND variant_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  menu_item_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  volume_label TEXT NOT NULL DEFAULT '' CHECK (length(volume_label) <= 40),
  price_yen INTEGER NOT NULL CHECK (price_yen BETWEEN 0 AND 10000000),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  UNIQUE (menu_item_id, name, volume_label)
);

CREATE TABLE menu_item_serving_options (
  serving_option_id TEXT PRIMARY KEY
    CHECK (length(serving_option_id) BETWEEN 1 AND 64 AND serving_option_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  menu_item_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  UNIQUE (menu_item_id, name)
);

ALTER TABLE order_items ADD COLUMN variant_id TEXT
  REFERENCES menu_item_variants(variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE order_items ADD COLUMN variant_name_snapshot TEXT
  CHECK (variant_name_snapshot IS NULL OR length(trim(variant_name_snapshot)) BETWEEN 1 AND 80);
ALTER TABLE order_items ADD COLUMN variant_volume_snapshot TEXT
  CHECK (variant_volume_snapshot IS NULL OR length(variant_volume_snapshot) <= 40);
ALTER TABLE order_items ADD COLUMN serving_option_id TEXT
  REFERENCES menu_item_serving_options(serving_option_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE order_items ADD COLUMN serving_option_name_snapshot TEXT
  CHECK (serving_option_name_snapshot IS NULL OR length(trim(serving_option_name_snapshot)) BETWEEN 1 AND 80);

CREATE INDEX idx_menu_item_variants_item_sort
  ON menu_item_variants (menu_item_id, is_active, sort_order, variant_id);
CREATE INDEX idx_menu_item_serving_options_item_sort
  ON menu_item_serving_options (menu_item_id, is_active, sort_order, serving_option_id);
CREATE UNIQUE INDEX uq_order_items_order_selection
  ON order_items (
    order_id,
    menu_item_id,
    COALESCE(variant_id, ''),
    COALESCE(serving_option_id, '')
  )
  WHERE menu_item_id IS NOT NULL;

CREATE TRIGGER trg_order_items_immutable_snapshots
BEFORE UPDATE OF
  order_id,
  line_index,
  menu_item_id,
  formal_name_snapshot,
  kitchen_alias_snapshot,
  unit_price_yen_snapshot,
  quantity,
  line_total_yen,
  variant_id,
  variant_name_snapshot,
  variant_volume_snapshot,
  serving_option_id,
  serving_option_name_snapshot,
  created_at_ms
ON order_items
WHEN
  NEW.order_id IS NOT OLD.order_id
  OR NEW.line_index IS NOT OLD.line_index
  OR NEW.menu_item_id IS NOT OLD.menu_item_id
  OR NEW.formal_name_snapshot IS NOT OLD.formal_name_snapshot
  OR NEW.kitchen_alias_snapshot IS NOT OLD.kitchen_alias_snapshot
  OR NEW.unit_price_yen_snapshot IS NOT OLD.unit_price_yen_snapshot
  OR NEW.quantity IS NOT OLD.quantity
  OR NEW.line_total_yen IS NOT OLD.line_total_yen
  OR NEW.variant_id IS NOT OLD.variant_id
  OR NEW.variant_name_snapshot IS NOT OLD.variant_name_snapshot
  OR NEW.variant_volume_snapshot IS NOT OLD.variant_volume_snapshot
  OR NEW.serving_option_id IS NOT OLD.serving_option_id
  OR NEW.serving_option_name_snapshot IS NOT OLD.serving_option_name_snapshot
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'order item identity and price/name snapshots are immutable');
END;

CREATE TABLE system_state_v3 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 3),
  event_epoch TEXT NOT NULL UNIQUE
    CHECK (
      length(event_epoch) = 36
      AND substr(event_epoch, 9, 1) = '-'
      AND substr(event_epoch, 14, 1) = '-'
      AND substr(event_epoch, 19, 1) = '-'
      AND substr(event_epoch, 24, 1) = '-'
      AND event_epoch = lower(event_epoch)
      AND event_epoch NOT GLOB '*[^0-9a-f-]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state_v3
SELECT singleton_id, 3, event_epoch, created_at_ms, updated_at_ms FROM system_state;
DROP TABLE system_state;
ALTER TABLE system_state_v3 RENAME TO system_state;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 3;
COMMIT;
