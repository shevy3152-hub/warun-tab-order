BEGIN IMMEDIATE;

ALTER TABLE order_items
  ADD COLUMN adjusted_unit_price_yen INTEGER
  CHECK (
    adjusted_unit_price_yen IS NULL
    OR adjusted_unit_price_yen BETWEEN 0 AND unit_price_yen_snapshot
  );

ALTER TABLE payment_order_items
  ADD COLUMN adjusted_unit_price_yen INTEGER
  CHECK (adjusted_unit_price_yen IS NULL OR adjusted_unit_price_yen BETWEEN 0 AND unit_price_yen_snapshot);
ALTER TABLE payment_order_items
  ADD COLUMN current_unit_price_yen INTEGER
  CHECK (current_unit_price_yen BETWEEN 0 AND unit_price_yen_snapshot);

CREATE TABLE order_item_price_adjustments (
  adjustment_id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_item_id INTEGER NOT NULL,
  previous_unit_price_yen INTEGER NOT NULL CHECK (previous_unit_price_yen >= 0),
  adjusted_unit_price_yen INTEGER NOT NULL CHECK (adjusted_unit_price_yen >= 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  actor_device_id TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id) REFERENCES order_items(order_item_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (actor_device_id) REFERENCES devices(device_id) ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE INDEX idx_order_item_price_adjustments_item
  ON order_item_price_adjustments (order_item_id, adjustment_id);

CREATE TEMP TABLE system_state_backup_v14 AS SELECT * FROM system_state;
DROP TABLE system_state;
CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 14),
  event_epoch TEXT NOT NULL UNIQUE CHECK (length(event_epoch) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);
INSERT INTO system_state
  (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 14, event_epoch, created_at_ms, updated_at_ms
FROM system_state_backup_v14;
DROP TABLE system_state_backup_v14;

PRAGMA user_version = 14;
COMMIT;
