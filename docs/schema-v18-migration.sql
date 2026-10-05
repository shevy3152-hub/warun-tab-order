-- Adds per-open-session customer menu grants. Existing products stay visible
-- to every table unless an administrator explicitly changes their mode.

BEGIN IMMEDIATE;

ALTER TABLE menu_items
  ADD COLUMN customer_visibility_mode TEXT NOT NULL DEFAULT 'all_tables'
  CHECK (customer_visibility_mode IN ('all_tables', 'per_session'));

CREATE TABLE session_menu_item_grants (
  session_id TEXT NOT NULL,
  menu_item_id TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  PRIMARY KEY (session_id, menu_item_id),
  FOREIGN KEY (session_id) REFERENCES table_sessions(session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX idx_session_menu_item_grants_item_session
  ON session_menu_item_grants (menu_item_id, session_id);

PRAGMA user_version = 18;
COMMIT;
