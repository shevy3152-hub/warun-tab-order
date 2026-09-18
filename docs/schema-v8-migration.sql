-- v7 -> v8: store ordering policy per menu item, independent of sold-out state.
BEGIN IMMEDIATE;

ALTER TABLE menu_items ADD COLUMN ordering_mode TEXT NOT NULL DEFAULT 'normal'
  CHECK (ordering_mode IN ('normal', 'reservation_only'));

CREATE TEMP TABLE system_state_backup_v8 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 8),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 8, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v8;
DROP TABLE system_state_backup_v8;

PRAGMA user_version = 8;
COMMIT;
