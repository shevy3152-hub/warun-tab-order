-- Link newly created staff calls to the current table visit session.
-- Existing calls keep a NULL session reference because their originating
-- visit cannot be inferred safely from the current open session.

BEGIN IMMEDIATE;

ALTER TABLE staff_calls
  ADD COLUMN table_session_id TEXT
  REFERENCES table_sessions(session_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE INDEX idx_staff_calls_session_created
  ON staff_calls (table_session_id, created_at_ms);

CREATE TRIGGER trg_staff_calls_session_valid_insert
BEFORE INSERT ON staff_calls
WHEN NEW.table_session_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM table_sessions AS s
  WHERE s.session_id = NEW.table_session_id
    AND s.table_id = NEW.table_id
    AND s.closed_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'staff call requires the current open table session');
END;

CREATE TRIGGER trg_staff_calls_session_immutable_origin
BEFORE UPDATE OF table_session_id ON staff_calls
WHEN NEW.table_session_id IS NOT OLD.table_session_id
BEGIN
  SELECT RAISE(ABORT, 'staff call session origin is immutable');
END;

PRAGMA user_version = 22;
COMMIT;
