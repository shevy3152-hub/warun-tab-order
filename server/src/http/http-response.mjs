import { HTTP_ERROR_CODES, createHttpError } from './http-errors.mjs';

const DEVICE_ROLES = new Set(['customer', 'kitchen', 'admin']);
const ORDER_STATUSES = new Set(['new', 'active', 'completed']);
const STAFF_CALL_STATUSES = new Set(['open', 'resolved']);
const EVENT_RESOURCES = new Set(['orders', 'menu', 'staffCalls', 'deviceConfig']);
const EVENT_TYPES_BY_ROLE = Object.freeze({
  customer: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'device.revoked',
    'table.assignment_updated',
  ]),
  kitchen: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'table.assignment_updated',
  ]),
  admin: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'device.paired',
    'device.revoked',
    'table.assignment_updated',
  ]),
});
const SUPPORTED_SCHEMA_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalidDto() {
  return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDto();
  }
  return value;
}

function requireString(value) {
  if (typeof value !== 'string') throw invalidDto();
  return value;
}

function requireExactString(value, expected) {
  if (value !== expected) throw invalidDto();
  return value;
}

function requireOneOf(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) throw invalidDto();
  return value;
}

function requireOpaqueId(value) {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) throw invalidDto();
  return value;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidDto();
  return value;
}

function requireInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalidDto();
  return value;
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw invalidDto();
  return value;
}

function requireArray(value) {
  if (!Array.isArray(value)) throw invalidDto();
  return value;
}

function optionalImageUri(source, target) {
  if (Object.hasOwn(source, 'imageUri')) {
    target.imageUri = requireString(source.imageUri);
  }
  return target;
}

function mapPublicCategory(category) {
  requireObject(category);
  return {
    categoryId: requireOpaqueId(category.categoryId),
    name: requireString(category.name),
    sortOrder: requireInteger(category.sortOrder),
  };
}

function mapAdminCategory(category) {
  requireObject(category);
  return {
    categoryId: requireOpaqueId(category.categoryId),
    name: requireString(category.name),
    sortOrder: requireInteger(category.sortOrder),
    isVisible: requireBoolean(category.isVisible),
    version: requireInteger(category.version, 1),
    updatedAtMs: requireInteger(category.updatedAtMs),
  };
}

function mapCustomerMenuItem(item) {
  requireObject(item);
  return optionalImageUri(item, {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    description: requireString(item.description),
    isSoldOut: requireBoolean(item.isSoldOut),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
  });
}

function mapKitchenMenuItem(item) {
  requireObject(item);
  return {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    kitchenAlias: requireString(item.kitchenAlias),
    isSoldOut: requireBoolean(item.isSoldOut),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
  };
}

function mapAdminMenuItem(item) {
  requireObject(item);
  return optionalImageUri(item, {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    kitchenAlias: requireString(item.kitchenAlias),
    description: requireString(item.description),
    priceYen: requireInteger(item.priceYen),
    isSoldOut: requireBoolean(item.isSoldOut),
    isActive: requireBoolean(item.isActive),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
    updatedAtMs: requireInteger(item.updatedAtMs),
  });
}

function mapCursor(cursor) {
  requireObject(cursor);
  return {
    eventEpoch: requireUuid(cursor.eventEpoch),
    lastEventId: requireInteger(cursor.lastEventId),
  };
}

function requireSameCursor(value, cursor) {
  requireObject(value);
  if (value.eventEpoch !== cursor.eventEpoch || value.lastEventId !== cursor.lastEventId) {
    throw invalidDto();
  }
}

function mapStaffOrderItem(item) {
  requireObject(item);
  const response = {
    orderItemId: requireInteger(item.orderItemId, 1),
    formalNameSnapshot: requireString(item.formalNameSnapshot),
    kitchenAliasSnapshot: requireString(item.kitchenAliasSnapshot),
    unitPriceYenSnapshot: requireInteger(item.unitPriceYenSnapshot),
    quantity: requireInteger(item.quantity, 1),
    lineTotalYen: requireInteger(item.lineTotalYen),
    isServed: requireBoolean(item.isServed),
  };
  if (response.quantity > 99) throw invalidDto();
  if (Object.hasOwn(item, 'menuItemId')) {
    response.menuItemId = requireOpaqueId(item.menuItemId);
  }
  if (Object.hasOwn(item, 'servedAtMs') && item.servedAtMs !== null) {
    response.servedAtMs = requireInteger(item.servedAtMs);
  }
  return response;
}

function mapStaffOrder(order) {
  requireObject(order);
  const items = requireArray(order.items);
  if (items.length === 0) throw invalidDto();
  const response = {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    tableId: requireInteger(order.tableId, 1),
    tableNumberSnapshot: requireInteger(order.tableNumberSnapshot, 1),
    status: requireOneOf(order.status, ORDER_STATUSES),
    totalAmountYen: requireInteger(order.totalAmountYen),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    version: requireInteger(order.version, 1),
    items: items.map(mapStaffOrderItem),
  };
  if (Object.hasOwn(order, 'sessionId')) response.sessionId = requireUuid(order.sessionId);
  if (Object.hasOwn(order, 'completedAtMs') && order.completedAtMs !== null) {
    response.completedAtMs = requireInteger(order.completedAtMs);
  }
  return response;
}

function mapCustomerOrderItem(item) {
  requireObject(item);
  const response = {
    orderItemId: requireInteger(item.orderItemId, 1),
    formalNameSnapshot: requireString(item.formalNameSnapshot),
    quantity: requireInteger(item.quantity, 1),
    isServed: requireBoolean(item.isServed),
  };
  if (response.quantity > 99) throw invalidDto();
  if (Object.hasOwn(item, 'menuItemId')) {
    response.menuItemId = requireOpaqueId(item.menuItemId);
  }
  if (Object.hasOwn(item, 'servedAtMs') && item.servedAtMs !== null) {
    response.servedAtMs = requireInteger(item.servedAtMs);
  }
  return response;
}

function mapCustomerOrder(order) {
  requireObject(order);
  const items = requireArray(order.items);
  if (items.length === 0) throw invalidDto();
  const response = {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    tableNumberSnapshot: requireInteger(order.tableNumberSnapshot, 1),
    status: requireOneOf(order.status, ORDER_STATUSES),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    items: items.map(mapCustomerOrderItem),
  };
  if (Object.hasOwn(order, 'completedAtMs') && order.completedAtMs !== null) {
    response.completedAtMs = requireInteger(order.completedAtMs);
  }
  return response;
}

function mapStaffCall(call) {
  requireObject(call);
  const response = {
    staffCallId: requireUuid(call.staffCallId),
    clientCallId: requireUuid(call.clientCallId),
    tableId: requireInteger(call.tableId, 1),
    tableNumberSnapshot: requireInteger(call.tableNumberSnapshot, 1),
    callType: requireExactString(call.callType, 'staff'),
    status: requireOneOf(call.status, STAFF_CALL_STATUSES),
    createdAtMs: requireInteger(call.createdAtMs),
    version: requireInteger(call.version, 1),
  };
  if (Object.hasOwn(call, 'resolvedAtMs') && call.resolvedAtMs !== null) {
    response.resolvedAtMs = requireInteger(call.resolvedAtMs);
  }
  return response;
}

function mapOpenSession(session) {
  requireObject(session);
  return {
    sessionId: requireUuid(session.sessionId),
    tableId: requireInteger(session.tableId, 1),
    openedAtMs: requireInteger(session.openedAtMs),
    version: requireInteger(session.version, 1),
  };
}

function mapEvent(event, audience, eventEpoch, previousEventId, lastEventId) {
  requireObject(event);
  const eventId = requireInteger(event.eventId, 1);
  if (
    event.audience !== audience
    || event.eventEpoch !== eventEpoch
    || eventId <= previousEventId
    || eventId > lastEventId
  ) {
    throw invalidDto();
  }
  const payload = requireObject(event.payload);
  const type = requireOneOf(event.type, EVENT_TYPES_BY_ROLE[audience]);
  const expectedResource = type.startsWith('order.')
    ? 'orders'
    : type.startsWith('menu.')
      ? 'menu'
      : type.startsWith('staff_call.')
        ? 'staffCalls'
        : 'deviceConfig';
  const resource = requireOneOf(payload.resource, EVENT_RESOURCES);
  if (resource !== expectedResource || requireBoolean(payload.refreshRequired) !== true) {
    throw invalidDto();
  }
  return {
    audience,
    eventEpoch,
    eventId,
    type,
    aggregateId: requireOpaqueId(event.aggregateId),
    occurredAtMs: requireInteger(event.occurredAtMs),
    payload: {
      resource,
      refreshRequired: true,
    },
  };
}

export function mapDeviceConfigResponse(settings) {
  requireObject(settings);
  const eventCursor = mapCursor(settings);
  const role = requireString(settings.role);
  if (!DEVICE_ROLES.has(role)) throw invalidDto();

  const response = {
    deviceId: requireUuid(settings.deviceId),
    role,
    deviceLabel: requireString(settings.deviceLabel),
    status: requireExactString(settings.status, 'active'),
    configVersion: requireInteger(settings.configVersion, 1),
    eventEpoch: eventCursor.eventEpoch,
    lastEventId: eventCursor.lastEventId,
  };

  if (role === 'customer') {
    response.tableId = requireInteger(settings.tableId, 1);
    response.tableLabel = requireString(settings.tableLabel);
    response.tableIsActive = requireBoolean(settings.tableIsActive);
    if (!response.tableIsActive) throw invalidDto();
  }

  return response;
}

export function mapMenuResponse(menu) {
  requireObject(menu);
  const audience = requireString(menu.audience);
  const cursor = mapCursor(menu);
  const categoryRows = requireArray(menu.categories);
  const itemRows = requireArray(menu.items);

  if (audience === 'customer') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapPublicCategory),
      items: itemRows.map(mapCustomerMenuItem),
    };
  }
  if (audience === 'kitchen') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapPublicCategory),
      items: itemRows.map(mapKitchenMenuItem),
    };
  }
  if (audience === 'admin') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapAdminCategory),
      items: itemRows.map(mapAdminMenuItem),
    };
  }

  throw invalidDto();
}

export function mapOrderReceiptResponse(result) {
  requireObject(result);
  const idempotencyResult = requireOneOf(
    result.idempotencyResult,
    new Set(['created', 'replayed']),
  );
  const order = requireObject(result.order);
  return {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    status: requireOneOf(order.status, ORDER_STATUSES),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    idempotencyResult,
  };
}

export function mapOrderHistoryResponse(orders) {
  if (!Array.isArray(orders)) throw invalidDto();
  return { orders: orders.map(mapStaffOrder) };
}

export function mapTableSessionCloseResponse(result) {
  requireObject(result);
  return {
    tableId: requireInteger(result.tableId, 1),
    sessionId: requireUuid(result.sessionId),
    closedAtMs: requireInteger(result.closedAtMs),
    idempotencyResult: requireOneOf(result.idempotencyResult, new Set(['created', 'replayed'])),
  };
}

export function mapCustomerOrderHistoryResponse(orders) {
  if (!Array.isArray(orders)) throw invalidDto();
  return { orders: orders.map(mapCustomerOrder) };
}

export function mapEventReplayResponse(replay) {
  requireObject(replay);
  const audience = requireOneOf(replay.audience, DEVICE_ROLES);
  const eventEpoch = requireUuid(replay.eventEpoch);
  const lastEventId = requireInteger(replay.lastEventId);
  const eventRows = requireArray(replay.events);
  const events = [];
  let previousEventId = 0;
  for (const event of eventRows) {
    const mapped = mapEvent(event, audience, eventEpoch, previousEventId, lastEventId);
    events.push(mapped);
    previousEventId = mapped.eventId;
  }
  return {
    audience,
    eventEpoch,
    events,
    lastEventId,
    hasMore: requireBoolean(replay.hasMore),
  };
}

export function mapSnapshotResponse(snapshot) {
  requireObject(snapshot);
  const audience = requireOneOf(snapshot.audience, DEVICE_ROLES);
  const cursor = mapCursor(snapshot);
  const device = mapDeviceConfigResponse(snapshot.device);
  const menu = mapMenuResponse(snapshot.menu);
  if (device.role !== audience || menu.audience !== audience) throw invalidDto();
  requireSameCursor(device, cursor);
  requireSameCursor(menu, cursor);

  const response = {
    audience,
    eventEpoch: cursor.eventEpoch,
    lastEventId: cursor.lastEventId,
    device,
    menu,
  };
  if (audience === 'kitchen' || audience === 'admin') {
    response.activeOrders = requireArray(snapshot.activeOrders).map(mapStaffOrder);
    response.openStaffCalls = requireArray(snapshot.openStaffCalls).map(mapStaffCall);
    if (Object.hasOwn(snapshot, 'openSessions')) {
      response.openSessions = requireArray(snapshot.openSessions).map(mapOpenSession);
    }
  }
  return response;
}

export function createEventHistoryUnavailableResponse(error, requestId, recoveryCursor) {
  requireObject(error);
  if (error.code !== HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE) throw invalidDto();
  const cursor = mapCursor(recoveryCursor);
  return {
    error: {
      code: HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
      message: 'Event history is unavailable.',
    },
    requestId: requireUuid(requestId),
    recovery: {
      strategy: 'snapshot',
      snapshotUrl: '/v1/snapshot',
      currentEventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
    },
  };
}

export function mapHealthResponse(serviceState, serverTimeMs) {
  requireObject(serviceState);
  const schemaVersion = requireInteger(serviceState.schemaVersion, 1);
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) throw invalidDto();
  return {
    status: 'ready',
    db: 'ready',
    serverTimeMs: requireInteger(serverTimeMs),
    schemaVersion,
    eventEpoch: requireUuid(serviceState.eventEpoch),
  };
}

export function createErrorResponse(error, requestId) {
  return {
    error: {
      code: error.code,
      message: error.publicMessage,
    },
    requestId: requireUuid(requestId),
  };
}

export function writeJsonResponse(
  response,
  {
    statusCode,
    body,
    requestId,
    headers = undefined,
    omitBody = false,
  },
) {
  const json = JSON.stringify(body);
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requireUuid(requestId),
    'Content-Length': Buffer.byteLength(json, 'utf8'),
  };
  response.writeHead(statusCode, { ...baseHeaders, ...headers });
  response.end(omitBody ? undefined : json);
}
