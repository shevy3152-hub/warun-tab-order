import { createHash, randomUUID } from 'node:crypto';

import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import { ORDER_ERROR_CODES, OrderRepositoryError } from './order-errors.mjs';

const FINGERPRINT_VERSION = 1;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 99;
const MAX_LINE_TOTAL_YEN = 100_000_000;
const MAX_ORDER_TOTAL_YEN = 100_000_000;
const MIN_QUANTITY_MENU_ITEM_IDS = new Set(['food-kushi-kushikatsu']);
const TEMPERATURES = new Set(['冷酒', '燗酒']);
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

function normalizeTableId(value, fieldName = 'tableId') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      `${fieldName} must be a positive integer.`,
    );
  }
  return value;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw repositoryError(
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      `items must contain between 1 and ${MAX_ITEMS} lines.`,
    );
  }

  const seenSelections = new Set();
  const normalizedItems = items.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}] must be an object.`,
      );
    }

    const { menuItemId, quantity } = item;
    const variantId = item.variantId ?? null;
    const servingOptionId = item.servingOptionId ?? null;
    const temperature = item.temperature ?? null;
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

    for (const [fieldName, value] of [['variantId', variantId], ['servingOptionId', servingOptionId]]) {
      if (value !== null && (typeof value !== 'string' || value.trim() === '' || value.length > 64)) {
        throw repositoryError(
          ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
          `items[${index}].${fieldName} must be a non-empty string of at most 64 characters.`,
        );
      }
    }
    if (temperature !== null && (typeof temperature !== 'string' || !TEMPERATURES.has(temperature))) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}].temperature must be 冷酒 or 燗酒.`,
      );
    }
    if (temperature !== null && variantId === null) {
      throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, `items[${index}].temperature requires a price variant.`);
    }
    if (variantId !== null && servingOptionId !== null) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `items[${index}] cannot combine a price variant and a serving option.`,
      );
    }

    const selectionKey = `${menuItemId}\u0000${variantId ?? ''}\u0000${servingOptionId ?? ''}\u0000${temperature ?? ''}`;
    if (seenSelections.has(selectionKey)) {
      throw repositoryError(
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
        `Order selection is duplicated: ${menuItemId}`,
      );
    }
    seenSelections.add(selectionKey);

    return { menuItemId, quantity, variantId, servingOptionId, temperature };
  });

  return normalizedItems.sort((left, right) => {
    if (left.menuItemId < right.menuItemId) return -1;
    if (left.menuItemId > right.menuItemId) return 1;
    return `${left.variantId ?? ''}\u0000${left.servingOptionId ?? ''}\u0000${left.temperature ?? ''}`
      .localeCompare(`${right.variantId ?? ''}\u0000${right.servingOptionId ?? ''}\u0000${right.temperature ?? ''}`);
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

  const schemaVersion = request.schemaVersion ?? 1;
  if (![1, 2, 3].includes(schemaVersion)) {
    throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, 'schemaVersion must be 1, 2, or 3.');
  }
  const items = normalizeItems(request.items);
  if (schemaVersion === 1 && items.some((item) => item.variantId || item.servingOptionId)) {
    throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, 'Order selections require schemaVersion 2.');
  }
  if (schemaVersion < 3 && items.some((item) => item.temperature)) {
    throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, 'Temperature selections require schemaVersion 3.');
  }
  return {
    schemaVersion,
    clientOrderId: normalizeUuid(request.clientOrderId, 'clientOrderId'),
    authenticatedDeviceId: normalizeAuthenticatedDeviceId(request.authenticatedDeviceId),
    items,
  };
}

function buildCanonicalIntent({ schemaVersion, authenticatedDeviceId, items }) {
  if (schemaVersion === 1) {
    return JSON.stringify({
      fingerprintVersion: FINGERPRINT_VERSION,
      authenticatedDeviceId,
      items: items.map(({ menuItemId, quantity }) => ({ menuItemId, quantity })),
    });
  }
  return JSON.stringify({
    fingerprintVersion: schemaVersion === 3 ? 3 : 2,
    authenticatedDeviceId,
    items: items.map(({ menuItemId, quantity, variantId, servingOptionId, temperature }) => ({
      menuItemId,
      quantity,
      ...(variantId ? { variantId } : {}),
      ...(servingOptionId ? { servingOptionId } : {}),
      ...(temperature ? { temperature } : {}),
    })),
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

function validateGeneratedSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !UUID_V4_PATTERN.test(sessionId)) {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'sessionIdFactory must return a valid UUID v4.',
    );
  }
}

function isClientOrderUniqueViolation(error) {
  return error?.code === 'ERR_SQLITE_ERROR'
    && String(error.message).includes('UNIQUE constraint failed: orders.client_order_id');
}

function mapOrderRow(row, items) {
  const order = {
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
  if (row.session_id !== null && row.session_id !== undefined) order.sessionId = row.session_id;
  return order;
}

function mapOrderItemRow(row) {
  const item = {
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
  if (row.variant_id !== null && row.variant_id !== undefined) {
    item.variantId = row.variant_id;
    item.variantNameSnapshot = row.variant_name_snapshot;
    item.variantVolumeSnapshot = row.variant_volume_snapshot;
    if (row.temperature_snapshot !== null && row.temperature_snapshot !== undefined) item.temperatureSnapshot = row.temperature_snapshot;
  }
  if (row.serving_option_id !== null && row.serving_option_id !== undefined) {
    item.servingOptionId = row.serving_option_id;
    item.servingOptionNameSnapshot = row.serving_option_name_snapshot;
  }
  return item;
}

export function createOrderRepository({ database, now = Date.now, idFactory = randomUUID, sessionIdFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw repositoryError(
      ORDER_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
    );
  }
  if (typeof now !== 'function' || typeof idFactory !== 'function' || typeof sessionIdFactory !== 'function') {
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
          session_id,
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
          ,variant_id
          ,variant_name_snapshot
          ,variant_volume_snapshot
          ,temperature_snapshot
          ,serving_option_id
          ,serving_option_name_snapshot
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
          session_id,
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
          session_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms,
          completed_at_ms,
          version
        FROM orders
        WHERE session_id = ?
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
          session_id,
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
      findOpenSession: database.prepare(`
        SELECT session_id, table_id, opened_at_ms, closed_at_ms, version
        FROM table_sessions
        WHERE table_id = ? AND closed_at_ms IS NULL
      `),
      findSession: database.prepare(`
        SELECT session_id, table_id, opened_at_ms, closed_at_ms, version
        FROM table_sessions
        WHERE session_id = ?
      `),
      insertSession: database.prepare(`
        INSERT INTO table_sessions (
          session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 1, ?, ?)
      `),
      countSessionActiveOrders: database.prepare(`
        SELECT COUNT(*) AS count
        FROM orders
        WHERE session_id = ? AND status IN ('new', 'active')
      `),
      closeSession: database.prepare(`
        UPDATE table_sessions
        SET closed_at_ms = ?, version = version + 1, updated_at_ms = ?
        WHERE session_id = ? AND table_id = ? AND closed_at_ms IS NULL
      `),
      insertSessionCloseEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch,
          event_type,
          aggregate_type,
          aggregate_id,
          actor_device_id,
          payload_json,
          created_at_ms
        ) VALUES (?, 'table.assignment_updated', 'table', ?, ?, ?, ?)
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
      findVariant: database.prepare(`
        SELECT variant_id, menu_item_id, name, volume_label, price_yen, is_active, temperature_options_json
        FROM menu_item_variants
        WHERE variant_id = ?
      `),
      findServingOption: database.prepare(`
        SELECT serving_option_id, menu_item_id, name, is_active
        FROM menu_item_serving_options
        WHERE serving_option_id = ?
      `),
      countActiveVariants: database.prepare(`
        SELECT COUNT(*) AS count FROM menu_item_variants
        WHERE menu_item_id = ? AND is_active = 1
      `),
      countActiveServingOptions: database.prepare(`
        SELECT COUNT(*) AS count FROM menu_item_serving_options
        WHERE menu_item_id = ? AND is_active = 1
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
          session_id,
          table_number_snapshot,
          status,
          total_amount_yen,
          accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
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
          variant_id,
          variant_name_snapshot,
          variant_volume_snapshot,
          temperature_snapshot,
          serving_option_id,
          serving_option_name_snapshot,
          created_at_ms,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  function ensureOpenSession(tableId, openedAtMs) {
    const existing = statements.findOpenSession.get(tableId);
    if (existing) return existing;

    const sessionId = String(sessionIdFactory()).toLowerCase();
    validateGeneratedSessionId(sessionId);
    statements.insertSession.run(sessionId, tableId, openedAtMs, openedAtMs, openedAtMs);
    return statements.findOpenSession.get(tableId);
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
      const session = ensureOpenSession(table.table_id, acceptedAtMs);
      if (!session) {
        throw repositoryError(
          ORDER_ERROR_CODES.DATABASE_FAILURE,
          'The current table session could not be created.',
        );
      }

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

        const activeVariantCount = Number(statements.countActiveVariants.get(item.menuItemId).count);
        const activeServingOptionCount = Number(statements.countActiveServingOptions.get(item.menuItemId).count);
        let variant = null;
        let servingOption = null;
        if (item.variantId) {
          variant = statements.findVariant.get(item.variantId);
          if (!variant || variant.menu_item_id !== item.menuItemId || variant.is_active !== 1) {
            throw repositoryError(ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND, `Menu variant is not available: ${item.variantId}`);
          }
          let availableTemperatures = ['冷酒'];
          try {
            const parsed = JSON.parse(variant.temperature_options_json ?? '[]');
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((temperature) => TEMPERATURES.has(temperature))) availableTemperatures = parsed;
          } catch {
            // Keep malformed legacy data safe by allowing only cold service.
          }
          if (normalized.schemaVersion === 3 && !item.temperature) {
            throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, `A temperature is required: ${item.menuItemId}`);
          }
          if (item.temperature && !availableTemperatures.includes(item.temperature)) {
            throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, `Temperature is not available for menu variant: ${item.variantId}`);
          }
        } else if (activeVariantCount > 0) {
          throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, `A menu variant is required: ${item.menuItemId}`);
        }
        if (item.servingOptionId) {
          servingOption = statements.findServingOption.get(item.servingOptionId);
          if (!servingOption || servingOption.menu_item_id !== item.menuItemId || servingOption.is_active !== 1) {
            throw repositoryError(ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND, `Serving option is not available: ${item.servingOptionId}`);
          }
        } else if (activeServingOptionCount > 0) {
          throw repositoryError(ORDER_ERROR_CODES.INVALID_ORDER_REQUEST, `A serving option is required: ${item.menuItemId}`);
        }
        if (activeVariantCount > 0 && activeServingOptionCount > 0) {
          throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, `Menu item configuration is ambiguous: ${item.menuItemId}`);
        }
        if (MIN_QUANTITY_MENU_ITEM_IDS.has(item.menuItemId) && item.quantity < 2) {
          throw repositoryError(
            ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
            '串カツは各種類2本からご注文いただけます',
          );
        }

        const unitPriceYen = variant?.price_yen ?? menuItem.price_yen;
        const lineTotalYen = unitPriceYen * item.quantity;
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
          unitPriceYenSnapshot: unitPriceYen,
          variantId: variant?.variant_id ?? null,
          variantNameSnapshot: variant?.name ?? null,
          variantVolumeSnapshot: variant?.volume_label ?? null,
          ...(item.temperature ? { temperatureSnapshot: item.temperature } : {}),
          servingOptionId: servingOption?.serving_option_id ?? null,
          servingOptionNameSnapshot: servingOption?.name ?? null,
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
        session.session_id,
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
          snapshot.variantId,
          snapshot.variantNameSnapshot,
          snapshot.variantVolumeSnapshot,
          snapshot.temperatureSnapshot ?? null,
          snapshot.servingOptionId,
          snapshot.servingOptionNameSnapshot,
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
          sessionId: session.session_id,
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
      const table = statements.findAssignedTable.get(principal.deviceId);
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
      const session = statements.findOpenSession.get(table.table_id);
      const history = session
        ? statements.findCustomerHistoryOrders.all(session.session_id).map(loadOrder)
        : [];
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

  function closeTableSession({ principal, tableId, sessionId } = {}) {
    if (closed) {
      throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, 'The order repository is closed.');
    }
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    const normalizedTableId = normalizeTableId(tableId);
    const normalizedSessionId = normalizeUuid(sessionId, 'sessionId');
    let transactionOpen = false;

    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const session = statements.findSession.get(normalizedSessionId);
      if (!session) {
        throw repositoryError(ORDER_ERROR_CODES.SESSION_NOT_FOUND, 'The table session was not found.');
      }
      if (session.table_id !== normalizedTableId) {
        throw repositoryError(ORDER_ERROR_CODES.SESSION_CONFLICT, 'The table session does not belong to this table.');
      }
      if (session.closed_at_ms !== null) {
        database.exec('COMMIT;');
        transactionOpen = false;
        return {
          idempotencyResult: 'replayed',
          tableId: normalizedTableId,
          sessionId: normalizedSessionId,
          closedAtMs: session.closed_at_ms,
          event: null,
        };
      }

      const activeOrderCount = Number(statements.countSessionActiveOrders.get(normalizedSessionId).count);
      if (activeOrderCount > 0) {
        throw repositoryError(
          ORDER_ERROR_CODES.SESSION_HAS_ACTIVE_ORDERS,
          'The table session still has non-terminal orders.',
        );
      }

      const closedAtMs = now();
      if (!Number.isSafeInteger(closedAtMs) || closedAtMs < session.opened_at_ms) {
        throw repositoryError(
          ORDER_ERROR_CODES.DATABASE_FAILURE,
          'now must return a timestamp after the session opened.',
        );
      }
      const updated = statements.closeSession.run(
        closedAtMs,
        closedAtMs,
        normalizedSessionId,
        normalizedTableId,
      );
      if (Number(updated.changes) !== 1) {
        throw repositoryError(ORDER_ERROR_CODES.SESSION_CONFLICT, 'The table session is no longer current.');
      }

      const systemState = statements.findSystemState.get();
      if (!systemState?.event_epoch) {
        throw repositoryError(ORDER_ERROR_CODES.DATABASE_FAILURE, 'Current event epoch is unavailable.');
      }
      const eventPayloadJson = JSON.stringify({
        tableId: normalizedTableId,
        sessionId: normalizedSessionId,
        closedAtMs,
      });
      const eventInsertion = statements.insertSessionCloseEvent.run(
        systemState.event_epoch,
        String(normalizedTableId),
        principal.deviceId,
        eventPayloadJson,
        closedAtMs,
      );

      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        idempotencyResult: 'created',
        tableId: normalizedTableId,
        sessionId: normalizedSessionId,
        closedAtMs,
        event: {
          eventId: Number(eventInsertion.lastInsertRowid),
          eventEpoch: systemState.event_epoch,
          eventType: 'table.assignment_updated',
          payloadJson: eventPayloadJson,
          createdAtMs: closedAtMs,
        },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof OrderRepositoryError) throw error;
      throw repositoryError(
        ORDER_ERROR_CODES.DATABASE_FAILURE,
        'The table session close transaction failed.',
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
    closeTableSession,
    markItemServed,
    close() {
      closed = true;
    },
  });
}
