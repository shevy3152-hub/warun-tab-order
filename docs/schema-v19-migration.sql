-- Adds persistent per-menu-item table visibility without rebuilding any table.

BEGIN IMMEDIATE;

ALTER TABLE menu_items
  ADD COLUMN table_visibility_mode TEXT NOT NULL DEFAULT 'all_tables'
  CHECK (table_visibility_mode IN ('all_tables', 'selected_tables', 'except_selected_tables'));

CREATE TABLE menu_item_table_visibility (
  menu_item_id TEXT NOT NULL,
  table_id INTEGER NOT NULL,
  PRIMARY KEY (menu_item_id, table_id),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_menu_item_table_visibility_table_menu_item
  ON menu_item_table_visibility (table_id, menu_item_id);

PRAGMA user_version = 19;
COMMIT;
