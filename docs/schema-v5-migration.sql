-- warun-tab-order additive SQLite migration: schema v4 -> v5
-- Adds an explicit, optional customer-list image visibility setting.

BEGIN IMMEDIATE;

ALTER TABLE menu_item_details ADD COLUMN show_image_in_list INTEGER NOT NULL
  DEFAULT 0 CHECK (show_image_in_list IN (0, 1));

DROP TRIGGER trg_event_log_current_epoch;

CREATE TABLE system_state_v5 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 5),
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

INSERT INTO system_state_v5
SELECT singleton_id, 5, event_epoch, created_at_ms, updated_at_ms FROM system_state;
DROP TABLE system_state;
ALTER TABLE system_state_v5 RENAME TO system_state;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 5;
COMMIT;
