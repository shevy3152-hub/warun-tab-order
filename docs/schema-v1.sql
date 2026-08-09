-- warun-tab-order SQLite schema v1
-- All timestamps are UTC Unix epoch milliseconds. All monetary values are integer yen.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;

BEGIN IMMEDIATE;

CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
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

INSERT INTO system_state (
  singleton_id,
  schema_version,
  event_epoch,
  created_at_ms,
  updated_at_ms
)
SELECT
  1,
  1,
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    '8' || substr(hex(randomblob(2)), 2, 3) || '-' ||
    hex(randomblob(6))
  ),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY
    CHECK (
      length(device_id) = 36
      AND substr(device_id, 9, 1) = '-'
      AND substr(device_id, 14, 1) = '-'
      AND substr(device_id, 19, 1) = '-'
      AND substr(device_id, 24, 1) = '-'
      AND device_id = lower(device_id)
      AND device_id NOT GLOB '*[^0-9a-f-]*'
    ),
  role TEXT NOT NULL CHECK (role IN ('customer', 'kitchen', 'admin')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  app_version TEXT,
  paired_at_ms INTEGER NOT NULL CHECK (paired_at_ms >= 0),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (status = 'active' AND revoked_at_ms IS NULL)
    OR (status = 'revoked' AND revoked_at_ms IS NOT NULL)
  )
);

CREATE TABLE tables (
  table_id INTEGER PRIMARY KEY CHECK (table_id > 0),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 40),
  assigned_customer_device_id TEXT UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (assigned_customer_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY
    CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL CHECK (role IN ('customer', 'kitchen', 'admin')),
  table_id INTEGER,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  created_by_device_id TEXT,
  used_by_device_id TEXT UNIQUE,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  used_at_ms INTEGER CHECK (used_at_ms IS NULL OR used_at_ms >= created_at_ms),
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  FOREIGN KEY (used_by_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (
    (role = 'customer' AND table_id IS NOT NULL)
    OR (role IN ('kitchen', 'admin') AND table_id IS NULL)
  ),
  CHECK (
    (used_at_ms IS NULL AND used_by_device_id IS NULL)
    OR (used_at_ms IS NOT NULL AND used_by_device_id IS NOT NULL)
  )
);

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY
    CHECK (
      length(category_id) BETWEEN 1 AND 64
      AND category_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE TABLE menu_items (
  menu_item_id TEXT PRIMARY KEY
    CHECK (
      length(menu_item_id) BETWEEN 1 AND 64
      AND menu_item_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  category_id TEXT NOT NULL,
  formal_name TEXT NOT NULL CHECK (length(trim(formal_name)) BETWEEN 1 AND 120),
  kitchen_alias TEXT NOT NULL CHECK (length(trim(kitchen_alias)) BETWEEN 1 AND 40),
  description TEXT NOT NULL DEFAULT '',
  price_yen INTEGER NOT NULL CHECK (price_yen BETWEEN 0 AND 10000000),
  is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  image_uri TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (category_id) REFERENCES categories(category_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE orders (
  order_id TEXT PRIMARY KEY
    CHECK (
      length(order_id) = 36
      AND substr(order_id, 9, 1) = '-'
      AND substr(order_id, 14, 1) = '-'
      AND substr(order_id, 19, 1) = '-'
      AND substr(order_id, 24, 1) = '-'
      AND order_id = lower(order_id)
      AND order_id NOT GLOB '*[^0-9a-f-]*'
    ),
  client_order_id TEXT NOT NULL UNIQUE
    CHECK (
      length(client_order_id) = 36
      AND substr(client_order_id, 9, 1) = '-'
      AND substr(client_order_id, 14, 1) = '-'
      AND substr(client_order_id, 19, 1) = '-'
      AND substr(client_order_id, 24, 1) = '-'
      AND client_order_id = lower(client_order_id)
      AND client_order_id NOT GLOB '*[^0-9a-f-]*'
    ),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_request_json TEXT NOT NULL CHECK (length(trim(canonical_request_json)) >= 2),
  customer_device_id TEXT NOT NULL,
  table_id INTEGER NOT NULL,
  table_number_snapshot INTEGER NOT NULL CHECK (table_number_snapshot > 0),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'completed')),
  total_amount_yen INTEGER NOT NULL CHECK (total_amount_yen BETWEEN 0 AND 100000000),
  client_created_at_ms INTEGER CHECK (client_created_at_ms IS NULL OR client_created_at_ms >= 0),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= accepted_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (customer_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (status IN ('new', 'active') AND completed_at_ms IS NULL)
    OR (status = 'completed' AND completed_at_ms IS NOT NULL)
  )
);

CREATE TABLE order_items (
  order_item_id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  menu_item_id TEXT,
  formal_name_snapshot TEXT NOT NULL
    CHECK (length(trim(formal_name_snapshot)) BETWEEN 1 AND 120),
  kitchen_alias_snapshot TEXT NOT NULL
    CHECK (length(trim(kitchen_alias_snapshot)) BETWEEN 1 AND 40),
  unit_price_yen_snapshot INTEGER NOT NULL
    CHECK (unit_price_yen_snapshot BETWEEN 0 AND 10000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total_yen INTEGER NOT NULL
    CHECK (
      line_total_yen BETWEEN 0 AND 100000000
      AND line_total_yen = unit_price_yen_snapshot * quantity
    ),
  is_served INTEGER NOT NULL DEFAULT 0 CHECK (is_served IN (0, 1)),
  served_at_ms INTEGER CHECK (served_at_ms IS NULL OR served_at_ms >= 0),
  served_by_device_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(menu_item_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (served_by_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (order_id, line_index),
  CHECK (
    (is_served = 0 AND served_at_ms IS NULL AND served_by_device_id IS NULL)
    OR (is_served = 1 AND served_at_ms IS NOT NULL AND served_by_device_id IS NOT NULL)
  )
);

CREATE TABLE staff_calls (
  staff_call_id TEXT PRIMARY KEY
    CHECK (
      length(staff_call_id) = 36
      AND substr(staff_call_id, 9, 1) = '-'
      AND substr(staff_call_id, 14, 1) = '-'
      AND substr(staff_call_id, 19, 1) = '-'
      AND substr(staff_call_id, 24, 1) = '-'
      AND staff_call_id = lower(staff_call_id)
      AND staff_call_id NOT GLOB '*[^0-9a-f-]*'
    ),
  client_call_id TEXT NOT NULL UNIQUE
    CHECK (
      length(client_call_id) = 36
      AND substr(client_call_id, 9, 1) = '-'
      AND substr(client_call_id, 14, 1) = '-'
      AND substr(client_call_id, 19, 1) = '-'
      AND substr(client_call_id, 24, 1) = '-'
      AND client_call_id = lower(client_call_id)
      AND client_call_id NOT GLOB '*[^0-9a-f-]*'
    ),
  customer_device_id TEXT NOT NULL,
  table_id INTEGER NOT NULL,
  table_number_snapshot INTEGER NOT NULL CHECK (table_number_snapshot > 0),
  call_type TEXT NOT NULL DEFAULT 'staff' CHECK (call_type IN ('staff')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  resolved_by_device_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (customer_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (status = 'open' AND resolved_at_ms IS NULL AND resolved_by_device_id IS NULL)
    OR (status = 'resolved' AND resolved_at_ms IS NOT NULL AND resolved_by_device_id IS NOT NULL)
  )
);

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
      'order.created',
      'order.updated',
      'order.completed',
      'menu.updated',
      'menu.sold_out_updated',
      'staff_call.created',
      'staff_call.resolved',
      'device.paired',
      'device.revoked',
      'table.assignment_updated'
    )
  ),
  aggregate_type TEXT NOT NULL
    CHECK (aggregate_type IN ('order', 'menu_item', 'staff_call', 'device', 'table')),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) BETWEEN 1 AND 80),
  actor_device_id TEXT,
  payload_json TEXT NOT NULL CHECK (length(trim(payload_json)) >= 2),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (actor_device_id) REFERENCES devices(device_id)
    ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE INDEX idx_devices_status_role
  ON devices (status, role);
CREATE INDEX idx_pairing_codes_expiry_unused
  ON pairing_codes (expires_at_ms, used_at_ms);
CREATE INDEX idx_categories_visible_sort
  ON categories (is_visible, sort_order, category_id);
CREATE INDEX idx_menu_items_category_sort
  ON menu_items (category_id, is_active, sort_order, menu_item_id);
CREATE INDEX idx_menu_items_sold_out
  ON menu_items (is_active, is_sold_out);
CREATE INDEX idx_orders_status_accepted
  ON orders (status, accepted_at_ms, order_id);
CREATE INDEX idx_orders_table_status
  ON orders (table_id, status, accepted_at_ms);
CREATE INDEX idx_orders_customer_device
  ON orders (customer_device_id, accepted_at_ms);
CREATE INDEX idx_order_items_order_served
  ON order_items (order_id, is_served, line_index);
CREATE UNIQUE INDEX uq_order_items_order_menu
  ON order_items (order_id, menu_item_id)
  WHERE menu_item_id IS NOT NULL;
CREATE INDEX idx_staff_calls_status_created
  ON staff_calls (status, created_at_ms);
CREATE INDEX idx_staff_calls_table_status
  ON staff_calls (table_id, status, created_at_ms);
CREATE INDEX idx_event_log_type_event
  ON event_log (event_epoch, event_type, event_id);
CREATE INDEX idx_event_log_aggregate
  ON event_log (event_epoch, aggregate_type, aggregate_id, event_id);

CREATE TRIGGER trg_tables_assignment_insert_valid
BEFORE INSERT ON tables
WHEN
  NEW.assigned_customer_device_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM devices
    WHERE device_id = NEW.assigned_customer_device_id
      AND role = 'customer'
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'table assignment requires an active customer device');
END;

CREATE TRIGGER trg_tables_assignment_update_valid
BEFORE UPDATE OF assigned_customer_device_id ON tables
WHEN
  NEW.assigned_customer_device_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM devices
    WHERE device_id = NEW.assigned_customer_device_id
      AND role = 'customer'
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'table assignment requires an active customer device');
END;

CREATE TRIGGER trg_orders_server_assignment_insert
BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1
  FROM tables AS t
  JOIN devices AS d ON d.device_id = t.assigned_customer_device_id
  WHERE t.table_id = NEW.table_id
    AND t.table_id = NEW.table_number_snapshot
    AND t.is_active = 1
    AND d.device_id = NEW.customer_device_id
    AND d.role = 'customer'
    AND d.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'order device is not assigned to the submitted table');
END;

CREATE TRIGGER trg_staff_calls_server_assignment_insert
BEFORE INSERT ON staff_calls
WHEN NOT EXISTS (
  SELECT 1
  FROM tables AS t
  JOIN devices AS d ON d.device_id = t.assigned_customer_device_id
  WHERE t.table_id = NEW.table_id
    AND t.table_id = NEW.table_number_snapshot
    AND t.is_active = 1
    AND d.device_id = NEW.customer_device_id
    AND d.role = 'customer'
    AND d.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'staff call device is not assigned to the submitted table');
END;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

CREATE TRIGGER trg_orders_immutable_identity
BEFORE UPDATE OF
  client_order_id,
  request_fingerprint,
  canonical_request_json,
  customer_device_id,
  table_id,
  table_number_snapshot,
  accepted_at_ms
ON orders
WHEN
  NEW.client_order_id IS NOT OLD.client_order_id
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.canonical_request_json IS NOT OLD.canonical_request_json
  OR NEW.customer_device_id IS NOT OLD.customer_device_id
  OR NEW.table_id IS NOT OLD.table_id
  OR NEW.table_number_snapshot IS NOT OLD.table_number_snapshot
  OR NEW.accepted_at_ms IS NOT OLD.accepted_at_ms
BEGIN
  SELECT RAISE(ABORT, 'order identity and acceptance snapshots are immutable');
END;

CREATE TRIGGER trg_order_items_immutable_snapshots
BEFORE UPDATE OF
  order_id,
  line_index,
  menu_item_id,
  formal_name_snapshot,
  kitchen_alias_snapshot,
  unit_price_yen_snapshot,
  quantity,
  line_total_yen,
  created_at_ms
ON order_items
WHEN
  NEW.order_id IS NOT OLD.order_id
  OR NEW.line_index IS NOT OLD.line_index
  OR NEW.menu_item_id IS NOT OLD.menu_item_id
  OR NEW.formal_name_snapshot IS NOT OLD.formal_name_snapshot
  OR NEW.kitchen_alias_snapshot IS NOT OLD.kitchen_alias_snapshot
  OR NEW.unit_price_yen_snapshot IS NOT OLD.unit_price_yen_snapshot
  OR NEW.quantity IS NOT OLD.quantity
  OR NEW.line_total_yen IS NOT OLD.line_total_yen
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'order item identity and price/name snapshots are immutable');
END;

CREATE TRIGGER trg_completed_order_items_read_only
BEFORE UPDATE OF is_served, served_at_ms, served_by_device_id
ON order_items
WHEN (SELECT status FROM orders WHERE order_id = OLD.order_id) = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed order items are read-only');
END;

CREATE TRIGGER trg_staff_calls_immutable_origin
BEFORE UPDATE OF
  client_call_id,
  customer_device_id,
  table_id,
  table_number_snapshot,
  call_type,
  created_at_ms
ON staff_calls
WHEN
  NEW.client_call_id IS NOT OLD.client_call_id
  OR NEW.customer_device_id IS NOT OLD.customer_device_id
  OR NEW.table_id IS NOT OLD.table_id
  OR NEW.table_number_snapshot IS NOT OLD.table_number_snapshot
  OR NEW.call_type IS NOT OLD.call_type
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'staff call origin snapshot is immutable');
END;

PRAGMA user_version = 1;

COMMIT;
