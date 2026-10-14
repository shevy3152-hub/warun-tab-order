import { randomUUID } from 'node:crypto';
import { createCustomerVisitContextId } from '../orders/visit-context.mjs';
import { STAFF_CALL_ERROR_CODES, StaffCallRepositoryError } from './staff-call-errors.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISIT_CONTEXT = /^v1_[0-9a-f]{64}$/;

function fail(code, message, options) {
  throw new StaffCallRepositoryError(code, message, options);
}

export function createStaffCallRepository({ database, now = Date.now, idFactory = randomUUID, sessionIdFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'A ready SQLite database is required.');
  }
  if (typeof now !== 'function' || typeof idFactory !== 'function' || typeof sessionIdFactory !== 'function') {
    fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'Staff call repository factories are invalid.');
  }

  let statements;
  try {
    statements = {
      existingByClientId: database.prepare('SELECT * FROM staff_calls WHERE client_call_id = ?'),
      device: database.prepare('SELECT device_id, role, status FROM devices WHERE device_id = ?'),
      assignedTable: database.prepare(`
        SELECT table_id, is_active, version FROM tables WHERE assigned_customer_device_id = ?
      `),
      lastClosedSession: database.prepare(`
        SELECT session_id FROM table_sessions WHERE table_id = ? AND closed_at_ms IS NOT NULL
        ORDER BY rowid DESC LIMIT 1
      `),
      openSession: database.prepare(`
        SELECT session_id FROM table_sessions WHERE table_id = ? AND closed_at_ms IS NULL
      `),
      insertSession: database.prepare(`
        INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, 1, ?, ?)
      `),
      insertCall: database.prepare(`
        INSERT INTO staff_calls (
          staff_call_id, client_call_id, customer_device_id, table_id, table_number_snapshot,
          call_type, status, created_at_ms, version, table_session_id
        ) VALUES (?, ?, ?, ?, ?, 'staff', 'open', ?, 1, ?)
      `),
      eventEpoch: database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1'),
      insertEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms
        ) VALUES (?, 'staff_call.created', 'staff_call', ?, ?, ?, ?)
      `),
      resolvedEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms
        ) VALUES (?, 'staff_call.resolved', 'staff_call', ?, ?, ?, ?)
      `),
      callById: database.prepare('SELECT * FROM staff_calls WHERE staff_call_id = ?'),
      resolveCall: database.prepare(`
        UPDATE staff_calls
        SET status = 'resolved', resolved_at_ms = ?, resolved_by_device_id = ?, version = version + 1
        WHERE staff_call_id = ? AND status = 'open' AND version = ?
      `),
      resolvingDevice: database.prepare('SELECT role, status FROM devices WHERE device_id = ?'),
    };
  } catch (error) {
    fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'Failed to prepare staff call repository statements.', { cause: error });
  }

  let closed = false;

  function createStaffCall({ principal, clientCallId, visitContextId } = {}) {
    if (closed) fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'The staff call repository is closed.');
    const deviceId = typeof principal?.deviceId === 'string' ? principal.deviceId.toLowerCase() : '';
    const normalizedCallId = typeof clientCallId === 'string' ? clientCallId.toLowerCase() : '';
    if (!UUID_V4.test(normalizedCallId) || typeof visitContextId !== 'string' || !VISIT_CONTEXT.test(visitContextId)) {
      fail(STAFF_CALL_ERROR_CODES.INVALID_REQUEST, 'The staff call request is invalid.');
    }
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;

      const existing = statements.existingByClientId.get(normalizedCallId);
      if (existing) {
        if (existing.customer_device_id !== deviceId) {
          fail(STAFF_CALL_ERROR_CODES.CALL_CONFLICT, 'The client call id conflicts with an existing staff call.');
        }
        database.exec('COMMIT;');
        transactionOpen = false;
        return { idempotencyResult: 'replayed', staffCall: mapCall(existing) };
      }

      const device = statements.device.get(deviceId);
      if (!device) fail(STAFF_CALL_ERROR_CODES.DEVICE_NOT_REGISTERED, 'The authenticated device is not registered.');
      if (device.role !== 'customer' || device.status !== 'active') {
        fail(STAFF_CALL_ERROR_CODES.DEVICE_NOT_AUTHORIZED, 'An active customer device is required.');
      }
      const table = statements.assignedTable.get(deviceId);
      if (!table || table.is_active !== 1) {
        fail(STAFF_CALL_ERROR_CODES.DEVICE_NOT_ASSIGNED, 'The customer device is not assigned to an active table.');
      }
      const currentVisitContextId = createCustomerVisitContextId({
        tableId: table.table_id,
        deviceId,
        assignmentVersion: table.version,
        lastClosedSessionId: statements.lastClosedSession.get(table.table_id)?.session_id ?? null,
      });
      if (visitContextId !== currentVisitContextId) {
        fail(STAFF_CALL_ERROR_CODES.VISIT_CONTEXT_STALE, 'The customer visit context is stale.');
      }

      const createdAtMs = now();
      const staffCallId = String(idFactory()).toLowerCase();
      const sessionId = statements.openSession.get(table.table_id)?.session_id
        ?? String(sessionIdFactory()).toLowerCase();
      if (!UUID_V4.test(staffCallId) || !UUID_V4.test(sessionId) || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
        fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'A generated staff call value is invalid.');
      }
      if (!statements.openSession.get(table.table_id)) {
        statements.insertSession.run(sessionId, table.table_id, createdAtMs, createdAtMs, createdAtMs);
      }
      statements.insertCall.run(
        staffCallId, normalizedCallId, deviceId, table.table_id, table.table_id,
        createdAtMs, sessionId,
      );
      const eventEpoch = statements.eventEpoch.get()?.event_epoch;
      if (typeof eventEpoch !== 'string') fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'Event metadata is unavailable.');
      const event = statements.insertEvent.run(
        eventEpoch, staffCallId, deviceId,
        JSON.stringify({ staffCallId, clientCallId: normalizedCallId, tableId: table.table_id, callType: 'staff' }),
        createdAtMs,
      );
      const staffCall = {
        staffCallId,
        clientCallId: normalizedCallId,
        tableId: table.table_id,
        tableNumberSnapshot: table.table_id,
        tableSessionId: sessionId,
        callType: 'staff',
        status: 'open',
        createdAtMs,
        version: 1,
      };
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        idempotencyResult: 'created',
        staffCall,
        event: { eventEpoch, eventId: Number(event.lastInsertRowid) },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof StaffCallRepositoryError) throw error;
      fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'The staff call could not be saved.', { cause: error });
    }
  }

  function resolveStaffCall({ principal, staffCallId, expectedVersion } = {}) {
    if (closed) fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'The staff call repository is closed.');
    const deviceId = typeof principal?.deviceId === 'string' ? principal.deviceId.toLowerCase() : '';
    const callId = typeof staffCallId === 'string' ? staffCallId.toLowerCase() : '';
    if (!UUID_V4.test(callId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      fail(STAFF_CALL_ERROR_CODES.INVALID_REQUEST, 'The staff call resolution request is invalid.');
    }
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const device = statements.resolvingDevice.get(deviceId);
      if (!device) fail(STAFF_CALL_ERROR_CODES.DEVICE_NOT_REGISTERED, 'The authenticated device is not registered.');
      if (!['kitchen', 'admin'].includes(device.role) || device.status !== 'active') {
        fail(STAFF_CALL_ERROR_CODES.DEVICE_NOT_AUTHORIZED, 'An active staff device is required.');
      }
      const existing = statements.callById.get(callId);
      if (!existing) fail(STAFF_CALL_ERROR_CODES.CALL_NOT_FOUND, 'The staff call was not found.');
      if (existing.status === 'resolved') {
        database.exec('COMMIT;');
        transactionOpen = false;
        return { idempotencyResult: 'replayed', staffCall: mapCall(existing) };
      }
      if (existing.version !== expectedVersion) {
        fail(STAFF_CALL_ERROR_CODES.CALL_CONFLICT, 'The staff call changed before it could be resolved.');
      }
      const resolvedAtMs = now();
      if (!Number.isSafeInteger(resolvedAtMs) || resolvedAtMs < existing.created_at_ms) {
        fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'The staff call resolution timestamp is invalid.');
      }
      const update = statements.resolveCall.run(resolvedAtMs, deviceId, callId, expectedVersion);
      if (Number(update.changes) !== 1) fail(STAFF_CALL_ERROR_CODES.CALL_CONFLICT, 'The staff call changed before it could be resolved.');
      const resolved = statements.callById.get(callId);
      const eventEpoch = statements.eventEpoch.get()?.event_epoch;
      if (typeof eventEpoch !== 'string') fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'Event metadata is unavailable.');
      const event = statements.resolvedEvent.run(
        eventEpoch, callId, deviceId,
        JSON.stringify({ staffCallId: callId, callType: 'staff', status: 'resolved' }),
        resolvedAtMs,
      );
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        idempotencyResult: 'created',
        staffCall: mapCall(resolved),
        event: { eventEpoch, eventId: Number(event.lastInsertRowid) },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof StaffCallRepositoryError) throw error;
      fail(STAFF_CALL_ERROR_CODES.DATABASE_FAILURE, 'The staff call could not be resolved.', { cause: error });
    }
  }

  function close() { closed = true; }
  return Object.freeze({ createStaffCall, resolveStaffCall, close });
}

function mapCall(row) {
  return {
    staffCallId: row.staff_call_id,
    clientCallId: row.client_call_id,
    tableId: row.table_id,
    tableNumberSnapshot: row.table_number_snapshot,
    tableSessionId: row.table_session_id,
    callType: row.call_type,
    status: row.status,
    createdAtMs: row.created_at_ms,
    version: row.version,
  };
}
