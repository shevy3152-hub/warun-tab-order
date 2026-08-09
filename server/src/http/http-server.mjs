import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  AUTH_ERROR_CODES,
  isDeviceAuthError,
} from '../auth/auth-errors.mjs';
import {
  CATALOG_ERROR_CODES,
  isCatalogRepositoryError,
} from '../catalog/catalog-errors.mjs';
import { SCHEMA_VERSION } from '../db/database.mjs';
import {
  HTTP_ERROR_CODES,
  createHttpError,
  isReadOnlyHttpError,
} from './http-errors.mjs';
import {
  createErrorResponse,
  mapDeviceConfigResponse,
  mapHealthResponse,
  mapMenuResponse,
  writeJsonResponse,
} from './http-response.mjs';

const READ_ONLY_ROUTES = new Set([
  '/v1/health',
  '/v1/device/config',
  '/v1/menu',
]);
const MAX_REQUEST_TARGET_LENGTH = 8_192;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function authenticationFailed() {
  return createHttpError(HTTP_ERROR_CODES.AUTHENTICATION_FAILED);
}

export function parseBearerAuthorization(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw authenticationFailed();
  }

  const authorizationValues = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (typeof name === 'string' && name.toLowerCase() === 'authorization') {
      authorizationValues.push(rawHeaders[index + 1]);
    }
  }

  if (authorizationValues.length !== 1 || typeof authorizationValues[0] !== 'string') {
    throw authenticationFailed();
  }

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
  if (scheme.toLowerCase() !== 'bearer' || token === '') {
    throw authenticationFailed();
  }

  return token;
}

function requestPath(rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }
  if (rawTarget.length > MAX_REQUEST_TARGET_LENGTH) {
    throw createHttpError(HTTP_ERROR_CODES.URI_TOO_LONG);
  }
  if (rawTarget.includes('#')) {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }

  try {
    new URL(rawTarget, 'http://localhost');
  } catch {
    throw createHttpError(HTTP_ERROR_CODES.BAD_REQUEST);
  }

  const queryIndex = rawTarget.indexOf('?');
  return queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
}

function safeRequestId(requestIdFactory) {
  try {
    const requestId = requestIdFactory();
    if (typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)) {
      return requestId;
    }
  } catch {
    // Fall back to a server-generated UUID without exposing the factory failure.
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

function mapApplicationError(error) {
  if (isReadOnlyHttpError(error)) return error;

  if (isDeviceAuthError(error)) {
    if (error.code === AUTH_ERROR_CODES.AUTHENTICATION_FAILED) {
      return authenticationFailed();
    }
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

  return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
}

function sendError(request, response, error, requestId) {
  const httpError = mapApplicationError(error);
  const headers = {};
  if (httpError.statusCode === 401) headers['WWW-Authenticate'] = 'Bearer';
  if (httpError.statusCode === 405) headers.Allow = 'GET';

  writeJsonResponse(response, {
    statusCode: httpError.statusCode,
    body: createErrorResponse(httpError, requestId),
    requestId,
    headers,
    omitBody: request.method === 'HEAD',
  });
}

export function createReadOnlyHttpServer({
  database,
  authenticator,
  catalog,
  readServiceState = undefined,
  requestIdFactory = randomUUID,
  now = Date.now,
} = {}) {
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

  const serviceStateReader = readServiceState ?? defaultServiceStateReader(database);
  if (typeof serviceStateReader !== 'function') {
    throw createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
  }

  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    request.resume();
    const requestId = safeRequestId(requestIdFactory);

    try {
      const path = requestPath(request.url);
      if (!READ_ONLY_ROUTES.has(path)) {
        throw createHttpError(HTTP_ERROR_CODES.NOT_FOUND);
      }
      if (request.method !== 'GET') {
        throw createHttpError(HTTP_ERROR_CODES.METHOD_NOT_ALLOWED);
      }

      if (path === '/v1/health') {
        let body;
        try {
          body = mapHealthResponse(serviceStateReader(), now());
        } catch {
          throw createHttpError(HTTP_ERROR_CODES.SERVICE_UNAVAILABLE);
        }
        writeJsonResponse(response, {
          statusCode: 200,
          body,
          requestId,
        });
        return;
      }

      const token = parseBearerAuthorization(request.rawHeaders);
      const principal = authenticator.authenticateDeviceToken(token);

      if (path === '/v1/device/config') {
        const settings = catalog.getDeviceSettings(principal);
        const body = mapDeviceConfigResponse(settings);
        writeJsonResponse(response, {
          statusCode: 200,
          body,
          requestId,
        });
        return;
      }

      const body = mapMenuResponse(catalog.getMenuForPrincipal(principal));
      writeJsonResponse(response, {
        statusCode: 200,
        body,
        requestId,
      });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendError(request, response, error, requestId);
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
