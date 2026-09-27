BEGIN IMMEDIATE;

ALTER TABLE orders
  ADD COLUMN order_origin TEXT NOT NULL DEFAULT 'customer'
  CHECK (order_origin IN ('customer', 'kitchen_addition'));

ALTER TABLE orders
  ADD COLUMN created_by_device_id TEXT
  REFERENCES devices(device_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD COLUMN quantity_reduced INTEGER NOT NULL DEFAULT 0
  CHECK (quantity_reduced BETWEEN 0 AND quantity);

ALTER TABLE order_item_cancellation_events
  ADD COLUMN operation_id TEXT
  CHECK (
    operation_id IS NULL
    OR (
      length(operation_id) = 36
      AND substr(operation_id, 9, 1) = '-'
      AND substr(operation_id, 14, 1) = '-'
      AND substr(operation_id, 19, 1) = '-'
      AND substr(operation_id, 24, 1) = '-'
      AND operation_id = lower(operation_id)
      AND operation_id NOT GLOB '*[^0-9a-f-]*'
    )
  );

CREATE UNIQUE INDEX idx_order_item_cancellation_events_operation
  ON order_item_cancellation_events (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE TABLE order_item_quantity_events (
  quantity_event_id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE
    CHECK (
      length(operation_id) = 36
      AND substr(operation_id, 9, 1) = '-'
      AND substr(operation_id, 14, 1) = '-'
      AND substr(operation_id, 19, 1) = '-'
      AND substr(operation_id, 24, 1) = '-'
      AND operation_id = lower(operation_id)
      AND operation_id NOT GLOB '*[^0-9a-f-]*'
    ),
  order_id TEXT NOT NULL,
  order_item_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'decreased')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta IN (-1, 1)),
  previous_billable_quantity INTEGER NOT NULL CHECK (previous_billable_quantity BETWEEN 1 AND 99),
  next_billable_quantity INTEGER NOT NULL CHECK (next_billable_quantity BETWEEN 1 AND 99),
  related_order_id TEXT,
  related_order_item_id INTEGER,
  actor_device_id TEXT NOT NULL,
  actor_label_snapshot TEXT NOT NULL CHECK (length(trim(actor_label_snapshot)) BETWEEN 1 AND 120),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  is_served_snapshot INTEGER NOT NULL CHECK (is_served_snapshot IN (0, 1)),
  served_at_ms_snapshot INTEGER,
  served_by_device_id_snapshot TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id) REFERENCES order_items(order_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (related_order_id) REFERENCES orders(order_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (related_order_item_id) REFERENCES order_items(order_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (actor_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (served_by_device_id_snapshot) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (is_served_snapshot = 0 AND served_at_ms_snapshot IS NULL AND served_by_device_id_snapshot IS NULL)
    OR (is_served_snapshot = 1 AND served_at_ms_snapshot IS NOT NULL AND served_by_device_id_snapshot IS NOT NULL)
  ),
  CHECK (
    (action = 'added' AND quantity_delta = 1
      AND next_billable_quantity = previous_billable_quantity
      AND related_order_id IS NOT NULL AND related_order_item_id IS NOT NULL)
    OR
    (action = 'decreased' AND quantity_delta = -1
      AND next_billable_quantity = previous_billable_quantity - 1
      AND previous_billable_quantity >= 2
      AND related_order_id IS NULL AND related_order_item_id IS NULL)
  )
);

CREATE INDEX idx_order_item_quantity_events_item
  ON order_item_quantity_events (order_item_id, quantity_event_id);

DROP TRIGGER trg_orders_server_assignment_insert;
CREATE TRIGGER trg_orders_server_assignment_insert
BEFORE INSERT ON orders
WHEN NOT (
  (NEW.order_origin = 'customer'
    AND NEW.created_by_device_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM tables AS t
      JOIN devices AS d ON d.device_id = t.assigned_customer_device_id
      WHERE t.table_id = NEW.table_id
        AND t.table_id = NEW.table_number_snapshot
        AND t.is_active = 1
        AND d.device_id = NEW.customer_device_id
        AND d.role = 'customer'
        AND d.status = 'active'
    ))
  OR
  (NEW.order_origin = 'kitchen_addition'
    AND NEW.created_by_device_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM devices AS d
      WHERE d.device_id = NEW.created_by_device_id
        AND d.role IN ('kitchen', 'admin')
        AND d.status = 'active'
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'order origin is not authorized for this table');
END;

DROP TRIGGER trg_orders_immutable_identity;
CREATE TRIGGER trg_orders_immutable_identity
BEFORE UPDATE OF
  client_order_id,
  request_fingerprint,
  canonical_request_json,
  customer_device_id,
  table_id,
  table_number_snapshot,
  accepted_at_ms,
  order_origin,
  created_by_device_id
ON orders
WHEN
  NEW.client_order_id IS NOT OLD.client_order_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.canonical_request_json IS NOT OLD.canonical_request_json
  OR NEW.customer_device_id IS NOT OLD.customer_device_id
  OR NEW.table_id IS NOT OLD.table_id
  OR NEW.table_number_snapshot IS NOT OLD.table_number_snapshot
  OR NEW.accepted_at_ms IS NOT OLD.accepted_at_ms
  OR NEW.order_origin IS NOT OLD.order_origin
  OR NEW.created_by_device_id IS NOT OLD.created_by_device_id
BEGIN
  SELECT RAISE(ABORT, 'order identity and acceptance snapshots are immutable');
END;

CREATE TRIGGER trg_order_item_quantity_events_immutable_update
BEFORE UPDATE ON order_item_quantity_events
BEGIN
  SELECT RAISE(ABORT, 'order item quantity history is immutable');
END;

CREATE TRIGGER trg_order_item_quantity_events_immutable_delete
BEFORE DELETE ON order_item_quantity_events
BEGIN
  SELECT RAISE(ABORT, 'order item quantity history is immutable');
END;

CREATE TEMP TABLE system_state_backup_v16 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 16),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 16, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v16;
DROP TABLE system_state_backup_v16;

PRAGMA user_version = 16;
COMMIT;
