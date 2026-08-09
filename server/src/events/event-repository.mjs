import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import { isDeviceAuthError } from '../auth/auth-errors.mjs';
import {
  EVENT_ERROR_CODES,
  EventRepositoryError,
} from './event-errors.mjs';

const DEVICE_ROLES = Object.freeze(['customer', 'kitchen', 'admin']);
const DEFAULT_SCAN_LIMIT = 200;
const MAX_SCAN_LIMIT = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function repositoryError(code, message, options = undefined) {
  return new EventRepositoryError(code, message, options);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function invalidRequest(message) {
  return repositoryError(EVENT_ERROR_CODES.INVALID_EVENT_REQUEST, message);
}

function historyUnavailable() {
  return repositoryError(
    EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
    'The requested event history is unavailable; obtain a new snapshot.',
  );
}

function validateEventEpoch(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidRequest('eventEpoch must be a canonical lowercase UUID.');
  }
  return value;
}

function validateCursor(value, fieldName, { allowZero = true } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidRequest(`${fieldName} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

function validateLimit(value) {
  if (value === undefined) return DEFAULT_SCAN_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SCAN_LIMIT) {
    throw invalidRequest(`limit must be an integer between 1 and ${MAX_SCAN_LIMIT}.`);
  }
  return value;
}

function eventResource(eventType) {
  if (eventType.startsWith('order.')) return 'orders';
  if (eventType.startsWith('menu.')) return 'menu';
  if (eventType.startsWith('staff_call.')) return 'staffCalls';
  if (eventType.startsWith('device.') || eventType === 'table.assignment_updated') {
    return 'deviceConfig';
  }
  throw repositoryError(
    EVENT_ERROR_CODES.DATABASE_FAILURE,
    'The stored event type is unsupported.',
  );
}

function canSeeEvent(row, device) {
  if (device.role === 'admin') return true;

  const resource = eventResource(row.event_type);
  if (device.role === 'kitchen') {
    return resource === 'orders'
      || resource === 'menu'
      || resource === 'staffCalls'
      || row.event_type === 'table.assignment_updated';
  }

  if (resource === 'orders') {
    return row.order_customer_device_id === device.device_id;
  }
  if (resource === 'staffCalls') {
    return row.call_customer_device_id === device.device_id;
  }
  if (resource === 'menu') return true;
  if (row.event_type === 'table.assignment_updated') {
    return String(device.assignedTableId) === row.aggregate_id;
  }
  return row.event_type === 'device.revoked' && row.aggregate_id === device.device_id;
}

function publicAggregateId(row, resource) {
  if (resource === 'orders' || resource === 'staffCalls') return row.aggregate_id;
  if (resource === 'menu') return 'menu';
  return 'device-config';
}

function projectEvent(row, device) {
  if (!canSeeEvent(row, device)) return null;
  const resource = eventResource(row.event_type);
  return deepFreeze({
    audience: device.role,
    eventEpoch: row.event_epoch,
    eventId: row.event_id,
    type: row.event_type,
    aggregateId: publicAggregateId(row, resource),
    occurredAtMs: row.created_at_ms,
    payload: {
      resource,
      refreshRequired: true,
    },
  });
}

function mapOrderItem(row) {
  const item = {
    orderItemId: row.order_item_id,
    formalNameSnapshot: row.formal_name_snapshot,
    kitchenAliasSnapshot: row.kitchen_alias_snapshot,
    unitPriceYenSnapshot: row.unit_price_yen_snapshot,
    quantity: row.quantity,
    lineTotalYen: row.line_total_yen,
    isServed: row.is_served === 1,
  };
  if (row.menu_item_id !== null) item.menuItemId = row.menu_item_id;
  if (row.served_at_ms !== null) item.servedAtMs = row.served_at_ms;
  return item;
}

function mapOrder(row, itemRows) {
  const order = {
    orderId: row.order_id,
    clientOrderId: row.client_order_id,
    tableId: row.table_id,
    tableNumberSnapshot: row.table_number_snapshot,
    status: row.status,
    totalAmountYen: row.total_amount_yen,
    acceptedAtMs: row.accepted_at_ms,
    version: row.version,
    items: itemRows.map(mapOrderItem),
  };
  if (row.completed_at_ms !== null) order.completedAtMs = row.completed_at_ms;
  return order;
}

function mapStaffCall(row) {
  const call = {
    staffCallId: row.staff_call_id,
    clientCallId: row.client_call_id,
    tableId: row.table_id,
    tableNumberSnapshot: row.table_number_snapshot,
    callType: row.call_type,
    status: row.status,
    createdAtMs: row.created_at_ms,
    version: row.version,
  };
  if (row.resolved_at_ms !== null) call.resolvedAtMs = row.resolved_at_ms;
  return call;
}

export function createEventRepository({ database } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw repositoryError(
      EVENT_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
    );
  }

  let statements;
  try {
    const eventProjectionColumns = `
      e.event_id,
      e.event_epoch,
      e.event_type,
      e.aggregate_type,
      e.aggregate_id,
      e.created_at_ms,
      o.customer_device_id AS order_customer_device_id,
      sc.customer_device_id AS call_customer_device_id
    `;
    const eventProjectionJoins = `
      LEFT JOIN orders AS o
        ON e.aggregate_type = 'order' AND o.order_id = e.aggregate_id
      LEFT JOIN staff_calls AS sc
        ON e.aggregate_type = 'staff_call' AND sc.staff_call_id = e.aggregate_id
    `;

    statements = {
      findDeviceState: database.prepare(`
        SELECT
          d.device_id,
          d.role,
          d.status,
          t.table_id,
          t.is_active AS table_is_active
        FROM devices AS d
        LEFT JOIN tables AS t
          ON t.assigned_customer_device_id = d.device_id
        WHERE d.device_id = ?
        ORDER BY t.table_id
      `),
      findEventCursor: database.prepare(`
        SELECT
          s.event_epoch,
          COALESCE(MAX(e.event_id), 0) AS last_event_id
        FROM system_state AS s
        LEFT JOIN event_log AS e
          ON e.event_epoch = s.event_epoch
        WHERE s.singleton_id = 1
        GROUP BY s.event_epoch
      `),
      findCursorEvent: database.prepare(`
        SELECT event_id
        FROM event_log
        WHERE event_epoch = ? AND event_id = ?
      `),
      scanEvents: database.prepare(`
        SELECT ${eventProjectionColumns}
        FROM event_log AS e
        ${eventProjectionJoins}
        WHERE e.event_epoch = ?
          AND e.event_id > ?
          AND e.event_id <= ?
        ORDER BY e.event_id
        LIMIT ?
      `),
      findEvent: database.prepare(`
        SELECT ${eventProjectionColumns}
        FROM event_log AS e
        ${eventProjectionJoins}
        WHERE e.event_epoch = ? AND e.event_id = ?
      `),
      findActiveOrders: database.prepare(`
        SELECT
          order_id,
          client_order_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE status IN ('new', 'active')
        ORDER BY accepted_at_ms, order_id
      `),
      findOrderItems: database.prepare(`
        SELECT
          order_item_id,
          menu_item_id,
          formal_name_snapshot,
          kitchen_alias_snapshot,
          unit_price_yen_snapshot,
          quantity,
          line_total_yen,
          is_served,
          served_at_ms
        FROM order_items
        WHERE order_id = ?
        ORDER BY is_served, line_index, order_item_id
      `),
      findOpenStaffCalls: database.prepare(`
        SELECT
          staff_call_id,
          client_call_id,
          table_id,
          table_number_snapshot,
          call_type,
          status,
          created_at_ms,
          resolved_at_ms,
          version
        FROM staff_calls
        WHERE status = 'open'
        ORDER BY created_at_ms, staff_call_id
      `),
    };
  } catch (error) {
    throw repositoryError(
      EVENT_ERROR_CODES.DATABASE_FAILURE,
      'Failed to prepare event repository statements.',
      { cause: error },
    );
  }

  let closed = false;

  function ensureOpen() {
    if (closed) {
      throw repositoryError(EVENT_ERROR_CODES.DATABASE_FAILURE, 'The event repository is closed.');
    }
  }

  function assertGenuinePrincipal(principal) {
    try {
      authorizeDeviceRole(principal, DEVICE_ROLES);
    } catch (error) {
      if (isDeviceAuthError(error)) {
        throw repositoryError(
          EVENT_ERROR_CODES.AUTHENTICATION_REQUIRED,
          'An authenticated device principal is required.',
        );
      }
      throw error;
    }
  }

  function loadCurrentDevice(principal) {
    const rows = statements.findDeviceState.all(principal.deviceId);
    if (rows.length === 0 || rows[0].status !== 'active') {
      throw repositoryError(EVENT_ERROR_CODES.DEVICE_NOT_ACTIVE, 'The device is not active.');
    }
    const device = rows[0];
    if (!DEVICE_ROLES.includes(device.role)) {
      throw repositoryError(
        EVENT_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
        'The current device state is inconsistent.',
      );
    }

    const assignedTables = rows.filter((row) => row.table_id !== null);
    if (device.role === 'customer') {
      if (assignedTables.length === 0) {
        throw repositoryError(
          EVENT_ERROR_CODES.DEVICE_NOT_ASSIGNED,
          'The customer device is not assigned to a table.',
        );
      }
      if (assignedTables.length !== 1 || assignedTables[0].table_is_active !== 1) {
        throw repositoryError(
          EVENT_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
          'The customer table assignment is inconsistent.',
        );
      }
      device.assignedTableId = assignedTables[0].table_id;
    } else if (assignedTables.length !== 0) {
      throw repositoryError(
        EVENT_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
        'A staff device cannot have a customer table assignment.',
      );
    }
    return device;
  }

  function loadEventCursor() {
    const row = statements.findEventCursor.get();
    if (
      !row
      || typeof row.event_epoch !== 'string'
      || !Number.isSafeInteger(row.last_event_id)
      || row.last_event_id < 0
    ) {
      throw repositoryError(
        EVENT_ERROR_CODES.DATABASE_FAILURE,
        'The current event cursor is unavailable.',
      );
    }
    return row;
  }

  function validateAvailableCursor(eventEpoch, afterEventId, cursor) {
    if (eventEpoch !== cursor.event_epoch) throw historyUnavailable();
    if (afterEventId === 0) return;
    if (
      afterEventId > cursor.last_event_id
      || !statements.findCursorEvent.get(eventEpoch, afterEventId)
    ) {
      throw historyUnavailable();
    }
  }

  function runReadTransaction(read) {
    let transactionOpen = false;
    try {
      database.exec('BEGIN;');
      transactionOpen = true;
      const result = read();
      database.exec('COMMIT;');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec('ROLLBACK;');
        } catch {
          // Preserve the original failure. The caller may replace the connection.
        }
      }
      if (error instanceof EventRepositoryError) throw error;
      throw repositoryError(
        EVENT_ERROR_CODES.DATABASE_FAILURE,
        'The event read failed.',
        { cause: error },
      );
    }
  }

  function prepareRead(principal) {
    ensureOpen();
    assertGenuinePrincipal(principal);
  }

  function getCurrentCursor(principal) {
    prepareRead(principal);
    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();
      return deepFreeze({
        audience: device.role,
        eventEpoch: cursor.event_epoch,
        lastEventId: cursor.last_event_id,
      });
    });
  }

  function readCommittedForPrincipal(principal, options = {}) {
    prepareRead(principal);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidRequest('Event read options must be an object.');
    }
    const eventEpoch = validateEventEpoch(options.eventEpoch);
    const afterEventId = validateCursor(options.afterEventId, 'afterEventId');
    const limit = validateLimit(options.limit);
    const requestedThrough = options.throughEventId === undefined
      ? undefined
      : validateCursor(options.throughEventId, 'throughEventId');
    if (requestedThrough !== undefined && requestedThrough < afterEventId) {
      throw invalidRequest('throughEventId must not be less than afterEventId.');
    }

    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();
      validateAvailableCursor(eventEpoch, afterEventId, cursor);

      const throughEventId = requestedThrough ?? cursor.last_event_id;
      if (throughEventId > cursor.last_event_id) throw historyUnavailable();
      if (
        throughEventId > 0
        && throughEventId !== afterEventId
        && !statements.findCursorEvent.get(eventEpoch, throughEventId)
      ) {
        throw historyUnavailable();
      }

      const rows = throughEventId === afterEventId
        ? []
        : statements.scanEvents.all(
          eventEpoch,
          afterEventId,
          throughEventId,
          limit + 1,
        );
      const scannedRows = rows.slice(0, limit);
      const events = [];
      for (const row of scannedRows) {
        const event = projectEvent(row, device);
        if (event !== null) events.push(event);
      }

      return deepFreeze({
        audience: device.role,
        eventEpoch,
        events,
        lastEventId: scannedRows.at(-1)?.event_id ?? afterEventId,
        hasMore: rows.length > limit,
      });
    });
  }

  function replay({ principal, eventEpoch, afterEventId, limit = undefined } = {}) {
    return readCommittedForPrincipal(principal, {
      eventEpoch,
      afterEventId,
      limit,
    });
  }

  function readCommittedEventForPrincipal({ principal, eventId } = {}) {
    prepareRead(principal);
    const normalizedEventId = validateCursor(eventId, 'eventId', { allowZero: false });
    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();
      const row = statements.findEvent.get(cursor.event_epoch, normalizedEventId);
      if (!row) throw historyUnavailable();
      return deepFreeze({
        audience: device.role,
        eventEpoch: cursor.event_epoch,
        eventId: normalizedEventId,
        event: projectEvent(row, device),
      });
    });
  }

  function getSnapshotOrders(principal) {
    prepareRead(principal);
    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();
      let activeOrders = [];
      let openStaffCalls = [];
      if (device.role === 'kitchen' || device.role === 'admin') {
        activeOrders = statements.findActiveOrders.all().map((orderRow) => (
          mapOrder(orderRow, statements.findOrderItems.all(orderRow.order_id))
        ));
        openStaffCalls = statements.findOpenStaffCalls.all().map(mapStaffCall);
      }
      return deepFreeze({
        audience: device.role,
        eventEpoch: cursor.event_epoch,
        lastEventId: cursor.last_event_id,
        activeOrders,
        openStaffCalls,
      });
    });
  }

  return Object.freeze({
    getCurrentCursor,
    replay,
    readCommittedForPrincipal,
    readCommittedEventForPrincipal,
    getSnapshotOrders,
    close() {
      closed = true;
    },
  });
}
