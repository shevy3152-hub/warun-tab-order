-- warun-tab-order additive SQLite migration: schema v3 -> v4
-- Adds sake temperature availability and immutable order temperature snapshots.

BEGIN IMMEDIATE;

DROP TRIGGER trg_order_items_immutable_snapshots;
DROP TRIGGER trg_event_log_current_epoch;
DROP INDEX uq_order_items_order_selection;

ALTER TABLE menu_item_variants ADD COLUMN temperature_options_json TEXT NOT NULL
  DEFAULT '["冷酒","燗酒"]';

ALTER TABLE order_items ADD COLUMN temperature_snapshot TEXT
  CHECK (temperature_snapshot IS NULL OR length(trim(temperature_snapshot)) BETWEEN 1 AND 20);

-- The initial sake serving policy is cold-only for a glass and cold/warm for tokuri.
-- Existing non-glass variants retain the normal cold/warm policy.
UPDATE menu_item_variants
SET temperature_options_json = CASE
  WHEN trim(name) = 'グラス' THEN '["冷酒"]'
  ELSE '["冷酒","燗酒"]'
END;

CREATE UNIQUE INDEX uq_order_items_order_selection
  ON order_items (
    order_id,
    menu_item_id,
    COALESCE(variant_id, ''),
    COALESCE(serving_option_id, ''),
    COALESCE(temperature_snapshot, '')
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
  temperature_snapshot,
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
  OR NEW.temperature_snapshot IS NOT OLD.temperature_snapshot
  OR NEW.serving_option_id IS NOT OLD.serving_option_id
  OR NEW.serving_option_name_snapshot IS NOT OLD.serving_option_name_snapshot
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'order item identity and price/name snapshots are immutable');
END;

CREATE TABLE system_state_v4 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 4),
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
INSERT INTO system_state_v4
SELECT singleton_id, 4, event_epoch, created_at_ms, updated_at_ms FROM system_state;
DROP TABLE system_state;
ALTER TABLE system_state_v4 RENAME TO system_state;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 4;
COMMIT;
