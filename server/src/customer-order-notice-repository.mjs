import { authorizeDeviceRole } from './auth/device-auth.mjs';
import {
  CUSTOMER_ORDER_NOTICE_ERROR_CODES,
  CustomerOrderNoticeRepositoryError,
} from './customer-order-notice-errors.mjs';

export const DEFAULT_CUSTOMER_ORDER_START_NOTICE = Object.freeze({
  heading: 'ご注文の前にご確認ください',
  body: [
    '20歳未満の入店禁止',
    '飲酒運転しません・させません',
    'SNS投稿・LIVE配信禁止',
    'お支払いは現金のみ',
  ].join('\n'),
});

const MAX_HEADING_LENGTH = 120;
const MAX_BODY_LENGTH = 4_000;

function repositoryError(code, message, options = undefined) {
  return new CustomerOrderNoticeRepositoryError(code, message, options);
}

function requireExpectedVersion(request) {
  if (!Object.hasOwn(request, 'expectedVersion')
    || !Number.isSafeInteger(request.expectedVersion)
    || request.expectedVersion < 0) {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, 'expectedVersion must be a non-negative safe integer.');
  }
  return request.expectedVersion;
}

function normalizeText(value, field, maxLength, { multiline = false } = {}) {
  if (typeof value !== 'string') {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, `${field} must be text.`);
  }
  const normalized = multiline ? value.replace(/\r\n?/g, '\n') : value.trim();
  if ([...normalized].length < 1 || [...normalized].length > maxLength || !normalized.trim()) {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, `${field} must contain between 1 and ${maxLength} characters.`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, `${field} contains unsupported control characters.`);
  }
  return normalized;
}

function normalizeWriteRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, 'Customer order-start notice request must be an object.');
  }
  const allowed = new Set(['expectedVersion', 'heading', 'body']);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.INVALID_WRITE_REQUEST, `Unsupported field(s): ${unknown.join(', ')}.`);
  }
  return {
    expectedVersion: requireExpectedVersion(request),
    heading: normalizeText(request.heading, 'heading', MAX_HEADING_LENGTH),
    body: normalizeText(request.body, 'body', MAX_BODY_LENGTH, { multiline: true }),
  };
}

function mapSettings(row) {
  if (!row) throw new Error('Customer order-start notice settings are missing.');
  return {
    heading: row.heading_text,
    body: row.body_text,
    version: Number(row.version),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function updateNotification(database, occurredAtMs) {
  const state = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
  if (typeof state?.event_epoch !== 'string') throw new Error('Current event epoch is unavailable.');
  return {
    eventEpoch: state.event_epoch,
    type: 'customer_order_start_notice.updated',
    aggregateId: 'customer-order-notice',
    occurredAtMs,
    payload: { resource: 'customerOrderStartNotice', refreshRequired: true },
  };
}

export function createCustomerOrderNoticeRepository({ database, now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function' || typeof now !== 'function') {
    throw new TypeError('A database and clock are required.');
  }
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'The customer order-start notice repository is closed.');
  };
  const findSettings = () => database.prepare(`
    SELECT heading_text, body_text, version, updated_at_ms
    FROM customer_order_start_notice_settings
    WHERE singleton_id = 1
  `).get();

  function getPublicSettings(principal) {
    ensureOpen();
    try { authorizeDeviceRole(principal, ['customer']); }
    catch (error) { throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'An authenticated customer device is required.', { cause: error }); }
    try {
      const { heading, body } = mapSettings(findSettings());
      return { heading, body };
    } catch (error) {
      if (error instanceof CustomerOrderNoticeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'The customer order-start notice read failed.', { cause: error });
    }
  }

  function getAdminSettings(principal) {
    ensureOpen();
    try { authorizeDeviceRole(principal, ['admin']); }
    catch (error) { throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.', { cause: error }); }
    try { return mapSettings(findSettings()); }
    catch (error) {
      if (error instanceof CustomerOrderNoticeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'The customer order-start notice read failed.', { cause: error });
    }
  }

  function writeSettings(principal, request) {
    ensureOpen();
    const normalized = normalizeWriteRequest(request);
    try { authorizeDeviceRole(principal, ['admin']); }
    catch (error) { throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.', { cause: error }); }

    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const current = findSettings();
      if (!current || Number(current.version) !== normalized.expectedVersion) {
        throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.VERSION_CONFLICT, 'The customer order-start notice has changed since it was read.');
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'The customer order-start notice write clock returned an invalid timestamp.');
      }
      const nextVersion = normalized.expectedVersion + 1;
      const result = database.prepare(`
        UPDATE customer_order_start_notice_settings
        SET heading_text = ?, body_text = ?, version = ?, updated_at_ms = ?
        WHERE singleton_id = 1 AND version = ?
      `).run(normalized.heading, normalized.body, nextVersion, timestamp, normalized.expectedVersion);
      if (Number(result.changes) !== 1) {
        throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.VERSION_CONFLICT, 'The customer order-start notice has changed since it was read.');
      }
      const sseNotification = updateNotification(database, timestamp);
      database.exec('COMMIT;');
      transactionOpen = false;
      return { ...normalized, version: nextVersion, updatedAtMs: timestamp, sseNotification };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof CustomerOrderNoticeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_ORDER_NOTICE_ERROR_CODES.DATABASE_FAILURE, 'The customer order-start notice write failed.', { cause: error });
    }
  }

  return Object.freeze({
    getPublicSettings,
    getAdminSettings,
    writeSettings,
    close() { closed = true; },
  });
}
