import { createHash, randomUUID } from 'node:crypto';

import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import { ORDER_ERROR_CODES, OrderRepositoryError } from './order-errors.mjs';

const FINGERPRINT_VERSION = 1;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 99;
const MAX_LINE_TOTAL_YEN = 100_000_000;
const MAX_ORDER_TOTAL_YEN = 100_000_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function repositoryError(code, message, options = undefined) {
  return new OrderRepositoryError(code, message, options);
}

function normalizeUuid(value, fieldName) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      `${fieldName} must be a valid UUID v4.`,
    );
  }

  return value.toLowerCase();
}

function normalizeAuthenticatedDeviceId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      'authenticatedDeviceId must be a non-empty string.',
    );
  }

  return value.trim().toLowerCase();
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      `items must contain between 1 and ${MAX_ITEMS} lines.`,
    );
  }

  const seenMenuItemIds = new Set();
  const normalizedItems = items.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}] must be an object.`,
      );
    }

    const { menuItemId, quantity } = item;
    if (
      typeof menuItemId !== 'string'
      || menuItemId.trim() === ''
      || menuItemId.length > 64
    ) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}].menuItemId must be a non-empty string of at most 64 characters.`,
      );
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}].quantity must be an integer between 1 and ${MAX_QUANTITY}.`,
      );
    }

    if (seenMenuItemIds.has(menuItemId)) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `menuItemId is duplicated: ${menuItemId}`,
      );
    }
    seenMenuItemIds.add(menuItemId);

    return { menuItemId, quantity };
  });

  return normalizedItems.sort((left, right) => {
    if (left.menuItemId < right.menuItemId) return -1;
    if (left.menuItemId > right.menuItemId) return 1;
    return 0;
  });
}

function normalizeOrderRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      'Order request must be an object.',
    );
  }

  for (const untrustedField of ['tableId', 'tableNumber', 'priceYen', 'totalAmountYen']) {
    if (Object.hasOwn(request, untrustedField)) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `${untrustedField} is server-controlled and must not be supplied.`,
      );
    }
  }

  return {
    clientOrderId: normalizeUuid(request.clientOrderId, 'clientOrderId'),
    authenticatedDeviceId: normalizeAuthenticatedDeviceId(request.authenticatedDeviceId),
    items: normalizeItems(request.items),
  };
}

function buildCanonicalIntent({ authenticatedDeviceId, items }) {
  return JSON.stringify({
    fingerprintVersion: FINGERPRINT_VERSION,
    authenticatedDeviceId,
    items: items.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })),
  });
}

function fingerprintCanonicalIntent(canonicalRequestJson) {
  return createHash('sha256').update(canonicalRequestJson, 'utf8').digest('hex');
}

function validateGeneratedValues(orderId, acceptedAtMs) {
  if (typeof orderId !== 'string' || !UUID_V4_PATTERN.test(orderId)) {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'idFactory must return a valid UUID v4.',
    );
  }

  if (!Number.isSafeInteger(acceptedAtMs) || acceptedAtMs < 0) {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'now must return a non-negative safe integer in Unix epoch milliseconds.',
    );
  }
}

function isClientOrderUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR'
    && String(error.message).includes('UNIQUE constraint failed: orders.client_order_id');
}

function mapOrderRow(row, items) {
  return {
    orderId: row.order_id,
    clientOrderId: row.client_order_id,
    requestFingerprint: row.request_fingerprint,
    canonicalRequestJson: row.canonical_request_json,
    authenticatedDeviceId: row.customer_device_id,
    tableId: row.table_id,
    tableNumberSnapshot: row.table_number_snapshot,
    status: row.status,
    totalAmountYen: row.total_amount_yen,
    acceptedAtMs: row.accepted_at_ms,
    completedAtMs: row.completed_at_ms,
    version: row.version,
    items,
  };
}

function mapOrderItemRow(row) {
  return {
    orderItemId: row.order_item_id,
    lineIndex: row.line_index,
    menuItemId: row.menu_item_id,
    formalNameSnapshot: row.formal_name_snapshot,
    kitchenAliasSnapshot: row.kitchen_alias_snapshot,
    unitPriceYenSnapshot: row.unit_price_yen_snapshot,
    quantity: row.quantity,
    lineTotalYen: row.line_total_yen,
    isServed: row.is_served === 1,
    servedAtMs: row.served_at_ms,
  };
}

export function createOrderRepository({ database, now = Date.now, idFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
    );
  }
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'now and idFactory must be functions.',
    );
  }

  let closed = false;
  let statements;

  try {
    statements = {
      findOrder: database.prepare(`
        SELECT
          order_id,
          client_order_id,
          request_fingerprint,
          canonical_request_json,
          customer_device_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE client_order_id = ?
      `),
      findOrderItems: database.prepare(`
        SELECT
          order_item_id,
          line_index,
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
        ORDER BY line_index
      `),
      findHistoryOrders: database.prepare(`
        SELECT
          order_id,
          client_order_id,
          request_fingerprint,
          canonical_request_json,
          customer_device_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE status = 'completed'
        ORDER BY completed_at_ms DESC, order_id DESC
      `),
      findCustomerHistoryOrders: database.prepare(`
        SELECT
          order_id,
          client_order_id,
          request_fingerprint,
          canonical_request_json,
          customer_device_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE customer_device_id = ?
        ORDER BY accepted_at_ms DESC, order_id DESC
      `),
      findServingOrder: database.prepare(`
        SELECT
          order_id,
          client_order_id,
          request_fingerprint,
          canonical_request_json,
          customer_device_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE order_id = ?
      `),
      findServingItem: database.prepare(`
        SELECT order_item_id, order_id, is_served
        FROM order_items
        WHERE order_item_id = ? AND order_id = ?
      `),
      countUnservedItems: database.prepare(`
        SELECT COUNT(*) AS count
        FROM order_items
        WHERE order_id = ? AND is_served = 0
      `),
      markItemServed: database.prepare(`
        UPDATE order_items
        SET is_served = 1, served_at_ms = ?, served_by_device_id = ?, updated_at_ms = ?
        WHERE order_item_id = ? AND order_id = ?
      `),
      updateServingOrder: database.prepare(`
        UPDATE orders
        SET status = ?, completed_at_ms = ?, version = version + 1
        WHERE order_id = ?
      `),
      insertOrderUpdateEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch,
          event_type,
          aggregate_type,
          aggregate_id,
          actor_device_id,
          payload_json,
          created_at_ms
        ) VALUES (?, ?, 'order', ?, ?, ?, ?)
      `),
      findDevice: database.prepare(`
        SELECT device_id, role, status
        FROM devices
        WHERE device_id = ?
      `),
      findAssignedTable: database.prepare(`
        SELECT table_id, label, is_active
        FROM tables
        WHERE assigned_customer_device_id = ?
      `),
      findMenuItem: database.prepare(`
        SELECT
          menu_item_id,
          formal_name,
          kitchen_alias,
          price_yen,
          is_sold_out,
          is_active
        FROM menu_items
        WHERE menu_item_id = ?
      `),
      findSystemState: database.prepare(`
        SELECT event_epoch
        FROM system_state
        WHERE singleton_id = 1
      `),
      insertOrder: database.prepare(`
        INSERT INTO orders (
          order_id,
          client_order_id,
          request_fingerprint,
          canonical_request_json,
          customer_device_id,
          table_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
      `),
      insertOrderItem: database.prepare(`
        INSERT INTO order_items (
          order_id,
          line_index,
          menu_item_id,
          formal_name_snapshot,
          kitchen_alias_snapshot,
          unit_price_yen_snapshot,
          quantity,
          line_total_yen,
          created_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch,
          event_type,
          aggregate_type,
          aggregate_id,
          actor_device_id,
          payload_json,
          created_at_ms
        ) VALUES (?, 'order.created', 'order', ?, ?, ?, ?)
      `),
    };
  } catch (error) {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'Failed to prepare order repository statements.',
      { cause: error },
    );
  }

  function loadOrder(row) {
    const itemRows = statements.findOrderItems.all(row.order_id);
    return mapOrderRow(row, itemRows.map(mapOrderItemRow));
  }

  function conflict() {
    return repositoryError(
      ORDER_ERROR_CODES.ORDER_CONFLICT,
      'clientOrderId is already associated with a different order intent or device.',
    );
  }

  function replayExisting(row, requestFingerprint, authenticatedDeviceId) {
    if (
      row.request_fingerprint !== requestFingerprint
      || row.customer_device_id !== authenticatedDeviceId
    ) {
      throw conflict();
    }

    return {
      idempotencyResult: 'replayed',
      order: loadOrder(row),
      event: null,
    };
  }

  function resolveUniqueRace(clientOrderId, requestFingerprint, authenticatedDeviceId, cause) {
    try {
      const existing = statements.findOrder.get(clientOrderId);
      if (!existing) {
        throw repositoryError(
          ORDER_ERROR_CODES.DATABASE_FAILURE,
          'A clientOrderId uniqueness conflict occurred but the existing order was not readable.',
          { cause },
        );
      }
      return replayExisting(existing, requestFingerprint, authenticatedDeviceId);
    } catch (error) {
      if (error instanceof OrderRepositoryError) throw error;
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'Failed to resolve a concurrent clientOrderId conflict.',
        { cause: error },
      );
    }
  }

  function createOrder(request) {
    if (closed) {
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The order repository is closed.',
      );
    }

    const normalized = normalizeOrderRequest(request);
    const canonicalRequestJson = buildCanonicalIntent(normalized);
    const requestFingerprint = fingerprintCanonicalIntent(canonicalRequestJson);
    let transactionOpen = false;

    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;

      const existing = statements.findOrder.get(normalized.clientOrderId);
      if (existing) {
        const result = replayExisting(
          existing,
          requestFingerprint,
          normalized.authenticatedDeviceId,
        );
        database.exec('COMMIT;');
        transactionOpen = false;
        return result;
      }

      const device = statements.findDevice.get(normalized.authenticatedDeviceId);
      if (!device) {
        throw repositoryError(
          ORDER_ERROR_CODES.DEVICE_NOT_REGISTERED,
          'The authenticated device is not registered.',
        );
      }
      if (device.role !== 'customer' || device.status !== 'active') {
        throw repositoryError(
          ORDER_ERROR_CODES.DEVICE_NOT_AUTHORIZED,
          'The authenticated device is not an active customer device.',
        );
      }

      const table = statements.findAssignedTable.get(normalized.authenticatedDeviceId);
      if (!table) {
        throw repositoryError(
          ORDER_ERROR_CODES.DEVICE_NOT_ASSIGNED,
          'The authenticated customer device is not assigned to a table.',
        );
      }
      if (table.is_active !== 1) {
        throw repositoryError(
          ORDER_ERROR_CODES.TABLE_INACTIVE,
          'The assigned table is inactive.',
        );
      }

      const acceptedAtMs = now();
      const orderId = String(idFactory()).toLowerCase();
      validateGeneratedValues(orderId, acceptedAtMs);

      let totalAmountYen = 0;
      const snapshots = normalized.items.map((item, lineIndex) => {
        const menuItem = statements.findMenuItem.get(item.menuItemId);
        if (!menuItem || menuItem.is_active !== 1) {
          throw repositoryError(
            ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND,
            `Menu item is not available: ${item.menuItemId}`,
          );
        }
        if (menuItem.is_sold_out === 1) {
          throw repositoryError(
            ORDER_ERROR_CODES.MENU_ITEM_SOLD_OUT,
            `Menu item is sold out: ${item.menuItemId}`,
          );
        }

        const lineTotalYen = menuItem.price_yen * item.quantity;
        if (!Number.isSafeInteger(lineTotalYen) || lineTotalYen > MAX_LINE_TOTAL_YEN) {
          throw repositoryError(
            ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
            `Line total exceeds the supported limit: ${item.menuItemId}`,
          );
        }

        totalAmountYen += lineTotalYen;
        if (!Number.isSafeInteger(totalAmountYen) || totalAmountYen > MAX_ORDER_TOTAL_YEN) {
          throw repositoryError(
            ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
            'Order total exceeds the supported limit.',
          );
        }

        return {
          lineIndex,
          menuItemId: menuItem.menu_item_id,
          formalNameSnapshot: menuItem.formal_name,
          kitchenAliasSnapshot: menuItem.kitchen_alias,
          unitPriceYenSnapshot: menuItem.price_yen,
          quantity: item.quantity,
          lineTotalYen,
        };
      });

      statements.insertOrder.run(
        orderId,
        normalized.clientOrderId,
        requestFingerprint,
        canonicalRequestJson,
        normalized.authenticatedDeviceId,
        table.table_id,
        table.table_id,
        totalAmountYen,
        acceptedAtMs,
      );

      const resultItems = snapshots.map((snapshot) => {
        const insertion = statements.insertOrderItem.run(
          orderId,
          snapshot.lineIndex,
          snapshot.menuItemId,
          snapshot.formalNameSnapshot,
          snapshot.kitchenAliasSnapshot,
          snapshot.unitPriceYenSnapshot,
          snapshot.quantity,
          snapshot.lineTotalYen,
          acceptedAtMs,
          acceptedAtMs,
        );

        return {
          orderItemId: Number(insertion.lastInsertRowid),
          ...snapshot,
          isServed: false,
          servedAtMs: null,
        };
      });

      const systemState = statements.findSystemState.get();
      if (!systemState?.event_epoch) {
        throw repositoryError(
          ORDER_ERROR_CODES.DATABASE_FAILURE,
          'Current event epoch is unavailable.',
        );
      }

      const eventPayloadJson = JSON.stringify({
        orderId,
        tableId: table.table_id,
        tableNumberSnapshot: table.table_id,
        createdAtMs: acceptedAtMs,
      });
      const eventInsertion = statements.insertEvent.run(
        systemState.event_epoch,
        orderId,
        normalized.authenticatedDeviceId,
        eventPayloadJson,
        acceptedAtMs,
      );

      const result = {
        idempotencyResult: 'created',
        order: {
          orderId,
          clientOrderId: normalized.clientOrderId,
          requestFingerprint,
          canonicalRequestJson,
          authenticatedDeviceId: normalized.authenticatedDeviceId,
          tableId: table.table_id,
          tableNumberSnapshot: table.table_id,
          status: 'new',
          totalAmountYen,
          acceptedAtMs,
          completedAtMs: null,
          version: 1,
          items: resultItems,
        },
        event: {
          eventId: Number(eventInsertion.lastInsertRowid),
          eventEpoch: systemState.event_epoch,
          eventType: 'order.created',
          payloadJson: eventPayloadJson,
          createdAtMs: acceptedAtMs,
        },
      };

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

      if (isClientOrderUniqueViolation(error)) {
        return resolveUniqueRace(
          normalized.clientOrderId,
          requestFingerprint,
          normalized.authenticatedDeviceId,
          error,
        );
      }
      if (error instanceof OrderRepositoryError) {
        throw error;
      }

      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The order transaction failed.',
        { cause: error },
      );
    }
  }

  function getHistory(principal) {
    if (closed) {
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The order repository is closed.',
      );
    }

    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    let transactionOpen = false;
    try {
      database.exec('BEGIN;');
      transactionOpen = true;
      const history = statements.findHistoryOrders.all().map(loadOrder);
      database.exec('COMMIT;');
      transactionOpen = false;
      return history;
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof OrderRepositoryError) throw error;
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The order history could not be read.',
        { cause: error },
      );
    }
  }

  function getCustomerHistory(principal) {
    if (closed) {
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The order repository is closed.',
      );
    }

    authorizeDeviceRole(principal, ['customer']);
    let transactionOpen = false;
    try {
      database.exec('BEGIN;');
      transactionOpen = true;
      const history = statements.findCustomerHistoryOrders.all(principal.deviceId).map(loadOrder);
      database.exec('COMMIT;');
      transactionOpen = false;
      return history;
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof OrderRepositoryError) throw error;
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The customer order history could not be read.',
        { cause: error },
      );
    }
  }

  function markItemServed({ principal, orderId, orderItemId } = {}) {
    if (closed) {
      throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, 'The order repository is closed.');
    }
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    const normalizedOrderId = normalizeUuid(orderId, 'orderId');
    if (!Number.isSafeInteger(orderItemId) || orderItemId < 1) {
      throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, 'orderItemId must be a positive integer.');
    }

    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const order = statements.findServingOrder.get(normalizedOrderId);
      if (!order) throw repositoryError(ORDER_ERROR_CODES.ORDER_NOT_FOUND, 'The order was not found.');
      if (order.status === 'completed') throw repositoryError(ORDER_ERROR_CODES.ORDER_CONFLICT, 'The order is already completed.');
      const item = statements.findServingItem.get(orderItemId, normalizedOrderId);
      if (!item) throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, 'The order item was not found.');
      if (item.is_served === 1) {
        database.exec('COMMIT;');
        transactionOpen = false;
        return { idempotencyResult: 'replayed', order: loadOrder(order), event: null };
      }

      const servedAtMs = now();
      statements.markItemServed.run(servedAtMs, principal.deviceId, servedAtMs, orderItemId, normalizedOrderId);
      const remaining = Number(statements.countUnservedItems.get(normalizedOrderId).count);
      const completed = remaining === 0;
      statements.updateServingOrder.run(completed ? 'completed' : 'active', completed ? servedAtMs : null, normalizedOrderId);
      const systemState = statements.findSystemState.get();
      if (!systemState?.event_epoch) throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, 'Current event epoch is unavailable.');
      const eventType = completed ? 'order.completed' : 'order.updated';
      const eventPayloadJson = JSON.stringify({ orderId: normalizedOrderId, tableId: order.table_id, completed });
      const eventInsertion = statements.insertOrderUpdateEvent.run(
        systemState.event_epoch,
        eventType,
        normalizedOrderId,
        principal.deviceId,
        eventPayloadJson,
        servedAtMs,
      );
      const updated = statements.findServingOrder.get(normalizedOrderId);
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        idempotencyResult: 'created',
        order: loadOrder(updated),
        event: { eventEpoch: systemState.event_epoch, eventId: Number(eventInsertion.lastInsertRowid) },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof OrderRepositoryError) throw error;
      throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, 'The order serving update failed.', { cause: error });
    }
  }

  return Object.freeze({
    createOrder,
    getCustomerHistory,
    getHistory,
    markItemServed,
    close() {
      closed = true;
    },
  });
}
