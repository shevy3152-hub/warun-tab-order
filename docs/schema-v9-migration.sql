-- v8 -> v9: store the customer-facing business-hours setting.
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS business_hours (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  open_minutes INTEGER NOT NULL CHECK (open_minutes >= 0 AND open_minutes <= 1439),
  close_minutes INTEGER NOT NULL CHECK (close_minutes >= 0 AND close_minutes <= 1799),
  last_order_minutes INTEGER NOT NULL CHECK (last_order_minutes >= 0 AND last_order_minutes <= 1799),
  is_visible INTEGER NOT NULL CHECK (is_visible IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (open_minutes < last_order_minutes AND last_order_minutes <= close_minutes)
);

INSERT OR IGNORE INTO business_hours (
  singleton_id, open_minutes, close_minutes, last_order_minutes,
  is_visible, version, created_at_ms, updated_at_ms
) VALUES (1, 1020, 1440, 1410, 1, 1, 0, 0);

DROP TRIGGER IF EXISTS trg_event_log_current_epoch;
ALTER TABLE event_log RENAME TO event_log_v8;
CREATE TABLE event_log (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_epoch TEXT NOT NULL
    CHECK (
      length(event_epoch) = 36
      AND substr(event_epoch, 9, 1) = '-'
      AND substr(event_epoch, 14, 1) = '-'
      AND substr(event_epoch, 19, 1) = '-'
      AND substr(event_epoch, 24, 1) = '-'
      AND event_epoch = lower(event_epoch)
      AND event_epoch NOT GLOB '*[^0-9a-f-]*'
    ),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'order.created', 'order.updated', 'order.completed',
      'menu.updated', 'menu.sold_out_updated',
      'staff_call.created', 'staff_call.resolved',
      'device.paired', 'device.revoked', 'table.assignment_updated',
      'business_hours.updated'
    )
  ),
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN ('order', 'menu_item', 'staff_call', 'device', 'table', 'business_hours')
  ),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) BETWEEN 1 AND 80),
  actor_device_id TEXT,
  payload_json TEXT NOT NULL CHECK (length(trim(payload_json)) >= 2),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (actor_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE SET NULL
);
INSERT INTO event_log (
  event_id, event_epoch, event_type, aggregate_type, aggregate_id,
  actor_device_id, payload_json, created_at_ms
)
SELECT event_id, event_epoch, event_type, aggregate_type, aggregate_id,
       actor_device_id, payload_json, created_at_ms
FROM event_log_v8;
DROP TABLE event_log_v8;
CREATE INDEX idx_event_log_type_event
  ON event_log (event_epoch, event_type, event_id);
CREATE INDEX idx_event_log_aggregate
  ON event_log (event_epoch, aggregate_type, aggregate_id, event_id);

CREATE TEMP TABLE system_state_backup_v9 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 9),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 9, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v9;
DROP TABLE system_state_backup_v9;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 9;
COMMIT;
