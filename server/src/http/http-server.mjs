import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  AUTH_ERROR_CODES,
  isDeviceAuthError,
} from '../auth/auth-errors.mjs';
import { authorizeDeviceRole } from '../auth/device-auth.mjs';
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
  SNAPSHOT_ERROR_CODES,
  isSnapshotServiceError,
} from '../events/snapshot-errors.mjs';
import {
  ORDER_ERROR_CODES,
  isOrderRepositoryError,
} from '../orders/order-errors.mjs';
import {
  HTTP_ERROR_CODES,
  createHttpError,
  isReadOnlyHttpError,
} from './http-errors.mjs';
import {
  createErrorResponse,
  createEventHistoryUnavailableResponse,
  mapDeviceConfigResponse,
  mapEventReplayResponse,
  mapHealthResponse,
  mapMenuResponse,
  mapOrderReceiptResponse,
  mapSnapshotResponse,
  writeJsonResponse,
} from './http-response.mjs';
import {
  ORDER_JSON_BODY_ERROR_CODES,
  isOrderJsonBodyError,
  readOrderJsonBody,
} from './json-body.mjs';

const ROUTE_METHODS = new Map([
  ['/v1/health', 'GET'],
  ['/v1/device/config', 'GET'],
  ['/v1/menu', 'GET'],
  ['/v1/orders', 'POST'],
  ['/v1/snapshot', 'GET'],
  ['/v1/events', 'GET'],
  ['/v1/events/replay', 'GET'],
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
    if (error.code === ORDER_ERROR_CODES.ORDER_CONFLICT) {
      return createHttpError(HTTP_ERROR_CODES.ORDER_CONFLICT);
    }
    if (error.code === ORDER_ERROR_CODES.DATABASE_FAILURE && hasBusyCause(error)) {
      return createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
    }
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
  readServiceState = undefined,
  requestIdFactory = randomUUID,
  now = Date.now,
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
      !orderRepository
      || typeof orderRepository.createOrder !== 'function'
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

    const handle = async () => {
      const target = requestTarget(request.url);
      allowedMethod = routeMethods.get(target.path);
      if (!allowedMethod) {
        drainRequest(request);
        throw createHttpError(HTTP_ERROR_CODES.NOT_FOUND);
      }
      if (request.method !== allowedMethod) {
        drainRequest(request);
        throw createHttpError(HTTP_ERROR_CODES.METHOD_NOT_ALLOWED);
      }

      if (target.path === '/v1/health') {
        drainRequest(request);
        let body;
        try {
          body = mapHealthResponse(serviceStateReader(), now());
        } catch {
          throw createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
        }
        writeJsonResponse(response, { statusCode: 200, body, requestId });
        return;
      }

      principal = authenticateRequest(request, authenticator);

      if (target.path === '/v1/orders') {
        const orders = requireService(orderRepository, 'createOrder');
        authorizeDeviceRole(principal, ['customer']);
        const body = await readOrderJsonBody(request);
        const result = orders.createOrder({
          clientOrderId: body.clientOrderId,
          authenticatedDeviceId: principal.deviceId,
          items: body.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
          })),
        });
        await notifyCommittedSafely(sseHub, result);
        if (response.destroyed) return;
        const receipt = mapOrderReceiptResponse(result);
        writeJsonResponse(response, {
          statusCode: result.idempotencyResult === 'created' ? 201 : 200,
          body: receipt,
          requestId,
          headers: { 'Idempotency-Result': result.idempotencyResult },
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
        const body = mapSnapshotResponse(snapshots.getSnapshot(principal));
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
