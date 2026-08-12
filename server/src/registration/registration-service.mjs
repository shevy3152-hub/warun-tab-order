import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const MAX_REQUEST_LIFETIME_MS = 30 * 60 * 1000;

export const REGISTRATION_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  NOT_APPROVED: 'NOT_APPROVED',
  ALREADY_APPROVED: 'ALREADY_APPROVED',
  CLAIMED: 'CLAIMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  TABLE_CONFLICT: 'TABLE_CONFLICT',
  DEVICE_CONFLICT: 'DEVICE_CONFLICT',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class RegistrationServiceError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'RegistrationServiceError';
    this.code = code;
  }
}

export function isRegistrationServiceError(error, code = undefined) {
  return error instanceof RegistrationServiceError
    && (code === undefined || error.code === code);
}

function registrationError(code, message) {
  return new RegistrationServiceError(code, message);
}

function hashSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validToken(value) {
  return typeof value === 'string'
    && value.length === TOKEN_LENGTH
    && TOKEN_PATTERN.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function validLabel(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80;
}

function validAppVersion(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40;
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) {
    throw registrationError(REGISTRATION_ERROR_CODES.INVALID_REQUEST, 'Registration request is invalid.');
  }
}

function rawToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function withTransaction(database, callback) {
  try {
    database.exec('BEGIN IMMEDIATE');
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    if (isRegistrationServiceError(error)) throw error;
    throw registrationError(
      REGISTRATION_ERROR_CODES.DATABASE_FAILURE,
      'Registration database operation failed.',
      { cause: error },
    );
  }
}

function secretMatches(hash, secret) {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicRequest(row) {
  return Object.freeze({
    requestId: row.request_id,
    deviceId: row.device_id,
    displayName: row.display_name,
    appVersion: row.app_version,
    role: row.role,
    tableId: row.table_id,
    status: row.status,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    approvedAtMs: row.approved_at_ms,
    claimedAtMs: row.claimed_at_ms,
  });
}

export function createRegistrationService({ database, now = Date.now, idFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw registrationError(REGISTRATION_ERROR_CODES.DATABASE_FAILURE, 'A ready database connection is required.');
  }

  function expireRequests(currentTime) {
    database.prepare(`
      UPDATE registration_requests
      SET status = 'expired'
      WHERE status IN ('pending', 'approved') AND expires_at_ms <= ?
    `).run(currentTime);
  }

  function createRequest({ requestSecret, deviceId, displayName, appVersion, role = 'customer' } = {}) {
    if (!validToken(requestSecret) || !validUuid(deviceId) || !validLabel(displayName)
      || !validAppVersion(appVersion) || role !== 'customer') {
      throw registrationError(REGISTRATION_ERROR_CODES.INVALID_REQUEST, 'Registration request is invalid.');
    }
    const currentTime = now();
    const expiresAtMs = currentTime + REQUEST_LIFETIME_MS;
    return withTransaction(database, () => {
      expireRequests(currentTime);
      if (database.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId)) {
        throw registrationError(REGISTRATION_ERROR_CODES.DEVICE_CONFLICT, 'Device is already registered.');
      }
      const existing = database.prepare(`
        SELECT request_id, request_secret_hash, status, expires_at_ms
        FROM registration_requests
        WHERE device_id = ? AND status IN ('pending', 'approved')
        LIMIT 1
      `).get(deviceId);
      if (existing) {
        if (secretMatches(existing.request_secret_hash, requestSecret)) {
          return Object.freeze({
            requestId: existing.request_id,
            deviceId,
            status: existing.status,
            expiresAtMs: existing.expires_at_ms,
          });
        }
        throw registrationError(REGISTRATION_ERROR_CODES.DEVICE_CONFLICT, 'Device registration is already pending.');
      }
      const requestId = idFactory();
      if (!validUuid(requestId)) throw registrationError(REGISTRATION_ERROR_CODES.DATABASE_FAILURE, 'Registration identifier generation failed.');
      database.prepare(`
        INSERT INTO registration_requests (
          request_id, request_secret_hash, device_id, display_name, app_version,
          role, status, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'customer', 'pending', ?, ?)
      `).run(requestId, hashSecret(requestSecret), deviceId, displayName.trim(), appVersion.trim(), currentTime, expiresAtMs);
      return Object.freeze({ requestId, deviceId, status: 'pending', expiresAtMs });
    });
  }

  function createRequestFromRequest(request) {
    exactFields(request, ['requestSecret', 'deviceId', 'displayName', 'appVersion', 'role']);
    return createRequest(request);
  }

  function getStatus({ requestId, requestSecret } = {}) {
    if (!validUuid(requestId) || !validToken(requestSecret)) {
      throw registrationError(REGISTRATION_ERROR_CODES.INVALID_REQUEST, 'Registration status request is invalid.');
    }
    return withTransaction(database, () => {
      const currentTime = now();
      expireRequests(currentTime);
      const row = database.prepare('SELECT * FROM registration_requests WHERE request_id = ?').get(requestId);
      if (!row || !secretMatches(row.request_secret_hash, requestSecret)) {
        throw registrationError(REGISTRATION_ERROR_CODES.NOT_FOUND, 'Registration request was not found.');
      }
      return publicRequest(row);
    });
  }

  function getStatusFromRequest(request) {
    exactFields(request, ['requestId', 'requestSecret']);
    return getStatus(request);
  }

  function listRequests() {
    return withTransaction(database, () => {
      expireRequests(now());
      return Object.freeze(database.prepare(`
        SELECT request_id, device_id, display_name, app_version, role, table_id,
          status, created_at_ms, expires_at_ms, approved_at_ms, claimed_at_ms
        FROM registration_requests
        WHERE status IN ('pending', 'approved')
        ORDER BY created_at_ms, request_id
      `).all().map(publicRequest));
    });
  }

  function approve({ requestId, tableId, approvedByDeviceId } = {}) {
    if (!validUuid(requestId) || !Number.isSafeInteger(tableId) || tableId < 1 || !validUuid(approvedByDeviceId)) {
      throw registrationError(REGISTRATION_ERROR_CODES.INVALID_REQUEST, 'Registration approval is invalid.');
    }
    return withTransaction(database, () => {
      const currentTime = now();
      expireRequests(currentTime);
      const row = database.prepare('SELECT * FROM registration_requests WHERE request_id = ?').get(requestId);
      if (!row) throw registrationError(REGISTRATION_ERROR_CODES.NOT_FOUND, 'Registration request was not found.');
      if (row.status === 'expired') throw registrationError(REGISTRATION_ERROR_CODES.EXPIRED, 'Registration request expired.');
      if (row.status === 'approved') throw registrationError(REGISTRATION_ERROR_CODES.ALREADY_APPROVED, 'Registration request was already approved.');
      if (row.status !== 'pending') throw registrationError(REGISTRATION_ERROR_CODES.TABLE_CONFLICT, 'Registration request is not pending.');
      if (database.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(row.device_id)) {
        throw registrationError(REGISTRATION_ERROR_CODES.DEVICE_CONFLICT, 'Device is already registered.');
      }
      const table = database.prepare(`
        SELECT table_id, is_active, assigned_customer_device_id
        FROM tables WHERE table_id = ?
      `).get(tableId);
      if (!table || table.is_active !== 1 || table.assigned_customer_device_id !== null) {
        throw registrationError(REGISTRATION_ERROR_CODES.TABLE_CONFLICT, 'The table is not available.');
      }
      try {
        database.prepare(`
          UPDATE registration_requests
          SET table_id = ?, status = 'approved', approved_at_ms = ?, approved_by_device_id = ?
          WHERE request_id = ? AND status = 'pending'
        `).run(tableId, currentTime, approvedByDeviceId, requestId);
      } catch (error) {
        if (String(error?.message || '').includes('registration_requests')) {
          throw registrationError(REGISTRATION_ERROR_CODES.TABLE_CONFLICT, 'The table is already reserved.');
        }
        throw error;
      }
      return publicRequest(database.prepare('SELECT * FROM registration_requests WHERE request_id = ?').get(requestId));
    });
  }

  function approveRequest(request, { approvedByDeviceId } = {}) {
    exactFields(request, ['requestId', 'tableId']);
    return approve({ ...request, approvedByDeviceId });
  }

  function claim({ requestId, requestSecret } = {}) {
    if (!validUuid(requestId) || !validToken(requestSecret)) {
      throw registrationError(REGISTRATION_ERROR_CODES.INVALID_REQUEST, 'Registration claim is invalid.');
    }
    return withTransaction(database, () => {
      const currentTime = now();
      expireRequests(currentTime);
      const row = database.prepare('SELECT * FROM registration_requests WHERE request_id = ?').get(requestId);
      if (!row || !secretMatches(row.request_secret_hash, requestSecret)) {
        throw registrationError(REGISTRATION_ERROR_CODES.NOT_FOUND, 'Registration request was not found.');
      }
      if (row.status === 'expired') throw registrationError(REGISTRATION_ERROR_CODES.EXPIRED, 'Registration request expired.');
      if (row.status === 'claimed') throw registrationError(REGISTRATION_ERROR_CODES.CLAIMED, 'Registration request was already claimed.');
      if (row.status === 'cancelled') throw registrationError(REGISTRATION_ERROR_CODES.CANCELLED, 'Registration request was cancelled.');
      if (row.status !== 'approved' || !Number.isSafeInteger(row.table_id)) {
        throw registrationError(REGISTRATION_ERROR_CODES.NOT_APPROVED, 'Registration request is not approved.');
      }
      if (database.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(row.device_id)) {
        throw registrationError(REGISTRATION_ERROR_CODES.DEVICE_CONFLICT, 'Device is already registered.');
      }
      const table = database.prepare(`
        SELECT table_id, is_active, assigned_customer_device_id
        FROM tables WHERE table_id = ?
      `).get(row.table_id);
      if (!table || table.is_active !== 1 || table.assigned_customer_device_id !== null) {
        database.prepare(`UPDATE registration_requests SET status = 'cancelled' WHERE request_id = ?`).run(requestId);
        throw registrationError(REGISTRATION_ERROR_CODES.TABLE_CONFLICT, 'The table is not available.');
      }
      const token = rawToken();
      database.prepare(`
        INSERT INTO devices (
          device_id, role, display_name, token_hash, status, app_version,
          paired_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, 'customer', ?, ?, 'active', ?, ?, ?, ?)
      `).run(row.device_id, row.display_name, hashSecret(token), row.app_version, currentTime, currentTime, currentTime);
      const assignment = database.prepare(`
        UPDATE tables
        SET assigned_customer_device_id = ?, version = version + 1, updated_at_ms = ?
        WHERE table_id = ? AND is_active = 1 AND assigned_customer_device_id IS NULL
      `).run(row.device_id, currentTime, row.table_id);
      if (assignment.changes !== 1) throw registrationError(REGISTRATION_ERROR_CODES.TABLE_CONFLICT, 'The table is not available.');
      database.prepare(`
        UPDATE registration_requests
        SET status = 'claimed', claimed_at_ms = ?
        WHERE request_id = ? AND status = 'approved'
      `).run(currentTime, requestId);
      return Object.freeze({ deviceToken: token, deviceId: row.device_id, role: 'customer', tableId: row.table_id });
    });
  }

  function claimRequest(request) {
    exactFields(request, ['requestId', 'requestSecret']);
    return claim(request);
  }

  return Object.freeze({
    createRequest,
    createRequestFromRequest,
    getStatus,
    getStatusFromRequest,
    listRequests,
    approve,
    approveRequest,
    claim,
    claimRequest,
  });
}
