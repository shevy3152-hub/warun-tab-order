-- v9 -> v10: add an optional customer-facing business-hours notice.
BEGIN IMMEDIATE;

ALTER TABLE business_hours ADD COLUMN notice_text TEXT NOT NULL DEFAULT '' CHECK (length(notice_text) <= 500);
ALTER TABLE business_hours ADD COLUMN notice_enabled INTEGER NOT NULL DEFAULT 0 CHECK (notice_enabled IN (0, 1));

CREATE TEMP TABLE system_state_backup_v10 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 10),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 10, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v10;
DROP TABLE system_state_backup_v10;

PRAGMA user_version = 10;
COMMIT;
