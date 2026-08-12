-- warun-tab-order SQLite schema v2 migration.
-- This migration preserves all v1 rows and adds only the pending registration flow.

BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS trg_event_log_current_epoch;

ALTER TABLE system_state RENAME TO system_state_v1;

CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
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

INSERT INTO system_state (singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms)
SELECT singleton_id, 2, event_epoch, created_at_ms, updated_at_ms
FROM system_state_v1;

DROP TABLE system_state_v1;

CREATE TABLE registration_requests (
  request_id TEXT PRIMARY KEY
    CHECK (
      length(request_id) = 36
      AND substr(request_id, 9, 1) = '-'
      AND substr(request_id, 14, 1) = '-'
      AND substr(request_id, 19, 1) = '-'
      AND substr(request_id, 24, 1) = '-'
      AND request_id = lower(request_id)
      AND request_id NOT GLOB '*[^0-9a-f-]*'
    ),
  request_secret_hash TEXT NOT NULL UNIQUE
    CHECK (length(request_secret_hash) = 64 AND request_secret_hash NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL UNIQUE
    CHECK (
      length(device_id) = 36
      AND substr(device_id, 9, 1) = '-'
      AND substr(device_id, 14, 1) = '-'
      AND substr(device_id, 19, 1) = '-'
      AND substr(device_id, 24, 1) = '-'
      AND device_id = lower(device_id)
      AND device_id NOT GLOB '*[^0-9a-f-]*'
    ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  app_version TEXT NOT NULL CHECK (length(trim(app_version)) BETWEEN 1 AND 40),
  role TEXT NOT NULL CHECK (role = 'customer'),
  table_id INTEGER CHECK (table_id IS NULL OR table_id > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'claimed', 'expired', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  approved_at_ms INTEGER CHECK (approved_at_ms IS NULL OR approved_at_ms >= created_at_ms),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= created_at_ms),
  approved_by_device_id TEXT,
  FOREIGN KEY (table_id) REFERENCES tables(table_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_device_id) REFERENCES devices(device_id) ON UPDATE RESTRICT ON DELETE SET NULL,
  CHECK (
    (status = 'pending' AND approved_at_ms IS NULL AND claimed_at_ms IS NULL AND approved_by_device_id IS NULL)
    OR (status = 'approved' AND approved_at_ms IS NOT NULL AND claimed_at_ms IS NULL AND approved_by_device_id IS NOT NULL AND table_id IS NOT NULL)
    OR (status = 'claimed' AND approved_at_ms IS NOT NULL AND claimed_at_ms IS NOT NULL AND approved_by_device_id IS NOT NULL AND table_id IS NOT NULL)
    OR (status IN ('expired', 'cancelled') AND claimed_at_ms IS NULL)
  )
);

CREATE INDEX idx_registration_requests_status_expiry
  ON registration_requests (status, expires_at_ms, created_at_ms);
CREATE UNIQUE INDEX uq_registration_requests_approved_table
  ON registration_requests (table_id)
  WHERE status = 'approved' AND table_id IS NOT NULL;

CREATE TRIGGER trg_event_log_current_epoch
BEFORE INSERT ON event_log
WHEN NEW.event_epoch IS NOT (
  SELECT event_epoch FROM system_state WHERE singleton_id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'event epoch does not match current system state');
END;

PRAGMA user_version = 2;

COMMIT;
