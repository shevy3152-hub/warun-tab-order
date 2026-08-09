import { createHash } from 'node:crypto';

import { AUTH_ERROR_CODES, DeviceAuthError } from './auth-errors.mjs';

const DEVICE_TOKEN_LENGTH = 43;
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ROLES = new Set(['customer', 'kitchen', 'admin']);
const issuedPrincipals = new WeakSet();

function authError(code, message, options = undefined) {
  return new DeviceAuthError(code, message, options);
}

function authenticationFailed() {
  return authError(AUTH_ERROR_CODES.AUTHENTICATION_FAILED, 'Device authentication failed.');
}

function validateCanonicalToken(rawToken) {
  if (
    typeof rawToken !== 'string'
    || rawToken.length !== DEVICE_TOKEN_LENGTH
    || !DEVICE_TOKEN_PATTERN.test(rawToken)
  ) {
    throw authenticationFailed();
  }

  let decoded;
  try {
    decoded = Buffer.from(rawToken, 'base64url');
  } catch {
    throw authenticationFailed();
  }

  if (
    decoded.length !== DEVICE_TOKEN_BYTES
    || decoded.toString('base64url') !== rawToken
  ) {
    throw authenticationFailed();
  }

  decoded.fill(0);
}

function tokenHash(rawToken) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function createPrincipal(row) {
  const principal = Object.freeze({
    deviceId: row.device_id,
    role: row.role,
    tableId: row.table_id ?? null,
    deviceLabel: row.display_name,
  });
  issuedPrincipals.add(principal);
  return principal;
}

export function createDeviceAuthenticator({ database } = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw authError(
      AUTH_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
    );
  }

  let findDeviceByTokenHash;
  try {
    findDeviceByTokenHash = database.prepare(`
      SELECT
        d.device_id,
        d.role,
        d.display_name,
        d.status,
        t.table_id
      FROM devices AS d
      LEFT JOIN tables AS t
        ON t.assigned_customer_device_id = d.device_id
      WHERE d.token_hash = ?
    `);
  } catch (error) {
    throw authError(
      AUTH_ERROR_CODES.DATABASE_FAILURE,
      'Failed to prepare device authentication.',
      { cause: error },
    );
  }

  let closed = false;

  function authenticateDeviceToken(rawToken) {
    if (closed) {
      throw authError(
        AUTH_ERROR_CODES.DATABASE_FAILURE,
        'The device authenticator is closed.',
      );
    }

    validateCanonicalToken(rawToken);
    const digest = tokenHash(rawToken);

    let row;
    try {
      row = findDeviceByTokenHash.get(digest);
    } catch (error) {
      throw authError(
        AUTH_ERROR_CODES.DATABASE_FAILURE,
        'Device authentication storage is unavailable.',
        { cause: error },
      );
    }

    if (
      !row
      || row.status !== 'active'
      || !DEVICE_ROLES.has(row.role)
      || typeof row.device_id !== 'string'
      || row.device_id === ''
    ) {
      throw authenticationFailed();
    }

    return createPrincipal(row);
  }

  return Object.freeze({
    authenticateDeviceToken,
    close() {
      closed = true;
    },
  });
}

export function authorizeDeviceRole(principal, allowedRoles) {
  if (
    principal === null
    || typeof principal !== 'object'
    || !issuedPrincipals.has(principal)
    || !DEVICE_ROLES.has(principal.role)
    || !Array.isArray(allowedRoles)
    || allowedRoles.length === 0
    || allowedRoles.some((role) => !DEVICE_ROLES.has(role))
    || !allowedRoles.includes(principal.role)
  ) {
    throw authError(AUTH_ERROR_CODES.AUTHORIZATION_FAILED, 'Device authorization failed.');
  }

  return principal;
}
