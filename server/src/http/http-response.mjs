import { HTTP_ERROR_CODES, createHttpError } from './http-errors.mjs';

const DEVICE_ROLES = new Set(['customer', 'kitchen', 'admin']);
const SUPPORTED_SCHEMA_VERSION = 1;
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
