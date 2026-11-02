-- Adds reusable per-menu-item quantity selection and immutable order unit labels.
BEGIN IMMEDIATE;

ALTER TABLE menu_items ADD COLUMN quantity_selection_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quantity_selection_enabled IN (0, 1));
ALTER TABLE menu_items ADD COLUMN minimum_quantity INTEGER NOT NULL DEFAULT 1 CHECK (minimum_quantity BETWEEN 1 AND 99);
ALTER TABLE menu_items ADD COLUMN initial_quantity INTEGER NOT NULL DEFAULT 1 CHECK (initial_quantity BETWEEN 1 AND 99);
ALTER TABLE menu_items ADD COLUMN quantity_step INTEGER NOT NULL DEFAULT 1 CHECK (quantity_step BETWEEN 1 AND 99);
ALTER TABLE menu_items ADD COLUMN quantity_unit_label TEXT NOT NULL DEFAULT '点' CHECK (length(trim(quantity_unit_label)) BETWEEN 1 AND 8);
ALTER TABLE menu_items ADD COLUMN price_assertion_required INTEGER NOT NULL DEFAULT 0 CHECK (price_assertion_required IN (0, 1));
ALTER TABLE order_items ADD COLUMN quantity_unit_label_snapshot TEXT CHECK (quantity_unit_label_snapshot IS NULL OR length(trim(quantity_unit_label_snapshot)) BETWEEN 1 AND 8);
ALTER TABLE payment_order_items ADD COLUMN quantity_unit_label_snapshot TEXT CHECK (quantity_unit_label_snapshot IS NULL OR length(trim(quantity_unit_label_snapshot)) BETWEEN 1 AND 8);

-- Refuse a partial or stale live catalog match. Empty development databases remain valid.
CREATE TEMP TABLE quantity_selection_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO quantity_selection_migration_guard (valid)
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM menu_items
    WHERE menu_item_id IN (
      'food-chicken-torikawa',
      'menu-1e155a5f-bcae-4813-8a4c-e2f477d5d521',
      'menu-7c38047d-94c2-478b-946f-bd330011f571',
      'menu-878962fb-4c69-4858-84ba-7ac4e922097c',
      'menu-cb34634d-7320-4eb6-ac37-f65e1a33c493'
    )
  ) OR (
    (SELECT COUNT(*) FROM menu_items WHERE menu_item_id = 'food-chicken-torikawa' AND category_id = 'food-chicken' AND formal_name = 'ぱりぱり鶏皮（2本）' AND price_yen = 450 AND is_active = 1) = 1
    AND (SELECT COUNT(*) FROM menu_items WHERE menu_item_id = 'menu-1e155a5f-bcae-4813-8a4c-e2f477d5d521' AND category_id = 'food-kushi' AND formal_name = '串カツ　ソース' AND price_yen = 180 AND is_active = 1) = 1
    AND (SELECT COUNT(*) FROM menu_items WHERE menu_item_id = 'menu-7c38047d-94c2-478b-946f-bd330011f571' AND category_id = 'food-kushi' AND formal_name = '串カツ　塩レモン' AND price_yen = 180 AND is_active = 1) = 1
    AND (SELECT COUNT(*) FROM menu_items WHERE menu_item_id = 'menu-878962fb-4c69-4858-84ba-7ac4e922097c' AND category_id = 'food-kushi' AND formal_name = '串カツ　みそ' AND price_yen = 190 AND is_active = 1) = 1
    AND (SELECT COUNT(*) FROM menu_items WHERE menu_item_id = 'menu-cb34634d-7320-4eb6-ac37-f65e1a33c493' AND category_id = 'food-kushi' AND formal_name = '串カツ　おろしポン酢' AND price_yen = 200 AND is_active = 1) = 1
  ) THEN 1 ELSE 0 END;
INSERT INTO quantity_selection_migration_guard (valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM menu_items WHERE menu_item_id = 'food-kushi-kushikatsu' AND is_active <> 0
) THEN 1 ELSE 0 END;
DROP TABLE quantity_selection_migration_guard;

DROP TRIGGER trg_order_items_immutable_snapshots;
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
  quantity_unit_label_snapshot,
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
  OR NEW.quantity_unit_label_snapshot IS NOT OLD.quantity_unit_label_snapshot
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'order identity, price, name, and unit snapshots are immutable');
END;

-- The retired variant-based item stays paused, but retains its prior per-flavor minimum behavior.
UPDATE menu_items
SET quantity_selection_enabled = 1,
    minimum_quantity = 2,
    initial_quantity = 2,
    quantity_step = 1,
    quantity_unit_label = '本',
    version = version + 1,
    updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE menu_item_id = 'food-kushi-kushikatsu';

-- The five current products are updated only when their known v24 identities and prices still match.
UPDATE menu_items
SET formal_name = 'ぱりぱり鶏皮',
    kitchen_alias = '鶏皮',
    price_yen = 225,
    quantity_selection_enabled = 1,
    minimum_quantity = 2,
    initial_quantity = 2,
    quantity_step = 1,
    quantity_unit_label = '本',
    price_assertion_required = 1,
    version = version + 1,
    updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE menu_item_id = 'food-chicken-torikawa'
  AND category_id = 'food-chicken'
  AND formal_name = 'ぱりぱり鶏皮（2本）'
  AND price_yen = 450
  AND is_active = 1;

UPDATE menu_items
SET quantity_selection_enabled = 1,
    minimum_quantity = 2,
    initial_quantity = 2,
    quantity_step = 1,
    quantity_unit_label = '本',
    version = version + 1,
    updated_at_ms = MAX(updated_at_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE menu_item_id IN (
  'menu-1e155a5f-bcae-4813-8a4c-e2f477d5d521',
  'menu-7c38047d-94c2-478b-946f-bd330011f571',
  'menu-878962fb-4c69-4858-84ba-7ac4e922097c',
  'menu-cb34634d-7320-4eb6-ac37-f65e1a33c493'
)
  AND category_id = 'food-kushi'
  AND is_active = 1;

PRAGMA user_version = 25;
COMMIT;
