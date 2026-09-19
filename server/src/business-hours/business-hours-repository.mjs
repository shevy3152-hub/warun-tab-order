import {
  BUSINESS_HOURS_ERROR_CODES,
  BusinessHoursRepositoryError,
} from './business-hours-errors.mjs';

const DEFAULTS = Object.freeze({
  openMinutes: 17 * 60,
  closeMinutes: 24 * 60,
  lastOrderMinutes: 23 * 60 + 30,
  isVisible: true,
  noticeText: '',
  noticeEnabled: false,
  version: 0,
  updatedAtMs: 0,
});
const TIME_PATTERN = /^(?:[01][0-9]|2[0-9]):[0-5][0-9]$/;

function repositoryError(code, message, options = undefined) {
  return new BusinessHoursRepositoryError(code, message, options);
}

function invalidRequest(message) {
  return repositoryError(BUSINESS_HOURS_ERROR_CODES.INVALID_WRITE_REQUEST, message);
}

function parseTime(value, fieldName, { allowExtended }) {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw invalidRequest(`${fieldName} must use HH:mm format.`);
  }
  const hour = Number(value.slice(0, 2));
  if (!allowExtended && hour > 23) {
    throw invalidRequest(`${fieldName} must be between 00:00 and 23:59.`);
  }
  return hour * 60 + Number(value.slice(3, 5));
}

function requireExpectedVersion(request) {
  if (!Object.hasOwn(request, 'expectedVersion')
    || !Number.isSafeInteger(request.expectedVersion)
    || request.expectedVersion < 0) {
    throw invalidRequest('expectedVersion is required.');
  }
  return request.expectedVersion;
}

function normalizeNoticeText(value) {
  if (typeof value !== 'string') throw invalidRequest('noticeText must be a string.');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if ([...normalized].length > 500) throw invalidRequest('noticeText must be 500 characters or fewer.');
  if (/<\/?[A-Za-z][^>]*>/.test(normalized)) throw invalidRequest('noticeText must be plain text.');
  return normalized;
}

export function normalizeBusinessHoursWriteRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw invalidRequest('Business-hours request must be an object.');
  }
  const expectedVersion = requireExpectedVersion(request);
  const openMinutes = parseTime(request.openTime, 'openTime', { allowExtended: false });
  const closeMinutes = parseTime(request.closeTime, 'closeTime', { allowExtended: true });
  const lastOrderMinutes = parseTime(request.lastOrderTime, 'lastOrderTime', { allowExtended: true });
  if (openMinutes >= lastOrderMinutes || lastOrderMinutes > closeMinutes) {
    throw invalidRequest('Business hours must satisfy openTime < lastOrderTime <= closeTime.');
  }
  if (typeof request.isVisible !== 'boolean') {
    throw invalidRequest('isVisible must be boolean.');
  }
  const noticeText = Object.hasOwn(request, 'noticeText') ? normalizeNoticeText(request.noticeText) : undefined;
  const noticeEnabled = Object.hasOwn(request, 'noticeEnabled') ? request.noticeEnabled : undefined;
  if (noticeEnabled !== undefined && typeof noticeEnabled !== 'boolean') throw invalidRequest('noticeEnabled must be boolean.');
  if (noticeEnabled === true && noticeText !== undefined && noticeText === '') throw invalidRequest('noticeEnabled requires noticeText.');
  return { expectedVersion, openMinutes, closeMinutes, lastOrderMinutes, isVisible: request.isVisible, noticeText, noticeEnabled };
}

function timeText(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function mapBusinessHours(row = DEFAULTS) {
  const openMinutes = Number(row.openMinutes ?? row.open_minutes ?? DEFAULTS.openMinutes);
  const closeMinutes = Number(row.closeMinutes ?? row.close_minutes ?? DEFAULTS.closeMinutes);
  const lastOrderMinutes = Number(row.lastOrderMinutes ?? row.last_order_minutes ?? DEFAULTS.lastOrderMinutes);
  const isVisible = row.isVisible === undefined && row.is_visible === undefined
    ? DEFAULTS.isVisible
    : Boolean(row.isVisible ?? row.is_visible);
  const version = Number(row.version ?? DEFAULTS.version);
  const updatedAtMs = Number(row.updatedAtMs ?? row.updated_at_ms ?? DEFAULTS.updatedAtMs);
  const noticeText = String(row.noticeText ?? row.notice_text ?? DEFAULTS.noticeText).replace(/\r\n?/g, '\n').trim();
  const noticeEnabled = row.noticeEnabled === undefined && row.notice_enabled === undefined
    ? DEFAULTS.noticeEnabled
    : Boolean(row.noticeEnabled ?? row.notice_enabled);
  const openTime = timeText(openMinutes);
  const closeTime = timeText(closeMinutes);
  const lastOrderTime = timeText(lastOrderMinutes);
  return {
    openTime,
    closeTime,
    lastOrderTime,
    isVisible,
    noticeText,
    noticeEnabled,
    version,
    updatedAtMs,
    displayText: `${openTime}－${closeTime}（ラストオーダー${lastOrderTime}）`,
  };
}

function withReadFallback(read) {
  try {
    return read();
  } catch (error) {
    if (/no such table: business_hours/i.test(String(error?.message ?? ''))) return undefined;
    throw error;
  }
}

export function createBusinessHoursRepository({ database, now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof now !== 'function') {
    throw new TypeError('A database and clock are required.');
  }
  let closed = false;
  function findRow() {
    return database.prepare(`
      SELECT open_minutes, close_minutes, last_order_minutes, is_visible,
             notice_text, notice_enabled, version, updated_at_ms
      FROM business_hours
      WHERE singleton_id = 1
    `).get();
  }

  function ensureOpen() {
    if (closed) throw repositoryError(BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE, 'The business-hours repository is closed.');
  }

  function getBusinessHours() {
    ensureOpen();
    try {
      const row = withReadFallback(findRow);
      return mapBusinessHours(row ?? DEFAULTS);
    } catch (error) {
      throw repositoryError(BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE, 'The business-hours read failed.', { cause: error });
    }
  }

  function writeBusinessHours(principal, request) {
    ensureOpen();
    const normalized = normalizeBusinessHoursWriteRequest(request);
    if (!principal || principal.role !== 'admin' || typeof principal.deviceId !== 'string') {
      throw repositoryError(BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.');
    }
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const current = findRow();
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== normalized.expectedVersion) {
        throw repositoryError(BUSINESS_HOURS_ERROR_CODES.VERSION_CONFLICT, 'Business hours have changed since they were read.');
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw repositoryError(BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE, 'The business-hours write clock returned an invalid timestamp.');
      }
      const nextVersion = currentVersion + 1;
      const currentSettings = mapBusinessHours(current ?? DEFAULTS);
      const noticeText = normalized.noticeText ?? currentSettings.noticeText;
      const noticeEnabled = normalized.noticeEnabled ?? currentSettings.noticeEnabled;
      if (noticeEnabled && noticeText === '') throw invalidRequest('noticeEnabled requires noticeText.');
      if (current) {
        const update = database.prepare(`
          UPDATE business_hours
          SET open_minutes = ?, close_minutes = ?, last_order_minutes = ?,
              is_visible = ?, notice_text = ?, notice_enabled = ?, version = ?, updated_at_ms = ?
          WHERE singleton_id = 1 AND version = ?
        `).run(
          normalized.openMinutes,
          normalized.closeMinutes,
          normalized.lastOrderMinutes,
          normalized.isVisible ? 1 : 0,
          noticeText,
          noticeEnabled ? 1 : 0,
          nextVersion,
          timestamp,
          normalized.expectedVersion,
        );
        if (Number(update.changes) !== 1) {
          throw repositoryError(BUSINESS_HOURS_ERROR_CODES.VERSION_CONFLICT, 'Business hours have changed since they were read.');
        }
      } else {
        if (normalized.expectedVersion !== 0) {
          throw repositoryError(BUSINESS_HOURS_ERROR_CODES.VERSION_CONFLICT, 'Business hours were created after they were read.');
        }
        database.prepare(`
          INSERT INTO business_hours (
            singleton_id, open_minutes, close_minutes, last_order_minutes,
            is_visible, notice_text, notice_enabled, version, created_at_ms, updated_at_ms
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.openMinutes,
          normalized.closeMinutes,
          normalized.lastOrderMinutes,
          normalized.isVisible ? 1 : 0,
          noticeText,
          noticeEnabled ? 1 : 0,
          nextVersion,
          timestamp,
          timestamp,
        );
      }
      const state = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
      if (typeof state?.event_epoch !== 'string') throw new Error('Current event epoch is unavailable.');
      const payloadJson = JSON.stringify({
        version: nextVersion,
        openTime: timeText(normalized.openMinutes),
        closeTime: timeText(normalized.closeMinutes),
        lastOrderTime: timeText(normalized.lastOrderMinutes),
        isVisible: normalized.isVisible,
        noticeText,
        noticeEnabled,
      });
      const event = database.prepare(`
        INSERT INTO event_log (
          event_epoch, event_type, aggregate_type, aggregate_id,
          actor_device_id, payload_json, created_at_ms
        ) VALUES (?, 'business_hours.updated', 'business_hours', 'singleton', ?, ?, ?)
      `).run(state.event_epoch, principal.deviceId, payloadJson, timestamp);
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        ...mapBusinessHours({ ...normalized, noticeText, noticeEnabled, version: nextVersion, updatedAtMs: timestamp }),
        idempotencyResult: 'created',
        event: { eventEpoch: state.event_epoch, eventId: Number(event.lastInsertRowid) },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof BusinessHoursRepositoryError) throw error;
      throw repositoryError(BUSINESS_HOURS_ERROR_CODES.DATABASE_FAILURE, 'The business-hours write failed.', { cause: error });
    }
  }

  return {
    getBusinessHours,
    writeBusinessHours,
    close() { closed = true; },
  };
}
