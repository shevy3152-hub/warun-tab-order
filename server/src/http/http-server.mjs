import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { diagnosticEndpoint } from '../diagnostics/diagnostic-recorder.mjs';
import {
  AUTH_ERROR_CODES,
  isDeviceAuthError,
} from '../auth/auth-errors.mjs';
import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import {
  BUSINESS_HOURS_ERROR_CODES,
  isBusinessHoursRepositoryError,
} from '../business-hours/business-hours-errors.mjs';
import {
  RIDE_GUIDANCE_ERROR_CODES,
  isRideGuidanceRepositoryError,
} from '../ride-guidance/ride-guidance-errors.mjs';
import {
  CATALOG_ERROR_CODES,
  isCatalogRepositoryError,
} from '../catalog/catalog-errors.mjs';
import { SCHEMA_VERSION } from '../db/database.mjs';
import {
  EVENT_ERROR_CODES,
  isEventRepositoryError,
} from '../events/event-errors.mjs';
import {
  PAIRING_ERROR_CODES,
  isPairingServiceError,
} from '../pairing/pairing-service.mjs';
import {
  SNAPSHOT_ERROR_CODES,
  isSnapshotServiceError,
} from '../events/snapshot-errors.mjs';
import {
  ORDER_ERROR_CODES,
  isOrderRepositoryError,
} from '../orders/order-errors.mjs';
import {
  CHECKOUT_ERROR_CODES,
  isCheckoutRepositoryError,
} from '../checkout/checkout-errors.mjs';
import {
  HTTP_ERROR_CODES,
  createHttpError,
  isReadOnlyHttpError,
} from './http-errors.mjs';
import {
  createErrorResponse,
  createEventHistoryUnavailableResponse,
  mapCustomerOrderHistoryResponse,
  mapCatalogWriteResponse,
  mapBusinessHoursResponse,
  mapRideGuidanceResponse,
  mapRideGuidanceWriteResponse,
  mapCategoryWriteResponse,
  mapMenuOrderingWriteResponse,
  mapDeviceConfigResponse,
  mapEventReplayResponse,
  mapHealthResponse,
  mapMenuResponse,
  mapOrderHistoryResponse,
  mapOrderReceiptResponse,
  mapTableSessionCloseResponse,
  mapCheckoutPublicResponse,
  mapCheckoutStaffResponse,
  mapCheckoutStaffListResponse,
  mapPaymentRecordResponse,
  mapPaymentRecordListResponse,
  mapSnapshotResponse,
  mapPairingPreflightResponse,
  writeJsonResponse,
} from './http-response.mjs';
import {
  ORDER_JSON_BODY_ERROR_CODES,
  isOrderJsonBodyError,
  readOrderJsonBody,
  readJsonBody,
} from './json-body.mjs';

const ROUTE_METHODS = new Map([
  ['/v1/health', 'GET'],
  ['/v1/business-hours', 'GET'],
  ['/v1/ride-guidance', 'GET'],
  ['/v1/device/config', 'GET'],
  ['/v1/menu', 'GET'],
  ['/v1/orders', 'POST'],
  ['/v1/customer/order-history', 'GET'],
  ['/v1/customer/checkout-requests', 'POST'],
  ['/v1/customer/checkout-requests/current', 'GET'],
  ['/v1/kitchen/checkout-requests', 'GET'],
  ['/v1/kitchen/order-items/serve', 'POST'],
  ['/v1/tables/sessions/close', 'POST'],
  ['/v1/kitchen/order-history', 'GET'],
  ['/v1/admin/order-history', 'GET'],
  ['/v1/admin/checkout-requests', 'GET'],
  ['/v1/kitchen/payment-history', 'GET'],
  ['/v1/admin/payment-history', 'GET'],
  ['/v1/admin/diagnostics', 'GET'],
  ['/v1/admin/pairing-preflight', 'GET'],
  ['/v1/snapshot', 'GET'],
  ['/v1/events', 'GET'],
  ['/v1/events/replay', 'GET'],
  ['/v1/admin/pairing-codes', 'POST'],
  ['/v1/pairings/claim', 'POST'],
  ['/v1/admin/devices/revoke', 'POST'],
  ['/v1/admin/catalog/menu-item', 'PUT'],
  ['/v1/admin/catalog/menu-item/image-layouts', 'PUT'],
  ['/v1/admin/catalog/category', 'PUT'],
  ['/v1/admin/catalog/menu-order', 'PUT'],
  ['/v1/admin/business-hours', new Set(['GET', 'PUT'])],
  ['/v1/admin/ride-guidance', 'GET'],
  ['/v1/admin/ride-guidance/pickup', 'PUT'],
  ['/v1/admin/ride-guidance/contacts', 'POST'],
  ['/v1/admin/ride-guidance/contacts/order', 'PUT'],
]);
const READ_ONLY_ROUTE_METHODS = new Map([
  ['/v1/health', 'GET'],
  ['/v1/device/config', 'GET'],
  ['/v1/menu', 'GET'],
]);
const MAX_REQUEST_TARGET_LENGTH = 8_192;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_EPOCH_PATTERN = REQUEST_ID_PATTERN;
const DECIMAL_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_REPLAY_LIMIT = 1_000;

function authenticationFailed() {
  return createHttpError(HTTP_ERROR_CODES.AUTHENTICATION_FAILED);
}

function collectRawHeaderValues(rawHeaders, targetName) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }

  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    }
    if (name.toLowerCase() === targetName) values.push(value);
  }
  return values;
}

export function parseBearerAuthorization(rawHeaders) {
  let authorizationValues;
  try {
    authorizationValues = collectRawHeaderValues(rawHeaders, 'authorization');
  } catch {
    throw authenticationFailed();
  }

  if (authorizationValues.length !== 1) throw authenticationFailed();
  const value = authorizationValues[0];
  if (value.includes(',')) throw authenticationFailed();

  const separatorIndex = value.indexOf(' ');
  if (
    separatorIndex <= 0
    || value.indexOf(' ', separatorIndex + 1) !== -1
    || /\s/.test(value.slice(separatorIndex + 1))
  ) {
    throw authenticationFailed();
  }

  const scheme = value.slice(0, separatorIndex);
  const token = value.slice(separatorIndex + 1);
  if (scheme.toLowerCase() !== 'bearer' || token === '') throw authenticationFailed();
  return token;
}

function parseCanonicalCursor(value, fieldName) {
  if (typeof value !== 'string' || !DECIMAL_CURSOR_PATTERN.test(value)) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  return cursor;
}

export function parseSseCursorHeaders(rawHeaders) {
  const eventIds = collectRawHeaderValues(rawHeaders, 'last-event-id');
  const epochs = collectRawHeaderValues(rawHeaders, 'x-event-epoch');
  if (eventIds.length === 0 && epochs.length === 0) return null;
  if (
    eventIds.length !== 1
    || epochs.length !== 1
    || eventIds[0].includes(',')
    || epochs[0].includes(',')
    || !EVENT_EPOCH_PATTERN.test(epochs[0])
  ) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  return Object.freeze({
    eventEpoch: epochs[0],
    afterEventId: parseCanonicalCursor(eventIds[0], 'Last-Event-ID'),
  });
}

function requestTarget(rawTarget) {
  if (
    typeof rawTarget !== 'string'
    || !rawTarget.startsWith('/')
    || rawTarget.startsWith('//')
  ) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  if (rawTarget.length > MAX_REQUEST_TARGET_LENGTH) {
    throw createHttpError(HTTP_ERROR_CODES.URI_TOO_LONG);
  }
  if (rawTarget.includes('#')) throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);

  let parsed;
  try {
    parsed = new URL(rawTarget, 'http://localhost');
  } catch {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  const queryIndex = rawTarget.indexOf('?');
  const path = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  return { path, parsed };
}

function parseReplayQuery(parsedUrl) {
  const allowed = new Set(['eventEpoch', 'afterEventId', 'limit']);
  for (const key of parsedUrl.searchParams.keys()) {
    if (!allowed.has(key) || parsedUrl.searchParams.getAll(key).length !== 1) {
      throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    }
  }

  const eventEpoch = parsedUrl.searchParams.get('eventEpoch');
  const afterEventId = parsedUrl.searchParams.get('afterEventId');
  if (!EVENT_EPOCH_PATTERN.test(eventEpoch ?? '') || afterEventId === null) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }

  const options = {
    eventEpoch,
    afterEventId: parseCanonicalCursor(afterEventId, 'afterEventId'),
  };
  const rawLimit = parsedUrl.searchParams.get('limit');
  if (rawLimit !== null) {
    const limit = parseCanonicalCursor(rawLimit, 'limit');
    if (limit < 1 || limit > MAX_REPLAY_LIMIT) {
      throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    }
    options.limit = limit;
  }
  return Object.freeze(options);
}

function safeRequestId(requestIdFactory) {
  try {
    const requestId = requestIdFactory();
    if (typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)) return requestId;
  } catch {
    // Fall back without exposing the request-id factory failure.
  }
  return randomUUID();
}

function requestOrigin(request) {
  const host = typeof request?.headers?.host === 'string' ? request.headers.host.trim() : '';
  return host ? `http://${host}` : '';
}

function pairingRegistrationUrl(code, origin) {
  if (typeof code !== 'string' || !code || typeof origin !== 'string' || !origin) return undefined;
  const url = new URL('/pairing.html', origin);
  url.hash = `p=${encodeURIComponent(code)}`;
  return url.toString();
}

function pairingDiagnosticDeviceHash(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
  return createHash('sha256').update(deviceId, 'utf8').digest('hex').slice(0, 16);
}

function writePairingDiagnostic(pairingDiagnosticLogger, { now, status, deviceIdHash, result }) {
  if (typeof pairingDiagnosticLogger !== 'function') return;
  try {
    pairingDiagnosticLogger(Object.freeze({
      timestamp: new Date(now()).toISOString(),
      status,
      deviceIdHash,
      result,
    }));
  } catch {
    // Diagnostics must never change the pairing response or transaction result.
  }
}

function pairingDiagnosticFailureResult(error, httpError, diagnosticStage) {
  if (httpError.statusCode !== 500) return httpError.code;
  let detail = '';
  if (isPairingServiceError(error) && typeof error.code === 'string') {
    detail = error.code;
  } else if (typeof error?.code === 'string' && /^(?:SQLITE_|ERR_)/.test(error.code)) {
    detail = error.code;
  } else if (typeof error?.name === 'string' && error.name !== 'Error') {
    detail = error.name;
  }
  return `INTERNAL_ERROR:${diagnosticStage}${detail ? `:${detail}` : ''}`;
}

function runtimeHealthHeaders(runtimeInfo) {
  if (!runtimeInfo) return undefined;
  return {
    'X-Warun-Environment': runtimeInfo.environment,
    'X-Warun-Database-Target': runtimeInfo.databaseTarget,
    'X-Warun-Database-Identity': runtimeInfo.databaseIdentity,
    'X-Warun-API-Port': String(runtimeInfo.apiPort),
    'X-Warun-Web-Port': String(runtimeInfo.webPort),
    'X-Warun-LAN-IPv4': runtimeInfo.lanIPv4.join(','),
    ...(Number.isSafeInteger(runtimeInfo.processId) ? { 'X-Warun-Process-Id': String(runtimeInfo.processId) } : {}),
  };
}

function recordRequestDiagnostic(diagnosticRecorder, context, { requestId, status, errorCode = null, stage = undefined, resultCount = undefined, activeOrderCount = undefined, openSessionCount = undefined, internalCode = undefined, causeCode = undefined, now = Date.now } = {}) {
  if (!diagnosticRecorder || typeof diagnosticRecorder.record !== 'function' || !context?.endpoint) return;
  diagnosticRecorder.record({
    endpoint: context.endpoint,
    requestId,
    status,
    errorCode,
    durationMs: Math.max(0, now() - context.startedAtMs),
    stage: stage ?? context.stage,
    ...(Number.isSafeInteger(resultCount) ? { resultCount } : {}),
    ...(Number.isSafeInteger(activeOrderCount) ? { activeOrderCount } : {}),
    ...(Number.isSafeInteger(openSessionCount) ? { openSessionCount } : {}),
    ...(typeof context.menuItemId === 'string' ? { menuItemId: context.menuItemId } : {}),
    ...(Number.isSafeInteger(context.expectedVersion) ? { expectedVersion: context.expectedVersion } : {}),
    ...(Number.isSafeInteger(context.actualVersion) ? { actualVersion: context.actualVersion } : {}),
    ...(typeof context.payloadHash === 'string' ? { payloadHash: context.payloadHash } : {}),
    ...(typeof (internalCode ?? context.internalCode) === 'string' ? { internalCode: internalCode ?? context.internalCode } : {}),
    ...(typeof (causeCode ?? context.causeCode) === 'string' ? { causeCode: causeCode ?? context.causeCode } : {}),
  });
}

function diagnosticErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (isCatalogRepositoryError(current) && typeof current.code === 'string') {
      return {
        internalCode: `CATALOG:${current.code}`,
        ...(typeof current.cause?.code === 'string' ? { causeCode: current.cause.code } : {}),
      };
    }
    if (typeof current.code === 'string' && /^(?:SQLITE_|ERR_)[A-Za-z0-9_:-]+$/.test(current.code)) {
      return { internalCode: current.code };
    }
    current = current.cause;
  }
  return {};
}

function readCatalogVersion(database, menuItemId) {
  if (typeof menuItemId !== 'string' || !database || typeof database.prepare !== 'function') return undefined;
  try {
    const row = database.prepare('SELECT version FROM menu_items WHERE menu_item_id = ?').get(menuItemId);
    return Number.isSafeInteger(row?.version) && row.version >= 0 ? row.version : undefined;
  } catch {
    return undefined;
  }
}

function defaultServiceStateReader(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  let statement;
  try {
    statement = database.prepare(`
      SELECT
        s.schema_version,
        s.event_epoch,
        COALESCE(MAX(e.event_id), 0) AS last_event_id
      FROM system_state AS s
      LEFT JOIN event_log AS e
        ON e.event_epoch = s.event_epoch
      WHERE s.singleton_id = 1
      GROUP BY s.schema_version, s.event_epoch
    `);
  } catch {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  return function readServiceState() {
    const row = statement.get();
    if (
      !row
      || row.schema_version !== SCHEMA_VERSION
      || typeof row.event_epoch !== 'string'
      || !Number.isSafeInteger(row.last_event_id)
      || row.last_event_id < 0
    ) {
      throw new Error('Service state is unavailable.');
    }
    return {
      schemaVersion: row.schema_version,
      eventEpoch: row.event_epoch,
      lastEventId: row.last_event_id,
    };
  };
}

function readDiagnosticStorageSummary(database) {
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM order_items) AS order_items,
      (SELECT COUNT(*) FROM event_log) AS event_log
  `).get();
  const statuses = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM orders
    GROUP BY status
    ORDER BY status
  `).all();
  const schema = database.prepare('SELECT schema_version FROM system_state WHERE singleton_id = 1').get();
  return {
    orders: Number(counts?.orders ?? 0),
    orderItems: Number(counts?.order_items ?? 0),
    eventLog: Number(counts?.event_log ?? 0),
    orderStatuses: statuses.map((row) => ({ status: row.status, count: Number(row.count) })),
    schemaVersion: Number(schema?.schema_version ?? 0),
  };
}

function diagnosticOverview({ database, runtimeInfo, pairingService, diagnosticRecorder, principal, now = Date.now } = {}) {
  const tableState = requireService(pairingService, 'getPairingTableState').getPairingTableState();
  const tables = {
    available: tableState.available.map(({ tableId, label }) => ({ tableId, label })),
    assigned: tableState.assigned.map(({ tableId, label, deviceStatus }) => ({ tableId, label, deviceStatus })),
  };
  const recent = diagnosticRecorder && typeof diagnosticRecorder.list === 'function'
    ? diagnosticRecorder.list()
    : [];
  const latestOrderSend = recent.find((entry) => entry.endpoint === 'POST /v1/orders') ?? null;
  const latestOrderRetrieval = recent.find((entry) => [
    'GET /v1/admin/order-history',
    'GET /v1/kitchen/order-history',
    'GET /v1/snapshot',
  ].includes(entry.endpoint)) ?? null;
  const generatedAt = new Date(now()).toISOString();
  const storage = readDiagnosticStorageSummary(database);
  return {
    generatedAt,
    runtime: {
      lanIPv4: Array.isArray(runtimeInfo?.lanIPv4) ? runtimeInfo.lanIPv4 : [],
      webPort: Number(runtimeInfo?.webPort ?? 0),
      apiPort: Number(runtimeInfo?.apiPort ?? 0),
      processId: Number.isSafeInteger(runtimeInfo?.processId) ? runtimeInfo.processId : null,
      databaseTarget: runtimeInfo?.databaseTarget ?? 'unknown',
      isProduction: runtimeInfo?.isProduction === true,
      environment: runtimeInfo?.environment ?? 'unknown',
    },
    health: { status: 'ready', db: 'ready', schemaVersion: storage.schemaVersion },
    schemaVersion: storage.schemaVersion,
    authentication: { status: 'valid', role: principal?.role ?? 'admin' },
    tables,
    storage,
    latestOrderSend,
    latestOrderRetrieval,
    recent: recent.slice(0, 30),
  };
}

function hasBusyCause(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (['SQLITE_BUSY', 'SQLITE_BUSY_TIMEOUT', 'SQLITE_LOCKED'].includes(current.code)) return true;
    if (
      Number.isInteger(current.errcode)
      && [5, 6].includes(current.errcode & 0xff)
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function mapApplicationError(error) {
  if (isReadOnlyHttpError(error)) return error;

  if (isOrderJsonBodyError(error)) {
    if (error.code === ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE) {
      return createHttpError(HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE);
    }
    if (error.code === ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE) {
      return createHttpError(HTTP_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
    }
    return createHttpError(HTTP_ERROR_CODES.INVALID_ORDER_REQUEST);
  }

  if (isDeviceAuthError(error)) {
    if (error.code === AUTH_ERROR_CODES.AUTHENTICATION_FAILED) return authenticationFailed();
    if (error.code === AUTH_ERROR_CODES.AUTHORIZATION_FAILED) {
      return createHttpError(HTTP_ERROR_CODES.AUTHORIZATION_FAILED);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isPairingServiceError(error)) {
    if (error.code === PAIRING_ERROR_CODES.CODE_EXPIRED) return createHttpError(HTTP_ERROR_CODES.PAIRING_EXPIRED);
    if (error.code === PAIRING_ERROR_CODES.TOO_MANY_ATTEMPTS) return createHttpError(HTTP_ERROR_CODES.TOO_MANY_REQUESTS);
    if (error.code === PAIRING_ERROR_CODES.DEVICE_NOT_FOUND) return createHttpError(HTTP_ERROR_CODES.DEVICE_NOT_FOUND);
    if ([
      PAIRING_ERROR_CODES.CODE_USED,
      PAIRING_ERROR_CODES.TABLE_CONFLICT,
      PAIRING_ERROR_CODES.DEVICE_CONFLICT,
    ].includes(error.code)) return createHttpError(HTTP_ERROR_CODES.PAIRING_CONFLICT);
    return createHttpError(HTTP_ERROR_CODES.PAIRING_INVALID);
  }

  if (isCatalogRepositoryError(error)) {
    if (
      error.code === CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED
      || error.code === CATALOG_ERROR_CODES.DEVICE_NOT_ACTIVE
    ) {
      return authenticationFailed();
    }
    if (
      error.code === CATALOG_ERROR_CODES.AUTHORIZATION_FAILED
      || error.code === CATALOG_ERROR_CODES.DEVICE_NOT_ASSIGNED
    ) {
      return createHttpError(HTTP_ERROR_CODES.AUTHORIZATION_FAILED);
    }
    if (error.code === CATALOG_ERROR_CODES.INVALID_WRITE_REQUEST) {
      return createHttpError(HTTP_ERROR_CODES.INVALID_CATALOG_REQUEST);
    }
    if (error.code === CATALOG_ERROR_CODES.VERSION_CONFLICT) {
      return createHttpError(HTTP_ERROR_CODES.CATALOG_CONFLICT);
    }
    if (error.code === CATALOG_ERROR_CODES.CATEGORY_NOT_FOUND) {
      return createHttpError(HTTP_ERROR_CODES.CATALOG_ITEM_NOT_FOUND);
    }
    if (error.code === CATALOG_ERROR_CODES.MENU_ITEM_NOT_FOUND) {
      return createHttpError(HTTP_ERROR_CODES.CATALOG_ITEM_NOT_FOUND);
    }
    if (error.code === CATALOG_ERROR_CODES.ID_CONFLICT) {
      return createHttpError(HTTP_ERROR_CODES.CATALOG_CONFLICT);
    }
    if (error.code === CATALOG_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isBusinessHoursRepositoryError(error)) {
    if (error.code === BUSINESS_HOURS_ERROR_CODES.INVALID_WRITE_REQUEST) {
      return createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    }
    if (error.code === BUSINESS_HOURS_ERROR_CODES.VERSION_CONFLICT) {
      return createHttpError(HTTP_ERROR_CODES.BUSINESS_HOURS_CONFLICT);
    }
    if (error.code === BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isRideGuidanceRepositoryError(error)) {
    if (error.code === RIDE_GUIDANCE_ERROR_CODES.INVALID_WRITE_REQUEST) return createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    if (error.code === RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT) return createHttpError(HTTP_ERROR_CODES.RIDE_GUIDANCE_CONFLICT);
    if (error.code === RIDE_GUIDANCE_ERROR_CODES.CONTACT_NOT_FOUND) return createHttpError(HTTP_ERROR_CODES.NOT_FOUND);
    if (error.code === RIDE_GUIDANCE_ERROR_CODES.CONTACT_ORDER_MISMATCH) return createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    if (error.code === RIDE_GUIDANCE_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isOrderRepositoryError(error)) {
    if (error.code === ORDER_ERROR_CODES.DEVICE_NOT_REGISTERED) return authenticationFailed();
    if (
      error.code === ORDER_ERROR_CODES.DEVICE_NOT_AUTHORIZED
      || error.code === ORDER_ERROR_CODES.DEVICE_NOT_ASSIGNED
      || error.code === ORDER_ERROR_CODES.TABLE_INACTIVE
    ) {
      return createHttpError(HTTP_ERROR_CODES.AUTHORIZATION_FAILED);
    }
    if (error.code === ORDER_ERROR_CODES.INVALID_ORDER_REQUEST) {
      return createHttpError(HTTP_ERROR_CODES.INVALID_ORDER_REQUEST);
    }
    if (error.code === ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND) {
      return createHttpError(HTTP_ERROR_CODES.MENU_ITEM_NOT_FOUND);
    }
    if (error.code === ORDER_ERROR_CODES.MENU_ITEM_SOLD_OUT) {
      return createHttpError(HTTP_ERROR_CODES.MENU_ITEM_SOLD_OUT);
    }
    if (error.code === ORDER_ERROR_CODES.MENU_ITEM_RESERVATION_ONLY) {
      return createHttpError(HTTP_ERROR_CODES.MENU_ITEM_RESERVATION_ONLY);
    }
    if (error.code === ORDER_ERROR_CODES.ORDER_CONFLICT) {
      return createHttpError(HTTP_ERROR_CODES.ORDER_CONFLICT);
    }
    if (error.code === ORDER_ERROR_CODES.ORDER_NOT_FOUND) {
      return createHttpError(HTTP_ERROR_CODES.ORDER_NOT_FOUND);
    }
    if (error.code === ORDER_ERROR_CODES.SESSION_NOT_FOUND) {
      return createHttpError(HTTP_ERROR_CODES.SESSION_NOT_FOUND);
    }
    if (
      error.code === ORDER_ERROR_CODES.SESSION_CONFLICT
      || error.code === ORDER_ERROR_CODES.SESSION_HAS_ACTIVE_ORDERS
    ) {
      return createHttpError(
        error.code === ORDER_ERROR_CODES.SESSION_CONFLICT
          ? HTTP_ERROR_CODES.SESSION_CONFLICT
          : HTTP_ERROR_CODES.SESSION_HAS_ACTIVE_ORDERS,
      );
    }
    if (error.code === ORDER_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isCheckoutRepositoryError(error)) {
    if (error.code === CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST) return createHttpError(HTTP_ERROR_CODES.INVALID_CHECKOUT_REQUEST);
    if (error.code === CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT) return createHttpError(HTTP_ERROR_CODES.CHECKOUT_CONFLICT);
    if (error.code === CHECKOUT_ERROR_CODES.VERSION_CONFLICT) return createHttpError(HTTP_ERROR_CODES.CHECKOUT_VERSION_CONFLICT);
    if (error.code === CHECKOUT_ERROR_CODES.CHECKOUT_NOT_FOUND) return createHttpError(HTTP_ERROR_CODES.CHECKOUT_NOT_FOUND);
    if (error.code === CHECKOUT_ERROR_CODES.SESSION_NOT_FOUND) return createHttpError(HTTP_ERROR_CODES.CHECKOUT_SESSION_NOT_FOUND);
    if (error.code === CHECKOUT_ERROR_CODES.PAYMENT_CONFLICT) return createHttpError(HTTP_ERROR_CODES.PAYMENT_CONFLICT);
    if (error.code === CHECKOUT_ERROR_CODES.PAYMENT_NOT_FOUND) return createHttpError(HTTP_ERROR_CODES.PAYMENT_NOT_FOUND);
    if (error.code === CHECKOUT_ERROR_CODES.PAYMENT_VERSION_CONFLICT) return createHttpError(HTTP_ERROR_CODES.PAYMENT_VERSION_CONFLICT);
    if (error.code === CHECKOUT_ERROR_CODES.PAYMENT_ORDER_CHANGED) return createHttpError(HTTP_ERROR_CODES.PAYMENT_ORDER_CHANGED);
    if (error.code === CHECKOUT_ERROR_CODES.INVALID_PAYMENT_REQUEST) return createHttpError(HTTP_ERROR_CODES.INVALID_PAYMENT_REQUEST);
    if (error.code === CHECKOUT_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isEventRepositoryError(error)) {
    if (
      error.code === EVENT_ERROR_CODES.AUTHENTICATION_REQUIRED
      || error.code === EVENT_ERROR_CODES.DEVICE_NOT_ACTIVE
    ) {
      return authenticationFailed();
    }
    if (
      error.code === EVENT_ERROR_CODES.AUTHORIZATION_FAILED
      || error.code === EVENT_ERROR_CODES.DEVICE_NOT_ASSIGNED
    ) {
      return createHttpError(HTTP_ERROR_CODES.AUTHORIZATION_FAILED);
    }
    if (error.code === EVENT_ERROR_CODES.INVALID_EVENT_REQUEST) {
      return createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
    }
    if (error.code === EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE) {
      return createHttpError(HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE);
    }
    if (error.code === EVENT_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  if (isSnapshotServiceError(error)) {
    if (
      error.code === SNAPSHOT_ERROR_CODES.AUTHENTICATION_REQUIRED
      || error.code === SNAPSHOT_ERROR_CODES.DEVICE_NOT_ACTIVE
    ) {
      return authenticationFailed();
    }
    if (
      error.code === SNAPSHOT_ERROR_CODES.AUTHORIZATION_FAILED
      || error.code === SNAPSHOT_ERROR_CODES.DEVICE_NOT_ASSIGNED
    ) {
      return createHttpError(HTTP_ERROR_CODES.AUTHORIZATION_FAILED);
    }
    if (error.code === SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    if (error.code === SNAPSHOT_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
    return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }
  return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
}

function drainRequest(request) {
  if (!request.destroyed && !request.readableEnded) request.resume();
}

function requireService(service, methodName) {
  if (!service || typeof service[methodName] !== 'function') {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }
  return service;
}

function authenticateRequest(request, authenticator) {
  const token = parseBearerAuthorization(request.rawHeaders);
  return authenticator.authenticateDeviceToken(token);
}

function attachMenuDiagnosticLifecycle({ recorder, request, response, requestId, now }) {
  if (!recorder || typeof recorder.record !== 'function') return undefined;
  const context = {
    requestId,
    sourceIp: request.socket?.remoteAddress ?? null,
    host: request.headers?.host ?? null,
    authorizationPresent: request.headers?.authorization !== undefined,
    authClassification: request.headers?.authorization === undefined
      ? 'missing'
      : 'authentication_pending',
    startedAtMs: now(),
  };
  let settled = false;

  const record = (completion) => {
    if (settled) return;
    settled = true;
    try {
      recorder.record({
        timestamp: new Date(now()).toISOString(),
        requestId: context.requestId,
        sourceIp: context.sourceIp,
        host: context.host,
        method: 'GET',
        pathname: '/v1/menu',
        authorizationPresent: context.authorizationPresent,
        authClassification: context.authClassification,
        status: completion === 'interrupted' && !response.headersSent ? null : response.statusCode,
        durationMs: Math.max(0, now() - context.startedAtMs),
        completion,
      });
    } catch {
      // A diagnostic failure must never alter the API response or process lifetime.
    }
  };

  response.once('finish', () => record('completed'));
  response.once('close', () => record('interrupted'));
  return context;
}

async function notifyCommittedSafely(sseHub, result) {
  if (
    result?.idempotencyResult !== 'created'
    || !result.event
    || !sseHub
    || typeof sseHub.notifyCommitted !== 'function'
  ) {
    return;
  }
  try {
    await Promise.resolve(sseHub.notifyCommitted({
      eventEpoch: result.event.eventEpoch,
      eventId: result.event.eventId,
    }));
  } catch {
    // The durable event_log is authoritative; a live wake failure is replayable.
  }
}

function responseHeadersForError(httpError, allow) {
  const headers = {};
  if (httpError.statusCode === 401) headers['WWW-Authenticate'] = 'Bearer';
  if (httpError.statusCode === 405 && allow) headers.Allow = allow;
  if (httpError.statusCode === 503) headers['Retry-After'] = '1';
  if (httpError.statusCode === 413) headers.Connection = 'close';
  return headers;
}

function sendError({
  request,
  response,
  error,
  requestId,
  allow,
  principal,
  eventRepository,
  diagnosticRecorder,
  diagnosticContext,
  now = Date.now,
}) {
  response.removeHeader?.('X-Event-Epoch');
  let httpError = mapApplicationError(error);
  let body;
  if (
    httpError.code === HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE
    && principal
    && eventRepository
    && typeof eventRepository.getCurrentCursor === 'function'
  ) {
    try {
      const cursor = eventRepository.getCurrentCursor(principal);
      body = createEventHistoryUnavailableResponse(httpError, requestId, cursor);
    } catch {
      httpError = createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
    }
  }
  body ??= createErrorResponse(httpError, requestId);

  recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, {
    requestId,
    status: httpError.statusCode,
    errorCode: httpError.code,
    ...diagnosticErrorCode(error),
    now,
  });

  writeJsonResponse(response, {
    statusCode: httpError.statusCode,
    body,
    requestId,
    headers: responseHeadersForError(httpError, allow),
    omitBody: request.method === 'HEAD',
  });
}

function createConfiguredHttpServer({
  database,
  authenticator,
  catalog,
  orderRepository = undefined,
  eventRepository = undefined,
  snapshotService = undefined,
  sseHub = undefined,
  pairingService = undefined,
  runtimeInfo = undefined,
  readServiceState = undefined,
  requestIdFactory = randomUUID,
  now = Date.now,
  pairingDiagnosticLogger = undefined,
  diagnosticRecorder = undefined,
  menuDiagnosticRecorder = undefined,
  businessHours = undefined,
  rideGuidance = undefined,
  checkout = undefined,
} = {}, { integrated }) {
  if (
    !authenticator
    || typeof authenticator.authenticateDeviceToken !== 'function'
    || !catalog
    || typeof catalog.getDeviceSettings !== 'function'
    || typeof catalog.getMenuForPrincipal !== 'function'
    || typeof requestIdFactory !== 'function'
    || typeof now !== 'function'
  ) {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }
  if (
    integrated
    && (
      typeof catalog.writeMenuItem !== 'function'
      || typeof catalog.writeImageLayouts !== 'function'
      || typeof catalog.writeCategory !== 'function'
      || typeof catalog.writeMenuOrdering !== 'function'
      || !orderRepository
      || typeof orderRepository.createOrder !== 'function'
      || typeof orderRepository.getCustomerHistory !== 'function'
      || typeof orderRepository.getHistory !== 'function'
      || typeof orderRepository.closeTableSession !== 'function'
      || typeof orderRepository.markItemServed !== 'function'
      || !eventRepository
      || typeof eventRepository.replay !== 'function'
      || typeof eventRepository.readCommittedForPrincipal !== 'function'
      || typeof eventRepository.getCurrentCursor !== 'function'
      || !snapshotService
      || typeof snapshotService.getSnapshot !== 'function'
      || !sseHub
      || typeof sseHub.attach !== 'function'
      || typeof sseHub.notifyCommitted !== 'function'
      || typeof sseHub.close !== 'function'
    )
  ) {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  const serviceStateReader = readServiceState ?? defaultServiceStateReader(database);
  if (typeof serviceStateReader !== 'function') {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }
  const routeMethods = integrated ? ROUTE_METHODS : READ_ONLY_ROUTE_METHODS;

  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    const requestId = safeRequestId(requestIdFactory);
    let principal;
    let allowedMethod;
    let diagnosticContext;
    let menuDiagnosticContext;

    const handle = async () => {
      const target = requestTarget(request.url);
      let configuredMethods = routeMethods.get(target.path);
      if (!configuredMethods && integrated && /^\/v1\/admin\/ride-guidance\/contacts\/[A-Za-z0-9_-]{1,64}$/.test(target.path)) {
        configuredMethods = new Set(['PUT', 'DELETE']);
      }
      if (!configuredMethods && integrated && /^\/v1\/(kitchen|admin)\/checkout-requests\/[0-9a-f-]{36}\/(adjustments|ready|cancel|pay)$/.test(target.path)) {
        configuredMethods = target.path.endsWith('/adjustments') ? 'PUT' : 'POST';
      }
      if (!configuredMethods && integrated && /^\/v1\/(kitchen|admin)\/payment-records\/[0-9a-f-]{36}\/void$/.test(target.path)) {
        configuredMethods = 'POST';
      }
      if (!configuredMethods) {
        drainRequest(request);
        throw createHttpError(HTTP_ERROR_CODES.NOT_FOUND);
      }
      const allowedMethods = configuredMethods instanceof Set ? configuredMethods : new Set([configuredMethods]);
      allowedMethod = [...allowedMethods].join(', ');
      if (!allowedMethods.has(request.method)) {
        drainRequest(request);
        throw createHttpError(HTTP_ERROR_CODES.METHOD_NOT_ALLOWED);
      }
      const endpoint = diagnosticEndpoint(request.method, target.path);
      diagnosticContext = endpoint
        ? { endpoint, startedAtMs: now(), stage: 'received' }
        : undefined;
      if (target.path === '/v1/menu') {
        menuDiagnosticContext = attachMenuDiagnosticLifecycle({
          recorder: menuDiagnosticRecorder,
          request,
          response,
          requestId,
          now,
        });
      }

      if (target.path === '/v1/health') {
        drainRequest(request);
        let body;
        try {
          body = mapHealthResponse(serviceStateReader(), now());
        } catch {
          throw createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
        }
        writeJsonResponse(response, { statusCode: 200, body, requestId, headers: runtimeHealthHeaders(runtimeInfo) });
        return;
      }

      if (target.path === '/v1/business-hours') {
        drainRequest(request);
        const settings = requireService(businessHours, 'getBusinessHours').getBusinessHours();
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapBusinessHoursResponse(settings),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/ride-guidance') {
        drainRequest(request);
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapRideGuidanceResponse(requireService(rideGuidance, 'getPublicGuidance').getPublicGuidance()),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/pairings/claim') {
        const pairings = requireService(pairingService, 'claimPairingCode');
        let deviceIdHash = null;
        let diagnosticStage = 'read';
        try {
          const body = await readJsonBody(request);
          if (diagnosticContext) diagnosticContext.stage = 'body-read';
          deviceIdHash = pairingDiagnosticDeviceHash(body?.deviceId);
          diagnosticStage = 'claim';
          if (diagnosticContext) diagnosticContext.stage = 'claim';
          const claim = pairings.claimPairingCodeRequest({
            pairingCode: body?.pairingCode,
            deviceId: body?.deviceId,
            displayName: body?.displayName,
            appVersion: body?.appVersion,
          });
          if (diagnosticContext) diagnosticContext.stage = 'saved';
          diagnosticStage = 'authenticate';
          const claimedPrincipal = authenticator.authenticateDeviceToken(claim.deviceToken);
          diagnosticStage = 'device-config';
          const config = mapDeviceConfigResponse(catalog.getDeviceSettings(claimedPrincipal));
          diagnosticStage = 'response';
          if (diagnosticContext) diagnosticContext.stage = 'response';
          writePairingDiagnostic(pairingDiagnosticLogger, { now, status: 201, deviceIdHash, result: 'claimed' });
          recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 201, now });
          writeJsonResponse(response, {
            statusCode: 201,
            body: { deviceToken: claim.deviceToken, config },
            requestId,
          });
          return;
        } catch (error) {
          const httpError = mapApplicationError(error);
          writePairingDiagnostic(pairingDiagnosticLogger, {
            now,
            status: httpError.statusCode,
            deviceIdHash,
            result: pairingDiagnosticFailureResult(error, httpError, diagnosticStage),
          });
          throw error;
        }
      }

      try {
        principal = authenticateRequest(request, authenticator);
        if (menuDiagnosticContext) menuDiagnosticContext.authClassification = 'authenticated';
      } catch (error) {
        if (menuDiagnosticContext) {
          menuDiagnosticContext.authClassification = menuDiagnosticContext.authorizationPresent
            ? 'authentication_rejected'
            : 'missing';
        }
        throw error;
      }
      if (diagnosticContext) diagnosticContext.stage = 'authenticated';

      if (target.path === '/v1/admin/pairing-preflight') {
        authorizeDeviceRole(principal, ['admin']);
        if (diagnosticContext) diagnosticContext.stage = 'retrieved';
        const pairings = requireService(pairingService, 'getPairingTableState');
        const body = mapPairingPreflightResponse({
          runtimeInfo: runtimeInfo ?? {
            environment: 'unknown',
            databasePath: 'unknown',
            databaseTarget: 'unknown',
            isProduction: false,
            apiPort: 1,
            webPort: 1,
            lanIPv4: [],
            webOrigins: ['http://127.0.0.1:1'],
            pairingUrlOrigin: 'http://127.0.0.1:1',
            pairingUrlTemplate: 'http://127.0.0.1:1/pairing.html#p={code}',
          },
          tables: pairings.getPairingTableState(),
          requestOrigin: requestOrigin(request),
        });
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 200, resultCount: body.tables.available.length + body.tables.assigned.length, now });
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      if (target.path === '/v1/admin/business-hours') {
        authorizeDeviceRole(principal, ['admin']);
        const settingsRepository = requireService(businessHours, request.method === 'GET' ? 'getBusinessHours' : 'writeBusinessHours');
        if (request.method === 'GET') {
          drainRequest(request);
          writeJsonResponse(response, {
            statusCode: 200,
            body: mapBusinessHoursResponse(settingsRepository.getBusinessHours(), { includeVersion: true }),
            requestId,
          });
          return;
        }
        const body = await readJsonBody(request);
        const result = settingsRepository.writeBusinessHours(principal, body);
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapBusinessHoursResponse(result, { includeVersion: true }),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/admin/ride-guidance') {
        authorizeDeviceRole(principal, ['admin']);
        drainRequest(request);
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapRideGuidanceResponse(requireService(rideGuidance, 'getAdminGuidance').getAdminGuidance(), { includeHidden: true }),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/admin/ride-guidance/pickup') {
        authorizeDeviceRole(principal, ['admin']);
        const result = requireService(rideGuidance, 'updatePickup').updatePickup(principal, await readJsonBody(request));
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, { statusCode: 200, body: mapRideGuidanceWriteResponse(result), requestId });
        return;
      }

      if (target.path === '/v1/admin/ride-guidance/contacts') {
        authorizeDeviceRole(principal, ['admin']);
        const result = requireService(rideGuidance, 'addContact').addContact(principal, await readJsonBody(request));
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, { statusCode: 201, body: mapRideGuidanceWriteResponse(result), requestId });
        return;
      }

      if (target.path === '/v1/admin/ride-guidance/contacts/order') {
        authorizeDeviceRole(principal, ['admin']);
        const result = requireService(rideGuidance, 'reorderContacts').reorderContacts(principal, await readJsonBody(request));
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, { statusCode: 200, body: mapRideGuidanceWriteResponse(result), requestId });
        return;
      }

      if (target.path.startsWith('/v1/admin/ride-guidance/contacts/')) {
        authorizeDeviceRole(principal, ['admin']);
        const contactId = target.path.slice('/v1/admin/ride-guidance/contacts/'.length);
        const body = await readJsonBody(request);
        const result = request.method === 'DELETE'
          ? requireService(rideGuidance, 'deleteContact').deleteContact(principal, { ...body, id: contactId })
          : requireService(rideGuidance, 'updateContact').updateContact(principal, { ...body, id: contactId });
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, { statusCode: 200, body: mapRideGuidanceWriteResponse(result), requestId });
        return;
      }

      if (target.path === '/v1/admin/diagnostics') {
        authorizeDeviceRole(principal, ['admin']);
        const body = diagnosticOverview({
          database,
          runtimeInfo,
          pairingService,
          diagnosticRecorder,
          principal,
          now,
        });
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      if (target.path === '/v1/orders') {
        const orders = requireService(orderRepository, 'createOrder');
        authorizeDeviceRole(principal, ['customer']);
        if (diagnosticContext) diagnosticContext.stage = 'authorized';
        if (diagnosticContext) diagnosticContext.stage = 'body-read';
        const body = await readOrderJsonBody(request);
        if (diagnosticContext) diagnosticContext.stage = 'validated';
        if (diagnosticContext) diagnosticContext.stage = 'repository-validation';
        const result = orders.createOrder({
          schemaVersion: body.schemaVersion,
          clientOrderId: body.clientOrderId,
          authenticatedDeviceId: principal.deviceId,
          items: body.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            ...(item.variantId ? { variantId: item.variantId } : {}),
            ...(item.temperature ? { temperature: item.temperature } : {}),
            ...(item.servingOptionId ? { servingOptionId: item.servingOptionId } : {}),
          })),
        });
        if (diagnosticContext) diagnosticContext.stage = 'saved';
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        const receipt = mapOrderReceiptResponse(result);
        if (diagnosticContext) diagnosticContext.stage = 'response';
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, {
          requestId,
          status: result.idempotencyResult === 'created' ? 201 : 200,
          now,
        });
        writeJsonResponse(response, {
          statusCode: result.idempotencyResult === 'created' ? 201 : 200,
          body: receipt,
          requestId,
          headers: { 'Idempotency-Result': result.idempotencyResult },
        });
        return;
      }

      if (target.path === '/v1/kitchen/order-items/serve') {
        authorizeDeviceRole(principal, ['kitchen', 'admin']);
        const orders = requireService(orderRepository, 'markItemServed');
        const body = await readJsonBody(request);
        const result = orders.markItemServed({
          principal,
          orderId: body?.orderId,
          orderItemId: body?.orderItemId,
        });
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapOrderHistoryResponse([result.order]),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/tables/sessions/close') {
        authorizeDeviceRole(principal, ['kitchen', 'admin']);
        const orders = requireService(orderRepository, 'closeTableSession');
        const body = await readJsonBody(request);
        const result = orders.closeTableSession({
          principal,
          tableId: body?.tableId,
          sessionId: body?.sessionId,
        });
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapTableSessionCloseResponse(result),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/kitchen/order-history' || target.path === '/v1/admin/order-history') {
        authorizeDeviceRole(principal, target.path === '/v1/kitchen/order-history' ? ['kitchen', 'admin'] : ['admin']);
        if (diagnosticContext) diagnosticContext.stage = 'retrieve';
        const orders = requireService(orderRepository, 'getHistory');
        const history = orders.getHistory(principal);
        if (diagnosticContext) diagnosticContext.stage = 'retrieved';
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 200, resultCount: history.length, now });
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapOrderHistoryResponse(history),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/customer/order-history') {
        authorizeDeviceRole(principal, ['customer']);
        const orders = requireService(orderRepository, 'getCustomerHistory');
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapCustomerOrderHistoryResponse(orders.getCustomerHistory(principal)),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/customer/checkout-requests') {
        authorizeDeviceRole(principal, ['customer']);
        const body = await readJsonBody(request);
        const result = requireService(checkout, 'createCheckout').createCheckout({
          principal,
          checkoutRequestId: body?.checkoutRequestId,
          receiptRequested: body?.receiptRequested,
        });
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, {
          statusCode: result.idempotencyResult === 'created' ? 201 : 200,
          body: mapCheckoutPublicResponse(result.request),
          requestId,
          headers: { 'Idempotency-Result': result.idempotencyResult },
        });
        return;
      }

      if (target.path === '/v1/customer/checkout-requests/current') {
        authorizeDeviceRole(principal, ['customer']);
        drainRequest(request);
        const current = requireService(checkout, 'getCustomerCheckout').getCustomerCheckout(principal);
        writeJsonResponse(response, { statusCode: 200, body: { checkout: current ? mapCheckoutPublicResponse(current) : null }, requestId });
        return;
      }

      if (target.path === '/v1/kitchen/checkout-requests' || target.path === '/v1/admin/checkout-requests') {
        authorizeDeviceRole(principal, target.path.startsWith('/v1/kitchen/') ? ['kitchen', 'admin'] : ['admin']);
        drainRequest(request);
        const list = requireService(checkout, 'listActive').listActive({ principal });
        writeJsonResponse(response, { statusCode: 200, body: mapCheckoutStaffListResponse(list), requestId });
        return;
      }

      if (target.path === '/v1/kitchen/payment-history' || target.path === '/v1/admin/payment-history') {
        authorizeDeviceRole(principal, target.path.startsWith('/v1/kitchen/') ? ['kitchen', 'admin'] : ['admin']);
        drainRequest(request);
        const payments = requireService(checkout, 'listPaymentHistory').listPaymentHistory({ principal });
        writeJsonResponse(response, { statusCode: 200, body: mapPaymentRecordListResponse(payments), requestId });
        return;
      }

      const checkoutMutation = target.path.match(/^\/v1\/(kitchen|admin)\/checkout-requests\/([0-9a-f-]{36})\/(adjustments|ready|cancel|pay)$/);
      if (checkoutMutation) {
        const [, audience, checkoutRequestId, operation] = checkoutMutation;
        authorizeDeviceRole(principal, audience === 'kitchen' ? ['kitchen', 'admin'] : ['admin']);
        const body = await readJsonBody(request);
        const repository = requireService(checkout, operation === 'adjustments' ? 'saveAdjustments' : operation);
        const result = operation === 'adjustments'
          ? repository.saveAdjustments({ principal, checkoutRequestId, expectedVersion: body?.expectedVersion, adjustments: body?.adjustments })
          : operation === 'pay'
            ? repository.pay({ principal, checkoutRequestId, expectedVersion: body?.expectedVersion, paymentMethod: body?.paymentMethod })
          : repository[operation]({ principal, checkoutRequestId, expectedVersion: body?.expectedVersion });
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, {
          statusCode: 200,
          body: operation === 'pay' ? mapPaymentRecordResponse(result.payment) : mapCheckoutStaffResponse(result.request),
          requestId,
          headers: { 'Idempotency-Result': result.idempotencyResult },
        });
        return;
      }

      const paymentVoid = target.path.match(/^\/v1\/(kitchen|admin)\/payment-records\/([0-9a-f-]{36})\/void$/);
      if (paymentVoid) {
        const [, audience, paymentRecordId] = paymentVoid;
        authorizeDeviceRole(principal, audience === 'kitchen' ? ['kitchen', 'admin'] : ['admin']);
        const body = await readJsonBody(request);
        const result = requireService(checkout, 'voidPayment').voidPayment({ principal, paymentRecordId, expectedVersion: body?.expectedVersion, reason: body?.reason });
        await notifyCommittedSafely(sseHub, result);
        writeJsonResponse(response, { statusCode: 200, body: mapPaymentRecordResponse(result.payment), requestId, headers: { 'Idempotency-Result': result.idempotencyResult } });
        return;
      }

      if (target.path === '/v1/admin/pairing-codes' || target.path === '/v1/admin/devices/revoke') {
        authorizeDeviceRole(principal, ['admin']);
        const pairings = requireService(pairingService, target.path === '/v1/admin/pairing-codes' ? 'createPairingCode' : 'revokeDevice');
        if (diagnosticContext) diagnosticContext.stage = 'body-read';
        const body = await readJsonBody(request);
        if (diagnosticContext) diagnosticContext.stage = 'mutation';
        if (target.path === '/v1/admin/pairing-codes') {
          const pairing = pairings.createPairingCodeRequest({
            role: body?.role,
            tableId: body?.tableId,
            expiresAtMs: body?.expiresAtMs,
          }, { createdByDeviceId: principal.deviceId });
          const pairingUrl = pairingRegistrationUrl(pairing.code, runtimeInfo?.pairingUrlOrigin);
          if (diagnosticContext) diagnosticContext.stage = 'saved';
          recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 201, now });
          writeJsonResponse(response, {
            statusCode: 201,
            body: pairingUrl ? { ...pairing, pairingUrl } : pairing,
            requestId,
          });
          return;
        }
        const revoked = pairings.revokeDeviceRequest({ deviceId: body?.deviceId }, { actorDeviceId: principal.deviceId });
        if (diagnosticContext) diagnosticContext.stage = 'saved';
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 200, now });
        writeJsonResponse(response, { statusCode: 200, body: revoked, requestId });
        return;
      }

      if (target.path === '/v1/admin/catalog/menu-item/image-layouts') {
        authorizeDeviceRole(principal, ['admin']);
        const body = await readJsonBody(request);
        const writer = requireService(catalog, 'writeImageLayouts');
        const result = writer.writeImageLayouts(principal, body);
        await notifyCommittedSafely(sseHub, { event: { eventEpoch: result.eventEpoch, eventId: result.eventId } });
        writeJsonResponse(response, { statusCode: 200, body: result, requestId });
        return;
      }

      if (target.path === '/v1/admin/catalog/menu-item') {
        authorizeDeviceRole(principal, ['admin']);
        const catalogWriter = requireService(catalog, 'writeMenuItem');
        if (diagnosticContext) diagnosticContext.stage = 'body-read';
        const body = await readJsonBody(request);
        if (diagnosticContext) {
          diagnosticContext.menuItemId = typeof body?.menuItemId === 'string' ? body.menuItemId : undefined;
          diagnosticContext.expectedVersion = Number.isSafeInteger(body?.expectedVersion) ? body.expectedVersion : undefined;
          diagnosticContext.actualVersion = readCatalogVersion(database, body?.menuItemId);
          diagnosticContext.payloadHash = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
        }
        if (diagnosticContext) diagnosticContext.stage = 'mutation';
        const result = catalogWriter.writeMenuItem(principal, body);
        if (diagnosticContext) diagnosticContext.stage = 'saved';
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        if (diagnosticContext) diagnosticContext.stage = 'response';
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 200, now });
        writeJsonResponse(response, {
          statusCode: 200,
          body: mapCatalogWriteResponse(result),
          requestId,
        });
        return;
      }

      if (target.path === '/v1/admin/catalog/category' || target.path === '/v1/admin/catalog/menu-order') {
        authorizeDeviceRole(principal, ['admin']);
        const isCategoryWrite = target.path.endsWith('/category');
        const writer = requireService(catalog, isCategoryWrite ? 'writeCategory' : 'writeMenuOrdering');
        if (diagnosticContext) diagnosticContext.stage = 'body-read';
        const body = await readJsonBody(request);
        if (diagnosticContext) diagnosticContext.stage = 'mutation';
        const result = isCategoryWrite
          ? writer.writeCategory(principal, body)
          : writer.writeMenuOrdering(principal, body);
        if (diagnosticContext) diagnosticContext.stage = 'saved';
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, { requestId, status: 200, now });
        writeJsonResponse(response, {
          statusCode: 200,
          body: isCategoryWrite ? mapCategoryWriteResponse(result) : mapMenuOrderingWriteResponse(result),
          requestId,
        });
        return;
      }

      drainRequest(request);

      if (target.path === '/v1/device/config') {
        const body = mapDeviceConfigResponse(catalog.getDeviceSettings(principal));
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      if (target.path === '/v1/menu') {
        const body = mapMenuResponse(catalog.getMenuForPrincipal(principal));
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      if (target.path === '/v1/snapshot') {
        const snapshots = requireService(snapshotService, 'getSnapshot');
        if (diagnosticContext) diagnosticContext.stage = 'retrieve';
        const body = mapSnapshotResponse(snapshots.getSnapshot(principal));
        if (diagnosticContext) diagnosticContext.stage = 'retrieved';
        recordRequestDiagnostic(diagnosticRecorder, diagnosticContext, {
          requestId,
          status: 200,
          activeOrderCount: body.activeOrders?.length,
          openSessionCount: body.openSessions?.length,
          now,
        });
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      const events = requireService(eventRepository, 'readCommittedForPrincipal');
      if (target.path === '/v1/events/replay') {
        const options = parseReplayQuery(target.parsed);
        const body = mapEventReplayResponse(events.replay({ principal, ...options }));
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      const hub = requireService(sseHub, 'attach');
      const suppliedCursor = parseSseCursorHeaders(request.rawHeaders);
      let cursor;
      if (suppliedCursor === null) {
        cursor = events.getCurrentCursor(principal);
      } else {
        events.readCommittedForPrincipal(principal, {
          eventEpoch: suppliedCursor.eventEpoch,
          afterEventId: suppliedCursor.afterEventId,
          throughEventId: suppliedCursor.afterEventId,
          limit: 1,
        });
        cursor = suppliedCursor;
      }

      response.setHeader('X-Event-Epoch', cursor.eventEpoch);
      response.setHeader('X-Request-Id', requestId);
      const connection = hub.attach({
        request,
        response,
        principal,
        eventEpoch: cursor.eventEpoch,
        afterEventId: cursor.afterEventId ?? cursor.lastEventId,
      });
      await connection.ready;
    };

    handle().catch((error) => {
      if (menuDiagnosticContext && menuDiagnosticContext.authClassification === 'authenticated') {
        const mappedError = mapApplicationError(error);
        if (mappedError.statusCode === 403) menuDiagnosticContext.authClassification = 'authorization_rejected';
      }
      if (!response.headersSent && !response.destroyed) {
        drainRequest(request);
        try {
          sendError({
            request,
            response,
            error,
            requestId,
            allow: allowedMethod,
            principal,
            eventRepository,
            diagnosticRecorder,
            diagnosticContext,
            now,
          });
        } catch {
          if (!response.destroyed) response.destroy();
        }
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;

  const closeListener = server.close.bind(server);
  server.close = function close(callback) {
    try {
      sseHub?.close?.();
    } catch {
      // Listener shutdown must continue even if stream cleanup fails.
    }
    return closeListener(callback);
  };
  return server;
}

export function createHttpServer(options = {}) {
  return createConfiguredHttpServer(options, { integrated: true });
}

export function createReadOnlyHttpServer(options = {}) {
  return createConfiguredHttpServer(options, { integrated: false });
}
