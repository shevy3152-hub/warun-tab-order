-- v12 -> v13: add immutable payment records and ready-order verification.
BEGIN IMMEDIATE;

ALTER TABLE checkout_requests ADD COLUMN ready_order_fingerprint TEXT;

CREATE TABLE payment_records (
  payment_record_id TEXT PRIMARY KEY CHECK (length(payment_record_id) = 36),
  checkout_request_id TEXT NOT NULL UNIQUE REFERENCES checkout_requests(checkout_request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  table_session_id TEXT NOT NULL REFERENCES table_sessions(session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  table_id INTEGER NOT NULL REFERENCES tables(table_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'qr', 'other')),
  confirmed_total_yen INTEGER NOT NULL CHECK (confirmed_total_yen >= 0),
  paid_at_ms INTEGER NOT NULL CHECK (paid_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('paid', 'voided')),
  voided_at_ms INTEGER CHECK (voided_at_ms IS NULL OR voided_at_ms >= paid_at_ms),
  void_reason TEXT CHECK (void_reason IS NULL OR length(trim(void_reason)) BETWEEN 1 AND 300),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= paid_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK ((status = 'paid' AND voided_at_ms IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_at_ms IS NOT NULL AND void_reason IS NOT NULL))
);

CREATE INDEX idx_payment_records_paid_at
  ON payment_records (paid_at_ms DESC, payment_record_id DESC);
CREATE INDEX idx_payment_records_session
  ON payment_records (table_session_id, paid_at_ms DESC, payment_record_id DESC);

CREATE TABLE payment_order_items (
  payment_order_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_record_id TEXT NOT NULL REFERENCES payment_records(payment_record_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id INTEGER NOT NULL,
  formal_name_snapshot TEXT NOT NULL CHECK (length(trim(formal_name_snapshot)) BETWEEN 1 AND 200),
  variant_name_snapshot TEXT,
  variant_volume_snapshot TEXT,
  temperature_snapshot TEXT,
  serving_option_name_snapshot TEXT,
  unit_price_yen_snapshot INTEGER NOT NULL CHECK (unit_price_yen_snapshot >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  line_total_yen INTEGER NOT NULL CHECK (line_total_yen >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  UNIQUE (payment_record_id, sort_order)
);
CREATE INDEX idx_payment_order_items_record_sort
  ON payment_order_items (payment_record_id, sort_order, payment_order_item_id);

CREATE TABLE payment_adjustments (
  payment_adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_record_id TEXT NOT NULL REFERENCES payment_records(payment_record_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  amount_yen INTEGER NOT NULL CHECK (amount_yen >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  UNIQUE (payment_record_id, sort_order)
);
CREATE INDEX idx_payment_adjustments_record_sort
  ON payment_adjustments (payment_record_id, sort_order, payment_adjustment_id);

DROP TRIGGER IF EXISTS trg_event_log_current_epoch;
ALTER TABLE event_log RENAME TO event_log_v12;
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
    'checkout.ready', 'checkout.cancelled', 'checkout.paid', 'checkout.voided'
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
FROM event_log_v12;
DROP TABLE event_log_v12;
CREATE INDEX idx_event_log_type_event ON event_log (event_epoch, event_type, event_id);
CREATE INDEX idx_event_log_aggregate ON event_log (event_epoch, aggregate_type, aggregate_id, event_id);

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (SELECT event_epoch FROM system_state WHERE singleton_id = 1)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

CREATE TEMP TABLE system_state_backup_v13 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 13),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 13, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v13;
DROP TABLE system_state_backup_v13;

PRAGMA user_version = 13;
COMMIT;
