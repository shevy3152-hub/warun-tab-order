-- v10 -> v11: add taxi / driver-service guidance settings and contacts.
BEGIN IMMEDIATE;

CREATE TABLE store_pickup_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  pickup_label TEXT NOT NULL DEFAULT '' CHECK (length(pickup_label) <= 100),
  pickup_address TEXT NOT NULL DEFAULT '' CHECK (length(pickup_address) <= 300),
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);
INSERT INTO store_pickup_settings (singleton_id, pickup_label, pickup_address, version, updated_at_ms)
VALUES (1, '', '', 0, 0);

CREATE TABLE ride_service_contacts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  type TEXT NOT NULL CHECK (type IN ('taxi', 'driver_service')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone TEXT NOT NULL CHECK (
    length(phone) BETWEEN 1 AND 30
    AND phone NOT GLOB '*[^0-9 ()+-]*'
  ),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE INDEX idx_ride_service_contacts_type_visible_sort
  ON ride_service_contacts (type, is_visible, sort_order, id);
CREATE INDEX idx_ride_service_contacts_type_sort
  ON ride_service_contacts (type, sort_order, id);

DROP TRIGGER IF EXISTS trg_event_log_current_epoch;
ALTER TABLE event_log RENAME TO event_log_v10;
CREATE TABLE event_log (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_epoch TEXT NOT NULL CHECK (
    length(event_epoch) = 36
    AND substr(event_epoch, 9, 1) = '-'
    AND substr(event_epoch, 14, 1) = '-'
    AND substr(event_epoch, 19, 1) = '-'
    AND substr(event_epoch, 24, 1) = '-'
    AND event_epoch = lower(event_epoch)
    AND event_epoch NOT GLOB '*[^0-9a-f-]*'
  ),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order.created', 'order.updated', 'order.completed',
    'menu.updated', 'menu.sold_out_updated',
    'staff_call.created', 'staff_call.resolved',
    'device.paired', 'device.revoked', 'table.assignment_updated',
    'business_hours.updated',
    'ride_guidance.pickup_updated', 'ride_guidance.contact_created',
    'ride_guidance.contact_updated', 'ride_guidance.contact_deleted',
    'ride_guidance.contacts_reordered'
  )),
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN ('order', 'menu_item', 'staff_call', 'device', 'table', 'business_hours', 'ride_guidance')
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
FROM event_log_v10;
DROP TABLE event_log_v10;
CREATE INDEX idx_event_log_type_event ON event_log (event_epoch, event_type, event_id);
CREATE INDEX idx_event_log_aggregate ON event_log (event_epoch, aggregate_type, aggregate_id, event_id);

CREATE TEMP TABLE system_state_backup_v11 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 11),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 11, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v11;
DROP TABLE system_state_backup_v11;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (SELECT event_epoch FROM system_state WHERE singleton_id = 1)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 11;
COMMIT;
