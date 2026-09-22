import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCheckoutRepository } from '../src/checkout/checkout-repository.mjs';
import { CHECKOUT_ERROR_CODES } from '../src/checkout/checkout-errors.mjs';
import { initializeDatabase } from '../src/db/database.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUSTOMER = uuid(1);
const KITCHEN = uuid(2);
const SESSION = uuid(3);
const ORDER = uuid(4);
const CLIENT_ORDER = uuid(5);
const CHECKOUT = uuid(6);
const CHECKOUT_RETRY = uuid(7);
const SAME_SESSION_ORDER = uuid(8);
const SAME_SESSION_CLIENT_ORDER = uuid(9);
const LATE_SAME_SESSION_ORDER = uuid(10);
const LATE_SAME_SESSION_CLIENT_ORDER = uuid(11);
const OTHER_SESSION_ORDER = uuid(12);
const OTHER_SESSION_CLIENT_ORDER = uuid(13);
const OTHER_SESSION = uuid(14);
const OTHER_CUSTOMER = uuid(15);
const POST_REQUEST_ORDER = uuid(16);
const POST_REQUEST_CLIENT_ORDER = uuid(17);
const CUSTOMER_TOKEN = Buffer.alloc(32, 1).toString('base64url');
const KITCHEN_TOKEN = Buffer.alloc(32, 2).toString('base64url');
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function seed(database, { includeOrder = true } = {}) {
  const insertDevice = database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)`);
  insertDevice.run(CUSTOMER, 'customer', '架空客席端末', tokenHash(CUSTOMER_TOKEN));
  insertDevice.run(KITCHEN, 'kitchen', '架空厨房端末', tokenHash(KITCHEN_TOKEN));
  database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, created_at_ms, updated_at_ms) VALUES (1, 'テーブル1', ?, 1, 1, 1)`).run(CUSTOMER);
  database.prepare(`INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms) VALUES (?, 1, 10, 1, 10, 10)`).run(SESSION);
  database.prepare(`INSERT INTO categories (category_id, name, sort_order, created_at_ms, updated_at_ms) VALUES ('fixture', '架空カテゴリ', 1, 1, 1)`).run();
  database.prepare(`INSERT INTO menu_items (menu_item_id, category_id, formal_name, kitchen_alias, price_yen, is_sold_out, is_active, sort_order, version, created_at_ms, updated_at_ms) VALUES ('fixture-item', 'fixture', '架空商品', '架空', 500, 0, 1, 1, 1, 1, 1)`).run();
  if (includeOrder) {
    database.prepare(`INSERT INTO orders (order_id, client_order_id, request_fingerprint, canonical_request_json, customer_device_id, table_id, session_id, table_number_snapshot, status, total_amount_yen, accepted_at_ms, completed_at_ms) VALUES (?, ?, ?, '{}', ?, 1, ?, 1, 'completed', 1000, 20, 30)`).run(ORDER, CLIENT_ORDER, 'a'.repeat(64), CUSTOMER, SESSION);
    database.prepare(`INSERT INTO order_items (order_item_id, order_id, line_index, menu_item_id, formal_name_snapshot, kitchen_alias_snapshot, unit_price_yen_snapshot, quantity, line_total_yen, created_at_ms, updated_at_ms) VALUES (1, ?, 0, 'fixture-item', '架空商品', '架空', 500, 2, 1000, 20, 20)`).run(ORDER);
  }
}

function insertCompletedOrder(database, { orderId, clientOrderId, sessionId, tableId, orderItemId, amountYen, timestamp, customerDeviceId = CUSTOMER }) {
  database.prepare(`INSERT INTO orders (order_id, client_order_id, request_fingerprint, canonical_request_json, customer_device_id, table_id, session_id, table_number_snapshot, status, total_amount_yen, accepted_at_ms, completed_at_ms) VALUES (?, ?, ?, '{}', ?, ?, ?, ?, 'completed', ?, ?, ?)`).run(orderId, clientOrderId, `${orderId.replaceAll('-', '')}${'0'.repeat(32)}`, customerDeviceId, tableId, sessionId, tableId, amountYen, timestamp, timestamp + 1);
  database.prepare(`INSERT INTO order_items (order_item_id, order_id, line_index, menu_item_id, formal_name_snapshot, kitchen_alias_snapshot, unit_price_yen_snapshot, quantity, line_total_yen, created_at_ms, updated_at_ms) VALUES (?, ?, 0, 'fixture-item', '架空商品', '架空', ?, 1, ?, ?, ?)`).run(orderItemId, orderId, amountYen, amountYen, timestamp, timestamp);
}

async function withFixture(run, seedOptions = undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-checkout-test-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'checkout.sqlite3') });
  let authenticator;
  let repository;
  try {
    seed(connection.database, seedOptions);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    repository = createCheckoutRepository({ database: connection.database, now: () => 1000 });
    await run({ database: connection.database, repository, customer: authenticator.authenticateDeviceToken(CUSTOMER_TOKEN), kitchen: authenticator.authenticateDeviceToken(KITCHEN_TOKEN) });
  } finally {
    repository?.close();
    authenticator?.close();
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('checkout request is idempotent, totals snapshots are hidden until ready, and ready recalculates orders', async () => {
  await withFixture(({ database, repository, customer, kitchen }) => {
    const created = repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT, receiptRequested: true });
    assert.equal(created.idempotencyResult, 'created');
    assert.equal(created.request.status, 'requested');
    assert.equal(created.request.grandTotalYen, null);
    assert.equal(repository.getCustomerCheckout(customer).grandTotalYen, undefined);
    assert.equal(repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT, receiptRequested: true }).idempotencyResult, 'replayed');
    assert.throws(() => repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT_RETRY, receiptRequested: false }), (e) => e.code === CHECKOUT_ERROR_CODES.CHECKOUT_CONFLICT);

    const adjusted = repository.saveAdjustments({
      principal: kitchen,
      checkoutRequestId: CHECKOUT,
      expectedVersion: 1,
      adjustments: [
        { kind: 'seat_charge', label: '席料', amountYen: 300 },
        { kind: 'late_night_charge', label: '深夜チャージ', amountYen: 200 },
      ],
    });
    assert.equal(adjusted.request.adjustmentsTotalYen, 500);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 2);

    const ready = repository.ready({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 2 });
    assert.equal(ready.request.status, 'ready');
    assert.equal(ready.request.orderedItemsTotalYen, 1000);
    assert.equal(ready.request.grandTotalYen, 1500);
    assert.equal(repository.getCustomerCheckout(customer).grandTotalYen, 1500);
    assert.equal(repository.ready({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 3 }).idempotencyResult, 'replayed');
    assert.equal(database.prepare('SELECT MAX(event_id) AS id FROM event_log').get().id, 3);
  });
});

test('checkout snapshots all same-session order items, excludes another session, and ready refreshes after a later order', async () => {
  await withFixture(({ database, repository, customer, kitchen }) => {
    database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'customer', '架空別客席端末', ?, 'active', 1, 1, 1)`).run(OTHER_CUSTOMER, tokenHash(Buffer.alloc(32, 3).toString('base64url')));
    database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, created_at_ms, updated_at_ms) VALUES (2, 'テーブル2', ?, 1, 1, 1)`).run(OTHER_CUSTOMER);
    database.prepare(`INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms) VALUES (?, 2, 10, 1, 10, 10)`).run(OTHER_SESSION);
    insertCompletedOrder(database, { orderId: SAME_SESSION_ORDER, clientOrderId: SAME_SESSION_CLIENT_ORDER, sessionId: SESSION, tableId: 1, orderItemId: 1, amountYen: 8100, timestamp: 20 });
    insertCompletedOrder(database, { orderId: LATE_SAME_SESSION_ORDER, clientOrderId: LATE_SAME_SESSION_CLIENT_ORDER, sessionId: SESSION, tableId: 1, orderItemId: 2, amountYen: 550, timestamp: 40 });
    insertCompletedOrder(database, { orderId: OTHER_SESSION_ORDER, clientOrderId: OTHER_SESSION_CLIENT_ORDER, sessionId: OTHER_SESSION, tableId: 2, orderItemId: 3, amountYen: 999, timestamp: 40, customerDeviceId: OTHER_CUSTOMER });

    const created = repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT, receiptRequested: false });
    assert.equal(created.request.orderedItemsTotalYen, 8650);
    assert.equal(repository.listActive({ principal: kitchen })[0].orderedItemsTotalYen, 8650);
    assert.equal(repository.getCustomerCheckout(customer).grandTotalYen, undefined);

    insertCompletedOrder(database, { orderId: POST_REQUEST_ORDER, clientOrderId: POST_REQUEST_CLIENT_ORDER, sessionId: SESSION, tableId: 1, orderItemId: 4, amountYen: 200, timestamp: 50 });
    assert.equal(repository.listActive({ principal: kitchen })[0].orderedItemsTotalYen, 8650);

    const ready = repository.ready({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 1 });
    assert.equal(ready.request.orderedItemsTotalYen, 8850);
    assert.equal(ready.request.grandTotalYen, 8850);
  }, { includeOrder: false });
});

test('checkout validates versions, rolls back invalid adjustment writes, and cancellation is evented once', async () => {
  await withFixture(({ database, repository, customer, kitchen }) => {
    repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT, receiptRequested: false });
    assert.throws(() => repository.saveAdjustments({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 99, adjustments: [] }), (e) => e.code === CHECKOUT_ERROR_CODES.VERSION_CONFLICT);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM checkout_adjustments').get().count, 0);
    assert.throws(() => repository.saveAdjustments({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 1, adjustments: [{ kind: 'unknown', label: '不正', amountYen: 1 }] }), (e) => e.code === CHECKOUT_ERROR_CODES.INVALID_CHECKOUT_REQUEST);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);
    const cancelled = repository.cancel({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 1 });
    assert.equal(cancelled.request.status, 'cancelled');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 2);
    assert.equal(repository.cancel({ principal: kitchen, checkoutRequestId: CHECKOUT, expectedVersion: 2 }).idempotencyResult, 'replayed');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 2);
  });
});

test('checkout staff listing excludes cancelled requests and customer cannot manage charges', async () => {
  await withFixture(({ repository, customer, kitchen }) => {
    repository.createCheckout({ principal: customer, checkoutRequestId: CHECKOUT, receiptRequested: false });
    assert.equal(repository.listActive({ principal: kitchen }).length, 1);
    assert.throws(() => repository.saveAdjustments({ principal: customer, checkoutRequestId: CHECKOUT, expectedVersion: 1, adjustments: [] }), /Device authorization failed/);
  });
});
