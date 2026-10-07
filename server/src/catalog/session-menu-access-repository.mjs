import { randomUUID } from 'node:crypto';

export const SESSION_MENU_ACCESS_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CLOSED: 'SESSION_CLOSED',
  SESSION_CONFLICT: 'SESSION_CONFLICT',
  ITEM_NOT_SESSION_RESTRICTED: 'ITEM_NOT_SESSION_RESTRICTED',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class SessionMenuAccessError extends Error {
  constructor(code, message, options = undefined) { super(message, options); this.name = 'SessionMenuAccessError'; this.code = code; }
}

const VISIBILITY_MODES = new Set(['all_tables', 'per_session']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createSessionMenuAccessRepository({ database, now = Date.now, sessionIdFactory = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new SessionMenuAccessError(SESSION_MENU_ACCESS_ERROR_CODES.DATABASE_FAILURE, 'A ready database connection is required.');
  }
  if (typeof now !== 'function' || typeof sessionIdFactory !== 'function') {
    throw new SessionMenuAccessError(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, 'Clock and session id factories are required.');
  }

  const statements = {
    findItem: database.prepare('SELECT customer_visibility_mode FROM menu_items WHERE menu_item_id = ?'),
    setMode: database.prepare(`UPDATE menu_items SET customer_visibility_mode = ?, version = version + 1, updated_at_ms = ? WHERE menu_item_id = ? AND customer_visibility_mode <> ?`),
    deleteItemGrants: database.prepare('DELETE FROM session_menu_item_grants WHERE menu_item_id = ?'),
    findSession: database.prepare('SELECT session_id, table_id, opened_at_ms, closed_at_ms, version FROM table_sessions WHERE session_id = ?'),
    findOpenSession: database.prepare('SELECT session_id, table_id, opened_at_ms, closed_at_ms, version FROM table_sessions WHERE table_id = ? AND closed_at_ms IS NULL'),
    findTable: database.prepare('SELECT table_id, label, is_active FROM tables WHERE table_id = ?'),
    findTables: database.prepare('SELECT table_id, label, is_active FROM tables ORDER BY table_id'),
    findGrants: database.prepare('SELECT menu_item_id FROM session_menu_item_grants WHERE session_id = ? ORDER BY menu_item_id'),
    countSessionOrders: database.prepare('SELECT COUNT(*) AS count FROM orders WHERE session_id = ?'),
    countSessionCheckouts: database.prepare('SELECT COUNT(*) AS count FROM checkout_requests WHERE table_session_id = ?'),
    countSessionPayments: database.prepare('SELECT COUNT(*) AS count FROM payment_records WHERE table_session_id = ?'),
    insertSession: database.prepare('INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, ?, ?)'),
    insertGrant: database.prepare(`INSERT INTO session_menu_item_grants (session_id, menu_item_id, granted_at_ms) VALUES (?, ?, ?) ON CONFLICT(session_id, menu_item_id) DO NOTHING`),
    deleteGrant: database.prepare('DELETE FROM session_menu_item_grants WHERE session_id = ? AND menu_item_id = ?'),
    eventEpoch: database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1'),
    insertMenuEvent: database.prepare(`INSERT INTO event_log (event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms) VALUES (?, 'menu.updated', 'menu_item', 'catalog', ?, '{"resource":"menu","refreshRequired":true}', ?)`),
  };

  function transaction(work) {
    let open = false;
    try { database.exec('BEGIN IMMEDIATE;'); open = true; const result = work(); database.exec('COMMIT;'); open = false; return result; }
    catch (error) { if (open) { try { database.exec('ROLLBACK;'); } catch {} } if (error instanceof SessionMenuAccessError) throw error; throw new SessionMenuAccessError(SESSION_MENU_ACCESS_ERROR_CODES.DATABASE_FAILURE, 'Session menu access could not be updated.', { cause: error }); }
  }
  function fail(code, message) { throw new SessionMenuAccessError(code, message); }
  function assertId(value, label) { if (typeof value !== 'string' || value.trim() === '' || value.length > 64) fail(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, `${label} is required.`); }
  function assertTableId(value) { if (!Number.isSafeInteger(value) || value < 1) fail(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, 'tableId is invalid.'); }
  function timestamp() { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail(SESSION_MENU_ACCESS_ERROR_CODES.DATABASE_FAILURE, 'Clock returned an invalid timestamp.'); return value; }
  function assertExpectedGrantSnapshot(sessionId, expectedMenuItemIds) {
    if (!Array.isArray(expectedMenuItemIds) || expectedMenuItemIds.length > 500 || expectedMenuItemIds.some((id) => typeof id !== 'string' || id.trim() === '') || new Set(expectedMenuItemIds).size !== expectedMenuItemIds.length) fail(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, 'expectedMenuItemIds is required.');
    const current = sessionId ? statements.findGrants.all(sessionId).map((row) => row.menu_item_id) : [];
    if (JSON.stringify([...expectedMenuItemIds].sort()) !== JSON.stringify(current)) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_CONFLICT, 'The visit menu grants changed. Reload before continuing.');
  }
  function requireCurrentSession(tableId, expectedSessionId) {
    const row = statements.findOpenSession.get(tableId);
    if (!row) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_NOT_FOUND, 'There is no open visit for this table.');
    if (row.session_id !== expectedSessionId) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_CONFLICT, 'The current visit changed. Reload before continuing.');
    return row;
  }
  function recordMenuRefresh(actorDeviceId, at) {
    const epoch = statements.eventEpoch.get()?.event_epoch;
    if (typeof epoch !== 'string') fail(SESSION_MENU_ACCESS_ERROR_CODES.DATABASE_FAILURE, 'The menu event epoch is unavailable.');
    const inserted = statements.insertMenuEvent.run(epoch, actorDeviceId, at);
    return { eventEpoch: epoch, eventId: Number(inserted.lastInsertRowid) };
  }
  function listCurrentAccess() {
    const tables = statements.findTables.all().map((table) => {
      const open = table.is_active === 1 ? statements.findOpenSession.get(table.table_id) : null;
      return {
        tableId: table.table_id,
        label: table.label,
        openSession: open ? {
          sessionId: open.session_id,
          openedAtMs: open.opened_at_ms,
          version: open.version,
          menuItemIds: statements.findGrants.all(open.session_id).map((row) => row.menu_item_id),
          canCloseEmptySession: Number(statements.countSessionOrders.get(open.session_id).count) === 0
            && Number(statements.countSessionCheckouts.get(open.session_id).count) === 0
            && Number(statements.countSessionPayments.get(open.session_id).count) === 0,
        } : null,
      };
    });
    return { tables };
  }
  function setMenuItemVisibilityMode(menuItemId, mode) {
    assertId(menuItemId, 'menuItemId');
    if (!VISIBILITY_MODES.has(mode)) fail(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, 'The customer visibility mode is invalid.');
    return transaction(() => {
      const item = statements.findItem.get(menuItemId);
      if (!item) fail(SESSION_MENU_ACCESS_ERROR_CODES.ITEM_NOT_FOUND, 'The menu item does not exist.');
      if (mode === 'all_tables') statements.deleteItemGrants.run(menuItemId);
      if (item.customer_visibility_mode !== mode) statements.setMode.run(mode, timestamp(), menuItemId, mode);
      return { menuItemId, customerVisibilityMode: mode };
    });
  }
  function grantToCurrentSession({ tableId, expectedSessionId = null, expectedMenuItemIds, startIfMissing = false, menuItemId, actorDeviceId } = {}) {
    assertTableId(tableId); assertId(menuItemId, 'menuItemId'); assertId(actorDeviceId, 'actorDeviceId');
    if (expectedSessionId !== null) assertId(expectedSessionId, 'expectedSessionId');
    if (typeof startIfMissing !== 'boolean' || (expectedSessionId === null && !startIfMissing) || (expectedSessionId !== null && startIfMissing)) fail(SESSION_MENU_ACCESS_ERROR_CODES.INVALID_REQUEST, 'An explicit visit context is required.');
    return transaction(() => {
      const table = statements.findTable.get(tableId);
      if (!table || table.is_active !== 1) fail(SESSION_MENU_ACCESS_ERROR_CODES.TABLE_NOT_FOUND, 'The table does not exist or is inactive.');
      let session = statements.findOpenSession.get(tableId);
      if (expectedSessionId === null) {
        if (session) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_CONFLICT, 'A visit started after this screen was loaded. Reload before granting.');
        const at = timestamp();
        const sessionId = String(sessionIdFactory()).toLowerCase();
        if (!UUID_PATTERN.test(sessionId)) fail(SESSION_MENU_ACCESS_ERROR_CODES.DATABASE_FAILURE, 'Session id factory returned an invalid id.');
        statements.insertSession.run(sessionId, tableId, at, at, at);
        session = statements.findOpenSession.get(tableId);
      } else session = requireCurrentSession(tableId, expectedSessionId);
      assertExpectedGrantSnapshot(session.session_id, expectedMenuItemIds);
      const item = statements.findItem.get(menuItemId);
      if (!item) fail(SESSION_MENU_ACCESS_ERROR_CODES.ITEM_NOT_FOUND, 'The menu item does not exist.');
      if (item.customer_visibility_mode !== 'per_session') fail(SESSION_MENU_ACCESS_ERROR_CODES.ITEM_NOT_SESSION_RESTRICTED, 'The menu item is not configured for session grants.');
      const at = timestamp();
      const inserted = statements.insertGrant.run(session.session_id, menuItemId, at);
      const event = Number(inserted.changes) === 1 ? recordMenuRefresh(actorDeviceId, at) : null;
      return { tableId, sessionId: session.session_id, openedAtMs: session.opened_at_ms, version: session.version, menuItemId, granted: true, event };
    });
  }
  function revokeFromCurrentSession({ tableId, expectedSessionId, expectedMenuItemIds, menuItemId, actorDeviceId } = {}) {
    assertTableId(tableId); assertId(expectedSessionId, 'expectedSessionId'); assertId(menuItemId, 'menuItemId'); assertId(actorDeviceId, 'actorDeviceId');
    return transaction(() => {
      const session = requireCurrentSession(tableId, expectedSessionId);
      assertExpectedGrantSnapshot(session.session_id, expectedMenuItemIds);
      const at = timestamp();
      const deleted = statements.deleteGrant.run(expectedSessionId, menuItemId);
      const event = Number(deleted.changes) === 1 ? recordMenuRefresh(actorDeviceId, at) : null;
      return { tableId, sessionId: expectedSessionId, menuItemId, granted: false, event };
    });
  }
  function grantToSession(sessionId, menuItemId) {
    assertId(sessionId, 'sessionId'); assertId(menuItemId, 'menuItemId');
    return transaction(() => {
      const session = statements.findSession.get(sessionId);
      if (!session) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_NOT_FOUND, 'The table session does not exist.');
      if (session.closed_at_ms !== null) fail(SESSION_MENU_ACCESS_ERROR_CODES.SESSION_CLOSED, 'A closed table session cannot receive a menu grant.');
      const item = statements.findItem.get(menuItemId);
      if (!item) fail(SESSION_MENU_ACCESS_ERROR_CODES.ITEM_NOT_FOUND, 'The menu item does not exist.');
      if (item.customer_visibility_mode !== 'per_session') fail(SESSION_MENU_ACCESS_ERROR_CODES.ITEM_NOT_SESSION_RESTRICTED, 'The menu item is not configured for session grants.');
      statements.insertGrant.run(sessionId, menuItemId, timestamp());
      return { sessionId, menuItemId, granted: true };
    });
  }
  function revokeFromSession(sessionId, menuItemId) {
    assertId(sessionId, 'sessionId'); assertId(menuItemId, 'menuItemId');
    return transaction(() => { statements.deleteGrant.run(sessionId, menuItemId); return { sessionId, menuItemId, granted: false }; });
  }
  function deleteGrantsForClosedSession(sessionId) {
    assertId(sessionId, 'sessionId');
    return statements.deleteGrant.run(sessionId).changes;
  }

  return Object.freeze({ listCurrentAccess, setMenuItemVisibilityMode, grantToSession, revokeFromSession, grantToCurrentSession, revokeFromCurrentSession, deleteGrantsForClosedSession });
}

export function isSessionMenuAccessError(error) { return error instanceof SessionMenuAccessError; }
