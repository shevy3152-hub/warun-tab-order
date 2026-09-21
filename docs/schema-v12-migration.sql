-- v11 -> v12: add checkout requests and adjustable charges.
BEGIN IMMEDIATE;

CREATE TABLE checkout_requests (
  checkout_request_id TEXT PRIMARY KEY CHECK (length(checkout_request_id) = 36),
  table_session_id TEXT NOT NULL REFERENCES table_sessions(session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'ready', 'cancelled')),
  receipt_requested INTEGER NOT NULL DEFAULT 0 CHECK (receipt_requested IN (0, 1)),
  ordered_items_total_yen INTEGER NOT NULL DEFAULT 0 CHECK (ordered_items_total_yen >= 0),
  adjustments_total_yen INTEGER NOT NULL DEFAULT 0 CHECK (adjustments_total_yen >= 0),
  grand_total_yen INTEGER CHECK (grand_total_yen IS NULL OR grand_total_yen >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
  ready_at_ms INTEGER CHECK (ready_at_ms IS NULL OR ready_at_ms >= requested_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= requested_at_ms),
  CHECK (status = 'ready' OR grand_total_yen IS NULL),
  CHECK (status = 'ready' OR ready_at_ms IS NULL),
  CHECK (status <> 'ready' OR grand_total_yen IS NOT NULL),
  CHECK (status <> 'ready' OR ready_at_ms IS NOT NULL)
);

CREATE UNIQUE INDEX uq_checkout_requests_active_session
  ON checkout_requests (table_session_id)
  WHERE status IN ('requested', 'ready');
CREATE INDEX idx_checkout_requests_status_requested
  ON checkout_requests (status, requested_at_ms, checkout_request_id);
CREATE INDEX idx_checkout_requests_session
  ON checkout_requests (table_session_id, requested_at_ms, checkout_request_id);

CREATE TABLE checkout_adjustments (
  adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_request_id TEXT NOT NULL REFERENCES checkout_requests(checkout_request_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  amount_yen INTEGER NOT NULL CHECK (amount_yen >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  UNIQUE (checkout_request_id, sort_order)
);
CREATE INDEX idx_checkout_adjustments_request_sort
  ON checkout_adjustments (checkout_request_id, sort_order, adjustment_id);

DROP TRIGGER IF EXISTS trg_event_log_current_epoch;
ALTER TABLE event_log RENAME TO event_log_v11;
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
    'ride_guidance.contacts_reordered',
    'checkout.requested', 'checkout.adjustments_updated',
    'checkout.ready', 'checkout.cancelled'
  )),
  aggregate_type TEXT NOT NULL CHECK (
    aggregate_type IN ('order', 'menu_item', 'staff_call', 'device', 'table', 'business_hours', 'ride_guidance', 'checkout')
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
FROM event_log_v11;
DROP TABLE event_log_v11;
CREATE INDEX idx_event_log_type_event ON event_log (event_epoch, event_type, event_id);
CREATE INDEX idx_event_log_aggregate ON event_log (event_epoch, aggregate_type, aggregate_id, event_id);

CREATE TEMP TABLE system_state_backup_v12 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 12),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 12, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v12;
DROP TABLE system_state_backup_v12;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (SELECT event_epoch FROM system_state WHERE singleton_id = 1)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 12;
COMMIT;
