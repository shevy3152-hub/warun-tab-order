-- Add reversible archival metadata for menu items. Existing products remain active as-is.
-- Product images and order history are intentionally untouched.

BEGIN IMMEDIATE;

ALTER TABLE menu_items
  ADD COLUMN archived_at_ms INTEGER
  CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0);

CREATE INDEX idx_menu_items_archived_category
  ON menu_items (archived_at_ms, category_id, sort_order, menu_item_id);

PRAGMA user_version = 23;
COMMIT;
