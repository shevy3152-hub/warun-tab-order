BEGIN IMMEDIATE;

ALTER TABLE order_items
  ADD COLUMN is_cancelled INTEGER NOT NULL DEFAULT 0
  CHECK (is_cancelled IN (0, 1));

CREATE INDEX idx_order_items_order_cancelled_served
  ON order_items (order_id, is_cancelled, is_served, line_index);

CREATE TABLE order_item_cancellation_events (
  cancellation_event_id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_item_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancelled', 'restored')),
  actor_device_id TEXT NOT NULL,
  actor_label_snapshot TEXT NOT NULL CHECK (length(trim(actor_label_snapshot)) BETWEEN 1 AND 120),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 300),
  is_served_snapshot INTEGER NOT NULL CHECK (is_served_snapshot IN (0, 1)),
  served_at_ms_snapshot INTEGER,
  served_by_device_id_snapshot TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id) REFERENCES order_items(order_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (actor_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (served_by_device_id_snapshot) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (is_served_snapshot = 0 AND served_at_ms_snapshot IS NULL AND served_by_device_id_snapshot IS NULL)
    OR (is_served_snapshot = 1 AND served_at_ms_snapshot IS NOT NULL AND served_by_device_id_snapshot IS NOT NULL)
  )
);

CREATE INDEX idx_order_item_cancellation_events_item
  ON order_item_cancellation_events (order_item_id, cancellation_event_id);

CREATE TRIGGER trg_order_item_cancellation_events_immutable_update
BEFORE UPDATE ON order_item_cancellation_events
BEGIN
  SELECT RAISE(ABORT, 'order item cancellation history is immutable');
END;

CREATE TRIGGER trg_order_item_cancellation_events_immutable_delete
BEFORE DELETE ON order_item_cancellation_events
BEGIN
  SELECT RAISE(ABORT, 'order item cancellation history is immutable');
END;

CREATE TEMP TABLE system_state_backup_v15 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 15),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 15, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v15;
DROP TABLE system_state_backup_v15;

PRAGMA user_version = 15;
COMMIT;
