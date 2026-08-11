import { createHash, randomBytes, randomUUID } from 'node:crypto';

const CODE_BYTES = 32;
const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CLAIM_ATTEMPTS = 5;
const MAX_PAIRING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MIN_PAIRING_LIFETIME_MS = 60 * 1000;

export const PAIRING_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_CODE: 'INVALID_CODE',
  CODE_USED: 'CODE_USED',
  CODE_EXPIRED: 'CODE_EXPIRED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  TABLE_CONFLICT: 'TABLE_CONFLICT',
  DEVICE_CONFLICT: 'DEVICE_CONFLICT',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

function pairingError(code, message, options = undefined) {
  return new PairingServiceError(code, message, options);
}

export class PairingServiceError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'PairingServiceError';
    this.code = code;
  }
}

export function isPairingServiceError(error, code = undefined) {
  return error instanceof PairingServiceError && (code === undefined || error.code === code);
}

export function hashPairingSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validToken(value) {
  return typeof value === 'string' && value.length === TOKEN_LENGTH && TOKEN_PATTERN.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function validLabel(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80;
}

function validAppVersion(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 64;
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Pairing request is invalid.');
  }
}

function rawSecret(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function withTransaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function createPairingService({ database, now = Date.now, idFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw pairingError(PAIRING_ERROR_CODES.DATABASE_FAILURE, 'A ready node:sqlite database connection is required.');
  }
  const attempts = new Map();

  function recordAttempt(codeHash) {
    const count = (attempts.get(codeHash) || 0) + 1;
    attempts.set(codeHash, count);
    return count;
  }

  function validateCreateRequest({ role, tableId, expiresAtMs } = {}) {
    const currentTime = now();
    if (role !== 'customer' || !Number.isSafeInteger(tableId) || tableId < 1 || !Number.isSafeInteger(expiresAtMs)) {
      throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Pairing request is invalid.');
    }
    if (expiresAtMs < currentTime + MIN_PAIRING_LIFETIME_MS || expiresAtMs > currentTime + MAX_PAIRING_LIFETIME_MS) {
      throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Pairing expiry is invalid.');
    }
  }

  function createPairingCode({ role, tableId, expiresAtMs, createdByDeviceId }) {
    validateCreateRequest({ role, tableId, expiresAtMs });
    if (!validUuid(createdByDeviceId)) throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Pairing actor is invalid.');

    return withTransaction(database, () => {
      const table = database.prepare(`
        SELECT table_id, is_active, assigned_customer_device_id
        FROM tables
        WHERE table_id = ?
      `).get(tableId);
      if (!table || table.is_active !== 1 || table.assigned_customer_device_id !== null) {
        throw pairingError(PAIRING_ERROR_CODES.TABLE_CONFLICT, 'The table is not available for pairing.');
      }
      const code = rawSecret(CODE_BYTES);
      const codeHash = hashPairingSecret(code);
      database.prepare(`
        INSERT INTO pairing_codes (
          code_hash, role, table_id, expires_at_ms, created_by_device_id, created_at_ms
        ) VALUES (?, 'customer', ?, ?, ?, ?)
      `).run(codeHash, tableId, expiresAtMs, createdByDeviceId, now());
      return Object.freeze({ code, role, tableId, expiresAtMs });
    });
  }

  function createPairingCodeRequest(request, { createdByDeviceId } = {}) {
    exactFields(request, ['role', 'tableId', 'expiresAtMs']);
    return createPairingCode({ ...request, createdByDeviceId });
  }

  function claimPairingCode({ pairingCode, deviceId, displayName, appVersion } = {}) {
    if (!validToken(pairingCode) || !validUuid(deviceId) || !validLabel(displayName) || !validAppVersion(appVersion)) {
      throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Pairing claim is invalid.');
    }
    const codeHash = hashPairingSecret(pairingCode);
    if (recordAttempt(codeHash) > MAX_CLAIM_ATTEMPTS) {
      throw pairingError(PAIRING_ERROR_CODES.TOO_MANY_ATTEMPTS, 'Pairing attempts exceeded.');
    }

    return withTransaction(database, () => {
      const currentTime = now();
      const code = database.prepare(`
        SELECT code_hash, role, table_id, expires_at_ms, used_by_device_id, used_at_ms
        FROM pairing_codes
        WHERE code_hash = ?
      `).get(codeHash);
      if (!code) throw pairingError(PAIRING_ERROR_CODES.INVALID_CODE, 'Pairing code is invalid.');
      if (code.used_by_device_id !== null || code.used_at_ms !== null) {
        throw pairingError(PAIRING_ERROR_CODES.CODE_USED, 'Pairing code was already used.');
      }
      if (code.expires_at_ms < currentTime) {
        throw pairingError(PAIRING_ERROR_CODES.CODE_EXPIRED, 'Pairing code expired.');
      }
      if (code.role !== 'customer' || !Number.isInteger(code.table_id)) {
        throw pairingError(PAIRING_ERROR_CODES.INVALID_CODE, 'Pairing code is invalid.');
      }
      if (database.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId)) {
        throw pairingError(PAIRING_ERROR_CODES.DEVICE_CONFLICT, 'Device is already registered.');
      }
      const table = database.prepare(`
        SELECT table_id, is_active, assigned_customer_device_id
        FROM tables
        WHERE table_id = ?
      `).get(code.table_id);
      if (!table || table.is_active !== 1 || table.assigned_customer_device_id !== null) {
        throw pairingError(PAIRING_ERROR_CODES.TABLE_CONFLICT, 'The table is not available for pairing.');
      }

      const token = rawSecret(TOKEN_BYTES);
      database.prepare(`
        INSERT INTO devices (
          device_id, role, display_name, token_hash, status, app_version,
          paired_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, 'customer', ?, ?, 'active', ?, ?, ?, ?)
      `).run(deviceId, displayName.trim(), hashPairingSecret(token), appVersion.trim(), currentTime, currentTime, currentTime);
      const assignment = database.prepare(`
        UPDATE tables
        SET assigned_customer_device_id = ?, version = version + 1, updated_at_ms = ?
        WHERE table_id = ? AND is_active = 1 AND assigned_customer_device_id IS NULL
      `).run(deviceId, currentTime, code.table_id);
      if (assignment.changes !== 1) throw pairingError(PAIRING_ERROR_CODES.TABLE_CONFLICT, 'The table is not available for pairing.');
      database.prepare(`
        UPDATE pairing_codes
        SET used_by_device_id = ?, used_at_ms = ?
        WHERE code_hash = ? AND used_by_device_id IS NULL
      `).run(deviceId, currentTime, codeHash);
      attempts.delete(codeHash);
      return Object.freeze({ deviceToken: token, deviceId, role: 'customer', tableId: code.table_id });
    });
  }

  function claimPairingCodeRequest(request) {
    exactFields(request, ['pairingCode', 'deviceId', 'displayName', 'appVersion']);
    return claimPairingCode(request);
  }

  function revokeDevice({ deviceId, actorDeviceId } = {}) {
    if (!validUuid(deviceId) || !validUuid(actorDeviceId)) {
      throw pairingError(PAIRING_ERROR_CODES.INVALID_REQUEST, 'Device revoke request is invalid.');
    }
    return withTransaction(database, () => {
      const device = database.prepare('SELECT device_id, status FROM devices WHERE device_id = ?').get(deviceId);
      if (!device) throw pairingError(PAIRING_ERROR_CODES.DEVICE_NOT_FOUND, 'Device was not found.');
      const currentTime = now();
      database.prepare(`
        UPDATE devices
        SET status = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
        WHERE device_id = ? AND status = 'active'
      `).run(currentTime, currentTime, deviceId);
      database.prepare(`
        UPDATE tables
        SET assigned_customer_device_id = NULL, version = version + 1, updated_at_ms = ?
        WHERE assigned_customer_device_id = ?
      `).run(currentTime, deviceId);
      return Object.freeze({ deviceId, status: 'revoked', actorDeviceId });
    });
  }

  function revokeDeviceRequest(request) {
    exactFields(request, ['deviceId']);
    return revokeDevice(request);
  }

  return Object.freeze({ createPairingCode, createPairingCodeRequest, claimPairingCode, claimPairingCodeRequest, revokeDevice, revokeDeviceRequest });
}
