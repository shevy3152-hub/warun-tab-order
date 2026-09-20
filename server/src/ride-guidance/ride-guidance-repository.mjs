import { randomUUID } from 'node:crypto';

import {
  RIDE_GUIDANCE_ERROR_CODES,
  RideGuidanceRepositoryError,
} from './ride-guidance-errors.mjs';

const TYPES = new Set(['taxi', 'driver_service']);
const PHONE_PATTERN = /^[0-9 ()+-]+$/;
const HTML_PATTERN = /<\/?[A-Za-z][^>]*>/;

function repositoryError(code, message, options = undefined) {
  return new RideGuidanceRepositoryError(code, message, options);
}

function invalidRequest(message) {
  return repositoryError(RIDE_GUIDANCE_ERROR_CODES.INVALID_WRITE_REQUEST, message);
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest('Request must be an object.');
  return value;
}

function text(value, fieldName, maximum, { required = false } = {}) {
  if (typeof value !== 'string') throw invalidRequest(`${fieldName} must be a string.`);
  const normalized = value.trim();
  if (required && normalized === '') throw invalidRequest(`${fieldName} is required.`);
  if ([...normalized].length > maximum) throw invalidRequest(`${fieldName} must be ${maximum} characters or fewer.`);
  if (HTML_PATTERN.test(normalized)) throw invalidRequest(`${fieldName} must be plain text.`);
  return normalized;
}

function normalizePickup(request) {
  requireObject(request);
  return {
    expectedVersion: expectedVersion(request),
    pickupLabel: text(request.pickupLabel, 'pickupLabel', 100),
    pickupAddress: text(request.pickupAddress, 'pickupAddress', 300),
  };
}

function expectedVersion(request) {
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0) throw invalidRequest('expectedVersion is required.');
  return request.expectedVersion;
}

function contactType(value) {
  if (typeof value !== 'string' || !TYPES.has(value)) throw invalidRequest('type must be taxi or driver_service.');
  return value;
}

function normalizeContact(request, { includeId = false } = {}) {
  requireObject(request);
  const result = {
    type: contactType(request.type),
    name: text(request.name, 'name', 100, { required: true }),
    phone: text(request.phone, 'phone', 30, { required: true }),
    note: text(Object.hasOwn(request, 'note') ? request.note : '', 'note', 200),
    isVisible: request.isVisible,
  };
  if (!PHONE_PATTERN.test(result.phone)) throw invalidRequest('phone contains unsupported characters.');
  if (typeof result.isVisible !== 'boolean') throw invalidRequest('isVisible must be boolean.');
  if (includeId) {
    if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.id)) throw invalidRequest('id is invalid.');
    result.id = request.id;
    result.expectedVersion = expectedVersion(request);
  }
  return result;
}

function normalizeDelete(request) {
  requireObject(request);
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.id)) throw invalidRequest('id is invalid.');
  return { id: request.id, expectedVersion: expectedVersion(request) };
}

function mapPickup(row) {
  return {
    pickupLabel: String(row?.pickup_label ?? ''),
    pickupAddress: String(row?.pickup_address ?? ''),
    version: Number(row?.version ?? 0),
    updatedAtMs: Number(row?.updated_at_ms ?? 0),
  };
}

function mapContact(row) {
  return {
    id: String(row.id),
    type: row.type,
    name: String(row.name),
    phone: String(row.phone),
    note: String(row.note ?? ''),
    isVisible: Boolean(row.is_visible),
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function eventContext(database, principal) {
  const state = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
  if (typeof state?.event_epoch !== 'string') throw new Error('Current event epoch is unavailable.');
  if (!principal || principal.role !== 'admin' || typeof principal.deviceId !== 'string') throw new Error('An authenticated admin device is required.');
  return state;
}

function timestampValue(now) {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('The ride-guidance write clock returned an invalid timestamp.');
  return timestamp;
}

export function createRideGuidanceRepository({ database, now = Date.now, idFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof now !== 'function' || typeof idFactory !== 'function') throw new TypeError('A database, clock, and ID factory are required.');
  let closed = false;
  const pickupQuery = database.prepare('SELECT pickup_label, pickup_address, version, updated_at_ms FROM store_pickup_settings WHERE singleton_id = 1');
  const contactQuery = (visibleOnly) => database.prepare(`
    SELECT id, type, name, phone, note, is_visible, sort_order, version, created_at_ms, updated_at_ms
    FROM ride_service_contacts
    ${visibleOnly ? 'WHERE is_visible = 1' : ''}
    ORDER BY CASE type WHEN 'taxi' THEN 0 ELSE 1 END, sort_order, id
  `);
  function ensureOpen() { if (closed) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.DATABASE_FAILURE, 'The ride-guidance repository is closed.'); }
  function readState(visibleOnly) {
    ensureOpen();
    const pickup = pickupQuery.get();
    const contacts = contactQuery(visibleOnly).all().map(mapContact);
    return { pickup: mapPickup(pickup), contacts };
  }
  function runMutation(principal, callback) {
    ensureOpen();
    let transactionOpen = false;
    try {
      const state = eventContext(database, principal);
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const result = callback(state);
      database.exec('COMMIT;');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) { try { database.exec('ROLLBACK;'); } catch {} }
      if (error instanceof RideGuidanceRepositoryError) throw error;
      throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.DATABASE_FAILURE, 'The ride-guidance write failed.', { cause: error });
    }
  }
  function appendEvent(state, principal, type, aggregateId, payload, timestamp) {
    const event = database.prepare(`
      INSERT INTO event_log (event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms)
      VALUES (?, ?, 'ride_guidance', ?, ?, ?, ?)
    `).run(state.event_epoch, type, aggregateId, principal.deviceId, JSON.stringify(payload), timestamp);
    return { eventEpoch: state.event_epoch, eventId: Number(event.lastInsertRowid) };
  }
  function getPublicGuidance() { return readState(true); }
  function getAdminGuidance() { return readState(false); }
  function updatePickup(principal, request) {
    const normalized = normalizePickup(request);
    return runMutation(principal, (state) => {
      const current = pickupQuery.get();
      if (!current || Number(current.version) !== normalized.expectedVersion) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Pickup settings have changed since they were read.');
      const timestamp = timestampValue(now);
      const nextVersion = normalized.expectedVersion + 1;
      const update = database.prepare(`UPDATE store_pickup_settings SET pickup_label = ?, pickup_address = ?, version = ?, updated_at_ms = ? WHERE singleton_id = 1 AND version = ?`).run(normalized.pickupLabel, normalized.pickupAddress, nextVersion, timestamp, normalized.expectedVersion);
      if (Number(update.changes) !== 1) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Pickup settings have changed since they were read.');
      const event = appendEvent(state, principal, 'ride_guidance.pickup_updated', 'pickup', { version: nextVersion }, timestamp);
      return { pickup: mapPickup({ pickup_label: normalized.pickupLabel, pickup_address: normalized.pickupAddress, version: nextVersion, updated_at_ms: timestamp }), event };
    });
  }
  function addContact(principal, request) {
    const normalized = normalizeContact(request);
    return runMutation(principal, (state) => {
      const timestamp = timestampValue(now);
      const id = idFactory();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('The contact ID factory returned an invalid ID.');
      const sort = database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM ride_service_contacts WHERE type = ?').get(normalized.type);
      database.prepare(`INSERT INTO ride_service_contacts (id, type, name, phone, note, is_visible, sort_order, version, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, normalized.type, normalized.name, normalized.phone, normalized.note, normalized.isVisible ? 1 : 0, Number(sort.next_sort), timestamp, timestamp);
      const contact = mapContact(database.prepare('SELECT * FROM ride_service_contacts WHERE id = ?').get(id));
      const event = appendEvent(state, principal, 'ride_guidance.contact_created', id, { id, type: contact.type, version: contact.version }, timestamp);
      return { contact, event };
    });
  }
  function updateContact(principal, request) {
    const normalized = normalizeContact(request, { includeId: true });
    return runMutation(principal, (state) => {
      const current = database.prepare('SELECT * FROM ride_service_contacts WHERE id = ?').get(normalized.id);
      if (!current) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.CONTACT_NOT_FOUND, 'Contact was not found.');
      if (Number(current.version) !== normalized.expectedVersion) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Contact has changed since it was read.');
      const timestamp = timestampValue(now);
      const nextVersion = normalized.expectedVersion + 1;
      const nextSortOrder = normalized.type === current.type
        ? Number(current.sort_order)
        : Number(database.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM ride_service_contacts WHERE type = ?').get(normalized.type).next_sort);
      const update = database.prepare(`UPDATE ride_service_contacts SET type = ?, name = ?, phone = ?, note = ?, is_visible = ?, sort_order = ?, version = ?, updated_at_ms = ? WHERE id = ? AND version = ?`).run(normalized.type, normalized.name, normalized.phone, normalized.note, normalized.isVisible ? 1 : 0, nextSortOrder, nextVersion, timestamp, normalized.id, normalized.expectedVersion);
      if (Number(update.changes) !== 1) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Contact has changed since it was read.');
      const contact = mapContact(database.prepare('SELECT * FROM ride_service_contacts WHERE id = ?').get(normalized.id));
      const event = appendEvent(state, principal, 'ride_guidance.contact_updated', normalized.id, { id: normalized.id, type: contact.type, version: nextVersion }, timestamp);
      return { contact, event };
    });
  }
  function deleteContact(principal, request) {
    const normalized = normalizeDelete(request);
    return runMutation(principal, (state) => {
      const current = database.prepare('SELECT type, version FROM ride_service_contacts WHERE id = ?').get(normalized.id);
      if (!current) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.CONTACT_NOT_FOUND, 'Contact was not found.');
      if (Number(current.version) !== normalized.expectedVersion) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Contact has changed since it was read.');
      const deleted = database.prepare('DELETE FROM ride_service_contacts WHERE id = ? AND version = ?').run(normalized.id, normalized.expectedVersion);
      if (Number(deleted.changes) !== 1) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.VERSION_CONFLICT, 'Contact has changed since it was read.');
      const timestamp = timestampValue(now);
      const event = appendEvent(state, principal, 'ride_guidance.contact_deleted', normalized.id, { id: normalized.id, type: current.type }, timestamp);
      return { id: normalized.id, event };
    });
  }
  function reorderContacts(principal, request) {
    requireObject(request);
    const type = contactType(request.type);
    if (!Array.isArray(request.contactIds) || request.contactIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw invalidRequest('contactIds must be an array of valid IDs.');
    if (new Set(request.contactIds).size !== request.contactIds.length) throw invalidRequest('contactIds must not contain duplicates.');
    return runMutation(principal, (state) => {
      const current = database.prepare('SELECT id, version FROM ride_service_contacts WHERE type = ? ORDER BY sort_order, id').all(type);
      if (current.length !== request.contactIds.length || current.some((row) => !request.contactIds.includes(row.id))) throw repositoryError(RIDE_GUIDANCE_ERROR_CODES.CONTACT_ORDER_MISMATCH, 'contactIds must contain every contact of the type exactly once.');
      const timestamp = timestampValue(now);
      for (const [sortOrder, id] of request.contactIds.entries()) database.prepare('UPDATE ride_service_contacts SET sort_order = ?, version = version + 1, updated_at_ms = ? WHERE id = ?').run(sortOrder, timestamp, id);
      const contacts = database.prepare('SELECT * FROM ride_service_contacts WHERE type = ? ORDER BY sort_order, id').all(type).map(mapContact);
      const event = appendEvent(state, principal, 'ride_guidance.contacts_reordered', type, { type, contactIds: request.contactIds }, timestamp);
      return { type, contacts, event };
    });
  }
  return {
    getPublicGuidance,
    getAdminGuidance,
    updatePickup,
    addContact,
    updateContact,
    deleteContact,
    reorderContacts,
    close() { closed = true; },
  };
}
