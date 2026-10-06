import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { createSessionMenuAccessRepository } from '../src/catalog/session-menu-access-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tokenFor = (n) => Buffer.alloc(32, n).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const ADMIN_ID = uuid(6001);
const CUSTOMER_ONE_ID = uuid(6002);
const CUSTOMER_TWO_ID = uuid(6003);
const ADMIN_TOKEN = tokenFor(0x33);
const CUSTOMER_ONE_TOKEN = tokenFor(0x13);
const CUSTOMER_TWO_TOKEN = tokenFor(0x14);

function seed(database) {
  const insertDevice = database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', 1000, NULL, 1000, 1000)`);
  insertDevice.run(ADMIN_ID, 'admin', '架空管理端末', hash(ADMIN_TOKEN));
  insertDevice.run(CUSTOMER_ONE_ID, 'customer', '架空客席端末1', hash(CUSTOMER_ONE_TOKEN));
  insertDevice.run(CUSTOMER_TWO_ID, 'customer', '架空客席端末2', hash(CUSTOMER_TWO_TOKEN));
  const insertTable = database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, 1, 1000, 1000)`);
  insertTable.run(1, 'テーブル1', CUSTOMER_ONE_ID);
  insertTable.run(2, 'テーブル2', CUSTOMER_TWO_ID);
  database.prepare(`INSERT INTO categories (category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms) VALUES ('snacks', 'おつまみ', 1, 1, 1, 1000, 1000)`).run();
  const insertItem = database.prepare(`INSERT INTO menu_items (menu_item_id, category_id, formal_name, kitchen_alias, description, price_yen, is_sold_out, is_active, sort_order, image_uri, version, created_at_ms, updated_at_ms, section_key) VALUES (?, 'snacks', ?, ?, '', 500, 0, 1, ?, NULL, 1, 1000, 1000, 'food')`);
  insertItem.run('normal-snack', '通常商品', '通常商品', 1);
  insertItem.run('secret-snack', '架空の常連商品', '常連商品', 2);
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function request({ port, token, method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ statusCode: res.statusCode, json: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-session-menu-api-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'test.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let access;
  let events;
  let orders;
  let hub;
  try {
    const { database } = connection;
    seed(database);
    authenticator = createDeviceAuthenticator({ database });
    catalog = createCatalogRepository({ database, now: () => 1_800_000_100_000 });
    access = createSessionMenuAccessRepository({ database, now: () => 1_800_000_100_000, sessionIdFactory: () => uuid(7777) });
    events = createEventRepository({ database });
    orders = createOrderRepository({ database, now: () => 1_800_000_100_000 });
    const snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 100, maxConnectionMs: 1_000 });
    server = createHttpServer({ database, authenticator, catalog, sessionMenuAccess: access, orderRepository: orders, eventRepository: events, snapshotService: snapshots, sseHub: hub });
    const port = await listen(server);
    await run({ database, port, authenticator, events, catalog });
  } finally {
    await closeServer(server).catch(() => {});
    try { hub?.close(); } catch {}
    try { events?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { access?.close?.(); } catch {}
    try { catalog?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

function modeWrite() {
  return {
    expectedVersion: 1, menuItemId: 'secret-snack', categoryId: 'snacks', formalName: '架空の常連商品', kitchenAlias: '常連商品',
    description: '架空データ', priceYen: 500, isSoldOut: false, isActive: true, sortOrder: 2, imageUri: null,
    customerVisibilityMode: 'per_session', detail: { enabled: false }, variants: [], servingOptions: [],
  };
}

const accessPath = '/v1/admin/session-menu-access';
const grantsPath = `${accessPath}/grants`;
const menuPath = '/v1/menu';

test('session menu grant API is admin-only, optimistic, scoped to one open visit, and opaque to other customers', async () => {
  await withFixture(async ({ database, port, authenticator, events, catalog }) => {
    assert.equal((await request({ port, path: accessPath })).statusCode, 401);
    assert.equal((await request({ port, token: CUSTOMER_ONE_TOKEN, path: accessPath })).statusCode, 403);
    const admin = authenticator.authenticateDeviceToken(ADMIN_TOKEN);
    const customerOne = authenticator.authenticateDeviceToken(CUSTOMER_ONE_TOKEN);
    const customerTwo = authenticator.authenticateDeviceToken(CUSTOMER_TWO_TOKEN);

    const modeResponse = await request({ port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/catalog/menu-item', body: modeWrite() });
    assert.equal(modeResponse.statusCode, 200, JSON.stringify(modeResponse.json));
    assert.equal(database.prepare('SELECT customer_visibility_mode FROM menu_items WHERE menu_item_id = ?').get('secret-snack').customer_visibility_mode, 'per_session');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM table_sessions').get().count, 0, 'changing display mode does not start a visit');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_menu_item_grants').get().count, 0, 'display mode and visit grant are separate');

    const savedAdminMenu = await request({ port, token: ADMIN_TOKEN, path: menuPath });
    assert.equal(savedAdminMenu.statusCode, 200);
    assert.equal(savedAdminMenu.json.audience, 'admin');
    const savedRestrictedItem = savedAdminMenu.json.items.find((item) => item.menuItemId === 'secret-snack');
    assert.equal(savedRestrictedItem.customerVisibilityMode, 'per_session', 'admin menu DTO preserves the saved display mode');
    assert.equal(savedRestrictedItem.version, modeResponse.json.version);
    assert.ok(savedAdminMenu.json.items.filter((item) => item.customerVisibilityMode === 'per_session').some((item) => item.menuItemId === 'secret-snack'), 'the saved item is eligible for the session grant UI');
    assert.doesNotMatch(JSON.stringify(savedAdminMenu.json), /sessionId|tableId|menuItemIds/);

    const noSession = await request({ port, token: ADMIN_TOKEN, path: accessPath });
    assert.equal(noSession.statusCode, 200);
    assert.equal(noSession.json.tables.length, 2);
    assert.equal(noSession.json.tables[0].openSession, null);
    const firstMenu = (await request({ port, token: CUSTOMER_ONE_TOKEN, path: menuPath })).json;
    const secondMenu = (await request({ port, token: CUSTOMER_TWO_TOKEN, path: menuPath })).json;
    assert.equal(firstMenu.items.some((item) => item.menuItemId === 'secret-snack'), false);
    assert.equal(secondMenu.items.some((item) => item.menuItemId === 'secret-snack'), false);

    const started = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: null, expectedMenuItemIds: [], startIfMissing: true } });
    assert.equal(started.statusCode, 200, JSON.stringify(started.json));
    const sessionId = started.json.sessionId;
    assert.equal(sessionId, uuid(7777));
    const staleStart = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: null, expectedMenuItemIds: [], startIfMissing: true } });
    assert.equal(staleStart.statusCode, 409);
    assert.equal(staleStart.json.error.code, 'SESSION_CONFLICT');

    const staleGrantList = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: sessionId, expectedMenuItemIds: [], startIfMissing: false } });
    assert.equal(staleGrantList.statusCode, 409);
    const secondGrant = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: sessionId, expectedMenuItemIds: ['secret-snack'], startIfMissing: false } });
    assert.equal(secondGrant.statusCode, 200);
    assert.equal(secondGrant.json.sessionId, sessionId, 'a current visit is reused');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM table_sessions').get().count, 1);

    const firstMenuAfterGrant = (await request({ port, token: CUSTOMER_ONE_TOKEN, path: menuPath })).json;
    const secondMenuAfterGrant = (await request({ port, token: CUSTOMER_TWO_TOKEN, path: menuPath })).json;
    assert.equal(firstMenuAfterGrant.items.some((item) => item.menuItemId === 'secret-snack'), true);
    assert.equal(secondMenuAfterGrant.items.some((item) => item.menuItemId === 'secret-snack'), false);
    const customerJson = JSON.stringify(firstMenuAfterGrant);
    for (const secret of ['customerVisibilityMode', 'per_session', 'sessionId', 'tableId', 'menuItemIds']) assert.equal(customerJson.includes(secret), false);

    const cursor = events.getCurrentCursor(customerOne);
    const projected = events.readCommittedForPrincipal(customerOne, { eventEpoch: cursor.eventEpoch, afterEventId: 0 });
    const menuInvalidations = projected.events.filter((event) => event.type === 'menu.updated');
    assert.ok(menuInvalidations.length >= 2);
    for (const event of menuInvalidations) {
      assert.equal(event.aggregateId, 'menu');
      assert.deepEqual(event.payload, { resource: 'menu', refreshRequired: true });
      assert.equal(JSON.stringify(event).includes('secret-snack'), false);
      assert.equal(JSON.stringify(event).includes('tableId'), false);
    }

    const revoked = await request({ port, token: ADMIN_TOKEN, method: 'PUT', path: grantsPath, body: { tableId: 1, expectedSessionId: sessionId, expectedMenuItemIds: ['secret-snack'], menuItemId: 'secret-snack' } });
    assert.equal(revoked.statusCode, 200, JSON.stringify(revoked.json));
    assert.equal(revoked.json.granted, false);
    assert.equal((await request({ port, token: CUSTOMER_ONE_TOKEN, path: menuPath })).json.items.some((item) => item.menuItemId === 'secret-snack'), false);

    await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: sessionId, expectedMenuItemIds: ['secret-snack'], startIfMissing: false } });
    const closed = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/tables/sessions/close', body: { tableId: 1, sessionId } });
    assert.equal(closed.statusCode, 200);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_menu_item_grants WHERE session_id = ?').get(sessionId).count, 0);
    const afterClose = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: grantsPath, body: { tableId: 1, menuItemId: 'secret-snack', expectedSessionId: sessionId, expectedMenuItemIds: ['secret-snack'], startIfMissing: false } });
    assert.equal(afterClose.statusCode, 409);
    assert.equal((await request({ port, token: CUSTOMER_ONE_TOKEN, path: menuPath })).json.items.some((item) => item.menuItemId === 'secret-snack'), false);
  });
});
