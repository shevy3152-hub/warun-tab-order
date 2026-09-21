import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCheckoutRepository } from '../src/checkout/checkout-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUSTOMER = uuid(11);
const KITCHEN = uuid(12);
const SESSION = uuid(13);
const ORDER = uuid(14);
const CLIENT_ORDER = uuid(15);
const CHECKOUT = uuid(16);
const CUSTOMER_TOKEN = Buffer.alloc(32, 3).toString('base64url');
const KITCHEN_TOKEN = Buffer.alloc(32, 4).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function seed(database) {
  const insertDevice = database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)`);
  insertDevice.run(CUSTOMER, 'customer', '架空客席端末', hash(CUSTOMER_TOKEN));
  insertDevice.run(KITCHEN, 'kitchen', '架空厨房端末', hash(KITCHEN_TOKEN));
  database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, created_at_ms, updated_at_ms) VALUES (1, 'テーブル1', ?, 1, 1, 1)`).run(CUSTOMER);
  database.prepare(`INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms) VALUES (?, 1, 10, 1, 10, 10)`).run(SESSION);
  database.prepare(`INSERT INTO categories (category_id, name, sort_order, created_at_ms, updated_at_ms) VALUES ('http-fixture', '架空', 1, 1, 1)`).run();
  database.prepare(`INSERT INTO menu_items (menu_item_id, category_id, formal_name, kitchen_alias, price_yen, is_sold_out, is_active, sort_order, version, created_at_ms, updated_at_ms) VALUES ('http-item', 'http-fixture', '架空商品', '架空', 700, 0, 1, 1, 1, 1, 1)`).run();
  database.prepare(`INSERT INTO orders (order_id, client_order_id, request_fingerprint, canonical_request_json, customer_device_id, table_id, session_id, table_number_snapshot, status, total_amount_yen, accepted_at_ms, completed_at_ms) VALUES (?, ?, ?, '{}', ?, 1, ?, 1, 'completed', 700, 20, 30)`).run(ORDER, CLIENT_ORDER, 'b'.repeat(64), CUSTOMER, SESSION);
  database.prepare(`INSERT INTO order_items (order_item_id, order_id, line_index, menu_item_id, formal_name_snapshot, kitchen_alias_snapshot, unit_price_yen_snapshot, quantity, line_total_yen, created_at_ms, updated_at_ms) VALUES (2, ?, 0, 'http-item', '架空商品', '架空', 700, 1, 700, 20, 20)`).run(ORDER);
}

function request({ port, token, method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const client = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    client.on('error', reject);
    client.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('checkout HTTP contract enforces roles and hides customer breakdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-http-checkout-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'checkout.sqlite3') });
  seed(connection.database);
  const authenticator = createDeviceAuthenticator({ database: connection.database });
  const checkout = createCheckoutRepository({ database: connection.database, now: () => 2000 });
  const noop = () => {};
  const catalog = { getDeviceSettings() { return {}; }, getMenuForPrincipal() { return {}; }, writeMenuItem() {}, writeImageLayouts() {}, writeCategory() {}, writeMenuOrdering() {}, close: noop };
  const orders = { createOrder() {}, getCustomerHistory() {}, getHistory() {}, closeTableSession() {}, markItemServed() {}, close: noop };
  const events = { replay() {}, readCommittedForPrincipal() {}, getCurrentCursor() { return { eventEpoch: uuid(99), lastEventId: 0 }; }, close: noop };
  const snapshots = { getSnapshot() {}, close: noop };
  const hub = { notifyCommitted() {}, attach() {}, close: noop };
  const server = createHttpServer({ database: connection.database, authenticator, catalog, orderRepository: orders, eventRepository: events, snapshotService: snapshots, sseHub: hub, checkout, now: () => 2000 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await request({ port, method: 'POST', path: '/v1/customer/checkout-requests', body: { checkoutRequestId: CHECKOUT, receiptRequested: true } })).statusCode, 401);
    const created = await request({ port, token: CUSTOMER_TOKEN, method: 'POST', path: '/v1/customer/checkout-requests', body: { checkoutRequestId: CHECKOUT, receiptRequested: true } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json.status, 'requested');
    assert.equal(Object.hasOwn(created.json, 'grandTotalYen'), false);
    assert.equal(Object.hasOwn(created.json, 'orderedItemsTotalYen'), false);
    const current = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/checkout-requests/current' });
    assert.equal(Object.hasOwn(current.json.checkout, 'adjustments'), false);
    const adjusted = await request({ port, token: KITCHEN_TOKEN, method: 'PUT', path: `/v1/kitchen/checkout-requests/${CHECKOUT}/adjustments`, body: { expectedVersion: 1, adjustments: [{ kind: 'seat_charge', label: '席料', amountYen: 300 }] } });
    assert.equal(adjusted.statusCode, 200);
    assert.equal(adjusted.json.adjustmentsTotalYen, 300);
    const ready = await request({ port, token: KITCHEN_TOKEN, method: 'POST', path: `/v1/kitchen/checkout-requests/${CHECKOUT}/ready`, body: { expectedVersion: 2 } });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json.grandTotalYen, 1000);
    const publicReady = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/checkout-requests/current' });
    assert.deepEqual(Object.keys(publicReady.json.checkout).sort(), ['checkoutRequestId', 'grandTotalYen', 'readyAtMs', 'receiptRequested', 'requestedAtMs', 'status', 'version'].sort());
    assert.equal(publicReady.json.checkout.grandTotalYen, 1000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    checkout.close();
    authenticator.close();
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
