-- Additive image composition layouts. Existing products intentionally have no rows.
BEGIN IMMEDIATE;

CREATE TABLE menu_item_image_layouts (
  menu_item_id TEXT NOT NULL,
  usage TEXT NOT NULL CHECK (usage IN ('thumbnail', 'detail')),
  scale REAL NOT NULL DEFAULT 1 CHECK (scale >= 0.5 AND scale <= 4.0),
  position_x REAL NOT NULL DEFAULT 0 CHECK (position_x >= -1 AND position_x <= 1),
  position_y REAL NOT NULL DEFAULT 0 CHECK (position_y >= -1 AND position_y <= 1),
  rotation REAL NOT NULL DEFAULT 0 CHECK (rotation >= -15 AND rotation <= 15),
  fit TEXT NOT NULL DEFAULT 'contain' CHECK (fit IN ('contain', 'cover')),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (menu_item_id, usage),
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX idx_menu_item_image_layouts_item
  ON menu_item_image_layouts (menu_item_id, usage);

DROP TRIGGER trg_event_log_current_epoch;
CREATE TABLE system_state_v6 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 6),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state_v6 SELECT singleton_id, 6, event_epoch, created_at_ms, updated_at_ms FROM system_state;
DROP TABLE system_state;
ALTER TABLE system_state_v6 RENAME TO system_state;
CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (SELECT event_epoch FROM system_state WHERE singleton_id = 1)
BEGIN SELECT RAISE(ABORT, 'event epoch does not match current system state'); END;

PRAGMA user_version = 6;
COMMIT;
