import { randomUUID } from 'node:crypto';

import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import { CHECKOUT_ERROR_CODES, CheckoutRepositoryError } from './checkout-errors.mjs';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BILLABLE_ORDER_STATUSES = Object.freeze(['new', 'active', 'completed']);
const ADJUSTMENT_KINDS = new Set(['seat_charge', 'late_night_charge', 'extension_charge', 'other']);

function error(code, message, options = undefined) {
  return new CheckoutRepositoryError(code, message, options);
}

function requireUuid(value, fieldName) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `${fieldName} must be a UUID v4.`);
  return value.toLowerCase();
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, 'expectedVersion must be a positive integer.');
  return value;
}

function requireBoolean(value, fieldName) {
  if (typeof value !== 'boolean') throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `${fieldName} must be boolean.`);
  return value;
}

function requireText(value, fieldName, max) {
  if (typeof value !== 'string' || value.trim() === '' || [...value.trim()].length > max) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `${fieldName} must be non-empty text of at most ${max} characters.`);
  if (/<\/?[A-Za-z][^>]*>/.test(value)) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `${fieldName} must be plain text.`);
  return value.trim();
}

function requireAmount(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `${fieldName} must be a non-negative integer.`);
  return value;
}

function mapAdjustment(row) {
  return {
    adjustmentId: Number(row.adjustment_id),
    checkoutRequestId: row.checkout_request_id,
    kind: row.kind,
    label: row.label,
    amountYen: Number(row.amount_yen),
    sortOrder: Number(row.sort_order),
  };
}

function mapRequest(row, adjustments = []) {
  return {
    checkoutRequestId: row.checkout_request_id,
    tableSessionId: row.table_session_id,
    status: row.status,
    receiptRequested: row.receipt_requested === 1,
    orderedItemsTotalYen: Number(row.ordered_items_total_yen),
    adjustmentsTotalYen: Number(row.adjustments_total_yen),
    grandTotalYen: row.grand_total_yen === null ? null : Number(row.grand_total_yen),
    version: Number(row.version),
    requestedAtMs: Number(row.requested_at_ms),
    readyAtMs: row.ready_at_ms === null ? null : Number(row.ready_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    adjustments,
  };
}

function publicRequest(request) {
  const result = {
    checkoutRequestId: request.checkoutRequestId,
    status: request.status,
    receiptRequested: request.receiptRequested,
    requestedAtMs: request.requestedAtMs,
    readyAtMs: request.readyAtMs,
    version: request.version,
  };
  if (request.status === 'ready') result.grandTotalYen = request.grandTotalYen;
  return result;
}

function normalizeAdjustments(adjustments) {
  if (!Array.isArray(adjustments) || adjustments.length > 20) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, 'adjustments must be an array of at most 20 items.');
  return adjustments.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `adjustments[${index}] must be an object.`);
    const kind = requireText(item.kind, `adjustments[${index}].kind`, 64);
    if (!ADJUSTMENT_KINDS.has(kind)) throw error(CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST, `adjustments[${index}].kind is unsupported.`);
    return {
      kind,
      label: requireText(item.label, `adjustments[${index}].label`, 100),
      amountYen: requireAmount(item.amountYen, `adjustments[${index}].amountYen`),
      sortOrder: index,
    };
  });
}

export function createCheckoutRepository({ database, now = Date.now, idFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function' || typeof now !== 'function' || typeof idFactory !== 'function') throw new TypeError('A database, clock, and ID factory are required.');
  let closed = false;
  const findRequest = database.prepare('SELECT * FROM checkout_requests WHERE checkout_request_id = ?');
  const findAdjustments = database.prepare('SELECT * FROM checkout_adjustments WHERE checkout_request_id = ? ORDER BY sort_order, adjustment_id');

  function ensureOpen() { if (closed) throw error(CHECKOUT_ERROR_CODES.DATABASE_FAILURE, 'The checkout repository is closed.'); }
  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw error(CHECKOUT_ERROR_CODES.DATABASE_FAILURE, 'The checkout clock returned an invalid timestamp.');
    return value;
  }
  function eventState() {
    const row = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
    if (typeof row?.event_epoch !== 'string') throw new Error('Current event epoch is unavailable.');
    return row.event_epoch;
  }
  function appendEvent(eventEpoch, principal, eventType, checkoutRequestId, payload, createdAtMs) {
    const result = database.prepare(`
      INSERT INTO event_log (event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms)
      VALUES (?, ?, 'checkout', ?, ?, ?, ?)
    `).run(eventEpoch, eventType, checkoutRequestId, principal?.deviceId ?? null, JSON.stringify(payload), createdAtMs);
    return { eventEpoch, eventId: Number(result.lastInsertRowid) };
  }
  function hydrate(row) { return row ? mapRequest(row, findAdjustments.all(row.checkout_request_id).map(mapAdjustment)) : null; }
  function currentCustomerSession(deviceId) {
    return database.prepare(`
      SELECT s.session_id, s.table_id
      FROM devices AS d
      JOIN tables AS t ON t.assigned_customer_device_id = d.device_id
      JOIN table_sessions AS s ON s.table_id = t.table_id AND s.closed_at_ms IS NULL
      WHERE d.device_id = ? AND d.role = 'customer' AND d.status = 'active' AND t.is_active = 1
      ORDER BY s.opened_at_ms DESC, s.session_id DESC
      LIMIT 1
    `).get(deviceId);
  }
  function orderTotal(sessionId) {
    const placeholders = BILLABLE_ORDER_STATUSES.map(() => '?').join(', ');
    const row = database.prepare(`
      SELECT COALESCE(SUM(oi.unit_price_yen_snapshot * oi.quantity), 0) AS total
      FROM orders AS o
      JOIN order_items AS oi ON oi.order_id = o.order_id
      WHERE o.session_id = ? AND o.status IN (${placeholders})
    `).get(sessionId, ...BILLABLE_ORDER_STATUSES);
    return Number(row?.total ?? 0);
  }
  function adjustmentTotal(checkoutRequestId) {
    const row = database.prepare('SELECT COALESCE(SUM(amount_yen), 0) AS total FROM checkout_adjustments WHERE checkout_request_id = ?').get(checkoutRequestId);
    return Number(row?.total ?? 0);
  }
  function withTransaction(callback) {
    let open = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      open = true;
      const result = callback();
      database.exec('COMMIT;');
      open = false;
      return result;
    } catch (cause) {
      if (open) { try { database.exec('ROLLBACK;'); } catch {} }
      if (cause instanceof CheckoutRepositoryError) throw cause;
      throw error(CHECKOUT_ERROR_CODES.DATABASE_FAILURE, 'The checkout operation failed.', { cause });
    }
  }
  function createCheckout({ principal, checkoutRequestId, receiptRequested }) {
    ensureOpen();
    authorizeDeviceRole(principal, ['customer']);
    const id = requireUuid(checkoutRequestId, 'checkoutRequestId');
    const receipt = requireBoolean(receiptRequested, 'receiptRequested');
    return withTransaction(() => {
      const session = currentCustomerSession(principal.deviceId);
      if (!session) throw error(CHECKOUT_ERROR_CODES.SESSION_NOT_FOUND, 'No open table session was found.');
      const existing = findRequest.get(id);
      if (existing) {
        if (existing.table_session_id !== session.session_id || existing.receipt_requested !== (receipt ? 1 : 0)) throw error(CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT, 'The checkout request ID is already used for a different request.');
        return { request: hydrate(existing), idempotencyResult: 'replayed' };
      }
      const active = database.prepare("SELECT checkout_request_id FROM checkout_requests WHERE table_session_id = ? AND status IN ('requested', 'ready')").get(session.session_id);
      if (active) throw error(CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT, 'An active checkout request already exists for this table session.');
      const requestedAtMs = timestamp();
      const eventEpoch = eventState();
      const orderedItemsTotalYen = orderTotal(session.session_id);
      database.prepare(`INSERT INTO checkout_requests (checkout_request_id, table_session_id, status, receipt_requested, ordered_items_total_yen, adjustments_total_yen, grand_total_yen, version, requested_at_ms, ready_at_ms, updated_at_ms) VALUES (?, ?, 'requested', ?, ?, 0, NULL, 1, ?, NULL, ?)`).run(id, session.session_id, receipt ? 1 : 0, orderedItemsTotalYen, requestedAtMs, requestedAtMs);
      const event = appendEvent(eventEpoch, principal, 'checkout.requested', id, { receiptRequested: receipt }, requestedAtMs);
      return { request: hydrate(findRequest.get(id)), idempotencyResult: 'created', event };
    });
  }
  function getCustomerCheckout(principal) {
    ensureOpen();
    authorizeDeviceRole(principal, ['customer']);
    const session = currentCustomerSession(principal.deviceId);
    if (!session) throw error(CHECKOUT_ERROR_CODES.SESSION_NOT_FOUND, 'No open table session was found.');
    const row = database.prepare('SELECT * FROM checkout_requests WHERE table_session_id = ? ORDER BY requested_at_ms DESC, checkout_request_id DESC LIMIT 1').get(session.session_id);
    return row ? publicRequest(hydrate(row)) : null;
  }
  function listActive({ principal }) {
    ensureOpen();
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    return database.prepare("SELECT * FROM checkout_requests WHERE status IN ('requested', 'ready') ORDER BY requested_at_ms, checkout_request_id").all().map(hydrate);
  }
  function saveAdjustments({ principal, checkoutRequestId, expectedVersion, adjustments }) {
    ensureOpen();
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    const id = requireUuid(checkoutRequestId, 'checkoutRequestId');
    const version = requireVersion(expectedVersion);
    const normalized = normalizeAdjustments(adjustments);
    return withTransaction(() => {
      const current = findRequest.get(id);
      if (!current) throw error(CHECKOUT_ERROR_CODES.CHECKOUT_NOT_FOUND, 'Checkout request was not found.');
      if (current.status !== 'requested') throw error(CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT, 'Only a requested checkout can be adjusted.');
      if (Number(current.version) !== version) throw error(CHECKOUT_ERROR_CODES.VERSION_CONFLICT, 'Checkout request has changed since it was read.');
      const updatedAtMs = timestamp();
      database.prepare('DELETE FROM checkout_adjustments WHERE checkout_request_id = ?').run(id);
      const insert = database.prepare('INSERT INTO checkout_adjustments (checkout_request_id, kind, label, amount_yen, sort_order) VALUES (?, ?, ?, ?, ?)');
      for (const item of normalized) insert.run(id, item.kind, item.label, item.amountYen, item.sortOrder);
      const total = normalized.reduce((sum, item) => sum + item.amountYen, 0);
      database.prepare('UPDATE checkout_requests SET adjustments_total_yen = ?, version = version + 1, updated_at_ms = ? WHERE checkout_request_id = ? AND version = ?').run(total, updatedAtMs, id, version);
      const event = appendEvent(eventState(), principal, 'checkout.adjustments_updated', id, { version: version + 1 }, updatedAtMs);
      return { request: hydrate(findRequest.get(id)), idempotencyResult: 'created', event };
    });
  }
  function ready({ principal, checkoutRequestId, expectedVersion }) {
    ensureOpen();
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    const id = requireUuid(checkoutRequestId, 'checkoutRequestId');
    const version = requireVersion(expectedVersion);
    return withTransaction(() => {
      const current = findRequest.get(id);
      if (!current) throw error(CHECKOUT_ERROR_CODES.CHECKOUT_NOT_FOUND, 'Checkout request was not found.');
      if (current.status === 'ready') {
        if (Number(current.version) !== version) throw error(CHECKOUT_ERROR_CODES.VERSION_CONFLICT, 'Checkout request has changed since it was read.');
        return { request: hydrate(current), idempotencyResult: 'replayed' };
      }
      if (current.status !== 'requested') throw error(CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT, 'Only a requested checkout can be made ready.');
      if (Number(current.version) !== version) throw error(CHECKOUT_ERROR_CODES.VERSION_CONFLICT, 'Checkout request has changed since it was read.');
      const orderedItemsTotalYen = orderTotal(current.table_session_id);
      const adjustmentsTotalYen = adjustmentTotal(id);
      const grandTotalYen = orderedItemsTotalYen + adjustmentsTotalYen;
      const readyAtMs = timestamp();
      database.prepare('UPDATE checkout_requests SET status = \'ready\', ordered_items_total_yen = ?, adjustments_total_yen = ?, grand_total_yen = ?, version = version + 1, ready_at_ms = ?, updated_at_ms = ? WHERE checkout_request_id = ? AND version = ?').run(orderedItemsTotalYen, adjustmentsTotalYen, grandTotalYen, readyAtMs, readyAtMs, id, version);
      const event = appendEvent(eventState(), principal, 'checkout.ready', id, { version: version + 1 }, readyAtMs);
      return { request: hydrate(findRequest.get(id)), idempotencyResult: 'created', event };
    });
  }
  function cancel({ principal, checkoutRequestId, expectedVersion }) {
    ensureOpen();
    authorizeDeviceRole(principal, ['kitchen', 'admin']);
    const id = requireUuid(checkoutRequestId, 'checkoutRequestId');
    const version = requireVersion(expectedVersion);
    return withTransaction(() => {
      const current = findRequest.get(id);
      if (!current) throw error(CHECKOUT_ERROR_CODES.CHECKOUT_NOT_FOUND, 'Checkout request was not found.');
      if (current.status === 'cancelled') {
        if (Number(current.version) !== version) throw error(CHECKOUT_ERROR_CODES.VERSION_CONFLICT, 'Checkout request has changed since it was read.');
        return { request: hydrate(current), idempotencyResult: 'replayed' };
      }
      if (Number(current.version) !== version) throw error(CHECKOUT_ERROR_CODES.VERSION_CONFLICT, 'Checkout request has changed since it was read.');
      const updatedAtMs = timestamp();
      database.prepare("UPDATE checkout_requests SET status = 'cancelled', version = version + 1, updated_at_ms = ? WHERE checkout_request_id = ? AND version = ?").run(updatedAtMs, id, version);
      const event = appendEvent(eventState(), principal, 'checkout.cancelled', id, { version: version + 1 }, updatedAtMs);
      return { request: hydrate(findRequest.get(id)), idempotencyResult: 'created', event };
    });
  }
  return { createCheckout, getCustomerCheckout, listActive, saveAdjustments, ready, cancel, close() { closed = true; } };
}

export { publicRequest };
