import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { ORDER_JSON_BODY_LIMIT_BYTES } from '../src/http/json-body.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const CUSTOMER_A_ID = uuid(101);
const CUSTOMER_B_ID = uuid(102);
const KITCHEN_ID = uuid(201);
const ADMIN_ID = uuid(301);
const REVOKED_ID = uuid(401);
const CUSTOMER_A_TOKEN = tokenFor(0x11);
const CUSTOMER_B_TOKEN = tokenFor(0x12);
const KITCHEN_TOKEN = tokenFor(0x21);
const ADMIN_TOKEN = tokenFor(0x31);
const REVOKED_TOKEN = tokenFor(0x41);
const UNKNOWN_TOKEN = tokenFor(0x51);
const OTHER_EPOCH = uuid(999);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function seedDatabase(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status, paired_at_ms,
      revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?, 1000, 1000)
  `);
  insertDevice.run(CUSTOMER_A_ID, 'customer', 'Customer A', tokenHash(CUSTOMER_A_TOKEN), 'active', null);
  insertDevice.run(CUSTOMER_B_ID, 'customer', 'Customer B', tokenHash(CUSTOMER_B_TOKEN), 'active', null);
  insertDevice.run(KITCHEN_ID, 'kitchen', 'Kitchen', tokenHash(KITCHEN_TOKEN), 'active', null);
  insertDevice.run(ADMIN_ID, 'admin', 'Admin', tokenHash(ADMIN_TOKEN), 'active', null);
  insertDevice.run(REVOKED_ID, 'customer', 'Revoked', tokenHash(REVOKED_TOKEN), 'revoked', 1500);

  const insertTable = database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active,
      version, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, 1, 1000, 1000)
  `);
  insertTable.run(1, 'Table 1', CUSTOMER_A_ID);
  insertTable.run(2, 'Table 2', CUSTOMER_B_ID);

  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms
    ) VALUES ('food', 'Food', 1, 1, 1, 1000, 1000)
  `).run();
  const insertMenuItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description,
      price_yen, is_sold_out, is_active, sort_order, version,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'food', ?, ?, ?, ?, ?, 1, ?, 1, 1000, 1000)
  `);
  insertMenuItem.run('edamame', 'Edamame formal', 'Edamame', 'Green soybeans', 380, 0, 1);
  insertMenuItem.run('beer', 'Beer formal', 'Beer', 'Cold beer', 680, 0, 2);
  insertMenuItem.run('soldout', 'Sold-out formal', 'Sold', 'Unavailable', 480, 1, 3);
}

function currentCursor(database) {
  return database.prepare(`
    SELECT
      s.event_epoch AS eventEpoch,
      COALESCE(MAX(e.event_id), 0) AS lastEventId
    FROM system_state AS s
    LEFT JOIN event_log AS e ON e.event_epoch = s.event_epoch
    WHERE s.singleton_id = 1
    GROUP BY s.event_epoch
  `).get();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withFixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-order-http-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'server.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let orders;
  let events;
  let hub;
  try {
    seedDatabase(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    let generatedOrder = 8_000;
    let acceptedAtMs = 1_800_000_000_000;
    orders = createOrderRepository({
      database: connection.database,
      idFactory: () => uuid(generatedOrder++),
      now: () => acceptedAtMs++,
    });
    events = createEventRepository({ database: connection.database });
    const snapshots = createSnapshotService({ catalog, eventRepository: events });
    const realHub = createSseHub({
      eventRepository: events,
      heartbeatIntervalMs: 500,
      maxConnectionMs: 30_000,
    });
    hub = options.wrapHub?.(realHub, connection) ?? realHub;
    server = createHttpServer({
      database: connection.database,
      authenticator,
      catalog,
      orderRepository: orders,
      eventRepository: events,
      snapshotService: snapshots,
      sseHub: hub,
      now: () => 1_800_000_001_000,
    });
    const port = await listen(server);
    await run({
      connection,
      database: connection.database,
      server,
      port,
      authenticator,
      catalog,
      orders,
      events,
      hub: realHub,
      closeServer: () => closeServer(server),
    });
  } finally {
    await closeServer(server).catch(() => {});
    try {
      hub?.close?.();
    } catch {
      // A failure-injection wrapper may deliberately throw from one method.
    }
    events?.close();
    orders?.close();
    catalog?.close();
    authenticator?.close();
    try {
      connection.close();
    } catch {
      // A test may close its own connection only after it has completed assertions.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function orderBody(clientOrderId, items = [{ menuItemId: 'edamame', quantity: 1 }], extra = {}) {
  return {
    schemaVersion: 1,
    clientOrderId,
    items,
    ...extra,
  };
}

async function request({ port, path, method = 'GET', headers = {}, body = undefined }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let json;
        if (rawBody !== '') json = JSON.parse(rawBody);
        resolve({ statusCode: response.statusCode, headers: response.headers, rawBody, json });
      });
    });
    client.on('error', reject);
    client.end(body);
  });
}

function postOrder(port, token, body, headers = {}) {
  const encoded = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body);
  return request({
    port,
    path: '/v1/orders',
    method: 'POST',
    headers: { ...bearer(token), ...JSON_HEADERS, ...headers },
    body: encoded,
  });
}

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, 'string');
  assert.equal(typeof response.json.requestId, 'string');
  assert.doesNotMatch(response.rawBody, /token_hash|request_fingerprint|canonical_request|SQLITE|SELECT /i);
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

async function openSse({ port, token, eventEpoch, lastEventId }) {
  let requestHandle;
  const opened = new Promise((resolve, reject) => {
    const headers = bearer(token);
    if (eventEpoch !== undefined) headers['X-Event-Epoch'] = eventEpoch;
    if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
    requestHandle = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/events',
      method: 'GET',
      headers,
      agent: false,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      resolve({
        response,
        request: requestHandle,
        get text() {
          return text;
        },
        close() {
          requestHandle.destroy();
          response.destroy();
        },
      });
    });
    requestHandle.on('error', reject);
    requestHandle.end();
  });
  return opened;
}

async function waitForSse(stream, pattern, label) {
  return waitFor(
    () => (pattern.test(stream.text) ? stream.text : undefined),
    label,
  );
}

test('integrated HTTP factory refuses to advertise routes without all core services', () => {
  assert.throws(
    () => createHttpServer({
      authenticator: { authenticateDeviceToken() {} },
      catalog: { getDeviceSettings() {}, getMenuForPrincipal() {} },
      readServiceState: () => ({
        schemaVersion: 1,
        eventEpoch: uuid(1),
        lastEventId: 0,
      }),
    }),
    (error) => error.code === 'INTERNAL_ERROR',
  );
});

test('created order is safely acknowledged, committed atomically, and then wakes SSE', async () => {
  await withFixture(async ({ port, database }) => {
    const stream = await openSse({ port, token: KITCHEN_TOKEN });
    const clientOrderId = uuid(1_001);
    const responsePromise = postOrder(port, CUSTOMER_A_TOKEN, orderBody(clientOrderId, [
      { menuItemId: 'edamame', quantity: 2 },
      { menuItemId: 'beer', quantity: 1 },
    ]));
    await waitForSse(stream, /event: order\.created/, 'committed order event');

    assert.equal(count(database, 'orders'), 1);
    assert.equal(count(database, 'order_items'), 2);
    assert.equal(count(database, 'event_log'), 1);
    const persisted = database.prepare('SELECT * FROM orders').get();
    assert.equal(persisted.customer_device_id, CUSTOMER_A_ID);
    assert.equal(persisted.table_id, 1);
    assert.equal(persisted.total_amount_yen, 1_440);

    const response = await responsePromise;
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['idempotency-result'], 'created');
    assert.deepEqual(Object.keys(response.json).sort(), [
      'acceptedAtMs',
      'clientOrderId',
      'idempotencyResult',
      'orderId',
      'status',
    ]);
    assert.equal(response.json.idempotencyResult, 'created');
    assert.doesNotMatch(response.rawBody, /price|total|fingerprint|canonical|kitchenAlias/i);
    assert.doesNotMatch(
      stream.text,
      /token|hash|price|unitPrice|totalAmount|kitchenAlias|formalName/i,
    );
    stream.close();
  });
});

test('admin order history reads completed SQLite orders without exposing internal fields', async () => {
  await withFixture(async ({ port, database }) => {
    const clientOrderId = uuid(1_101);
    const created = await postOrder(port, CUSTOMER_A_TOKEN, orderBody(clientOrderId));
    assert.equal(created.statusCode, 201);
    database.prepare("UPDATE orders SET status = 'completed', completed_at_ms = ? WHERE client_order_id = ?")
      .run(1_800_000_002_000, clientOrderId);

    const response = await request({
      port,
      path: '/v1/admin/order-history',
      headers: bearer(ADMIN_TOKEN),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.orders.length, 1);
    assert.equal(response.json.orders[0].clientOrderId, clientOrderId);
    assert.equal(response.json.orders[0].items.length, 1);
    assert.doesNotMatch(response.rawBody, /requestFingerprint|canonicalRequest|authenticatedDeviceId|token/i);

    const customerResponse = await request({
      port,
      path: '/v1/admin/order-history',
      headers: bearer(CUSTOMER_A_TOKEN),
    });
    assertError(customerResponse, 403, 'AUTHORIZATION_FAILED');
  });
});

test('kitchen can serve items, complete orders, and expose them to admin history', async () => {
  await withFixture(async ({ port, database }) => {
    const created = await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_102)));
    assert.equal(created.statusCode, 201);
    const stored = database.prepare('SELECT order_id FROM orders LIMIT 1').get();
    const item = database.prepare('SELECT order_item_id FROM order_items WHERE order_id = ?').get(stored.order_id);
    const served = await request({
      port,
      path: '/v1/kitchen/order-items/serve',
      method: 'POST',
      headers: { ...bearer(KITCHEN_TOKEN), ...JSON_HEADERS },
      body: JSON.stringify({ orderId: stored.order_id, orderItemId: item.order_item_id }),
    });
    assert.equal(served.statusCode, 200);
    assert.equal(served.json.orders[0].status, 'completed');
    assert.equal(database.prepare('SELECT status FROM orders WHERE order_id = ?').get(stored.order_id).status, 'completed');
    assert.equal(database.prepare("SELECT event_type FROM event_log WHERE aggregate_id = ? ORDER BY event_id DESC LIMIT 1").get(stored.order_id).event_type, 'order.completed');

    const history = await request({ port, path: '/v1/admin/order-history', headers: bearer(ADMIN_TOKEN) });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json.orders[0].orderId, stored.order_id);
  });
});

test('same intent replays without rows or notification; changed quantity or item conflicts', async () => {
  await withFixture(async ({ port, database }) => {
    const stream = await openSse({ port, token: KITCHEN_TOKEN });
    const clientOrderId = uuid(1_002);
    const original = orderBody(clientOrderId);
    assert.equal((await postOrder(port, CUSTOMER_A_TOKEN, original)).statusCode, 201);
    await waitForSse(stream, /event: order\.created/, 'first live event');
    const eventFramesBefore = (stream.text.match(/event: order\.created/g) ?? []).length;

    const replay = await postOrder(port, CUSTOMER_A_TOKEN, original);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-result'], 'replayed');
    assert.equal(replay.json.idempotencyResult, 'replayed');
    assert.equal(count(database, 'orders'), 1);
    assert.equal(count(database, 'order_items'), 1);
    assert.equal(count(database, 'event_log'), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((stream.text.match(/event: order\.created/g) ?? []).length, eventFramesBefore);

    assertError(
      await postOrder(port, CUSTOMER_A_TOKEN, orderBody(clientOrderId, [
        { menuItemId: 'edamame', quantity: 2 },
      ])),
      409,
      'ORDER_CONFLICT',
    );
    assertError(
      await postOrder(port, CUSTOMER_A_TOKEN, orderBody(clientOrderId, [
        { menuItemId: 'beer', quantity: 1 },
      ])),
      409,
      'ORDER_CONFLICT',
    );
    assert.equal(database.prepare('SELECT quantity FROM order_items').get().quantity, 1);
    stream.close();
  });
});

test('business validation, authentication, revocation, and customer-only authorization are enforced', async () => {
  await withFixture(async ({ port }) => {
    assertError(
      await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_010), [
        { menuItemId: 'soldout', quantity: 1 },
      ])),
      422,
      'MENU_ITEM_SOLD_OUT',
    );
    assertError(
      await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_011), [
        { menuItemId: 'missing', quantity: 1 },
      ])),
      422,
      'MENU_ITEM_NOT_FOUND',
    );

    const encoded = JSON.stringify(orderBody(uuid(1_012)));
    assertError(await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: JSON_HEADERS,
      body: encoded,
    }), 401, 'AUTHENTICATION_FAILED');
    assertError(await postOrder(port, REVOKED_TOKEN, orderBody(uuid(1_013))), 401, 'AUTHENTICATION_FAILED');
    assertError(await postOrder(port, UNKNOWN_TOKEN, orderBody(uuid(1_014))), 401, 'AUTHENTICATION_FAILED');
    assertError(await postOrder(port, KITCHEN_TOKEN, orderBody(uuid(1_015))), 403, 'AUTHORIZATION_FAILED');
    assertError(await postOrder(port, ADMIN_TOKEN, orderBody(uuid(1_016))), 403, 'AUTHORIZATION_FAILED');
  });
});

test('order JSON boundary rejects untrusted fields, malformed/duplicate JSON, media errors, and over-limit bodies', async () => {
  await withFixture(async ({ port, database }) => {
    const malicious = orderBody(uuid(1_020), undefined, {
      deviceId: CUSTOMER_B_ID,
      role: 'admin',
      tableId: 2,
      priceYen: 1,
      unknown: true,
    });
    assertError(await postOrder(port, CUSTOMER_A_TOKEN, malicious), 400, 'INVALID_ORDER_REQUEST');
    assert.equal(count(database, 'orders'), 0);

    assertError(await postOrder(port, CUSTOMER_A_TOKEN, '{"schemaVersion":1'), 400, 'INVALID_ORDER_REQUEST');
    const duplicate = `{"schemaVersion":1,"clientOrderId":"${uuid(1_021)}","clientOrderId":"${uuid(1_022)}","items":[{"menuItemId":"edamame","quantity":1}]}`;
    assertError(await postOrder(port, CUSTOMER_A_TOKEN, duplicate), 400, 'INVALID_ORDER_REQUEST');

    const validText = JSON.stringify(orderBody(uuid(1_023)));
    assertError(await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: { ...bearer(CUSTOMER_A_TOKEN), 'Content-Type': 'text/plain' },
      body: validText,
    }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    assertError(await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: bearer(CUSTOMER_A_TOKEN),
      body: validText,
    }), 415, 'UNSUPPORTED_MEDIA_TYPE');

    const measuredTooLarge = `{"padding":"${'x'.repeat(ORDER_JSON_BODY_LIMIT_BYTES)}"}`;
    assertError(await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: { ...bearer(CUSTOMER_A_TOKEN), ...JSON_HEADERS },
      body: measuredTooLarge,
    }), 413, 'PAYLOAD_TOO_LARGE');
    assertError(await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: {
        ...bearer(CUSTOMER_A_TOKEN),
        ...JSON_HEADERS,
        'Content-Length': String(ORDER_JSON_BODY_LIMIT_BYTES + 1),
      },
      body: '',
    }), 413, 'PAYLOAD_TOO_LARGE');

    const exactJson = JSON.stringify(orderBody(uuid(1_024)));
    const exactBody = exactJson + ' '.repeat(ORDER_JSON_BODY_LIMIT_BYTES - Buffer.byteLength(exactJson));
    const exact = await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: {
        ...bearer(CUSTOMER_A_TOKEN),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(ORDER_JSON_BODY_LIMIT_BYTES),
      },
      body: exactBody,
    });
    assert.equal(exact.statusCode, 201);
    assert.equal(database.prepare('SELECT customer_device_id FROM orders').get().customer_device_id, CUSTOMER_A_ID);
  });
});

test('a response socket loss leaves a durable order that safely replays with the same ID', async () => {
  await withFixture(async ({ port, database }) => {
    const clientOrderId = uuid(1_030);
    const body = JSON.stringify(orderBody(clientOrderId));
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write([
          'POST /v1/orders HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${CUSTOMER_A_TOKEN}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'));
      });
      socket.once('data', () => {
        socket.destroy();
        resolve();
      });
    });
    await waitFor(
      () => database.prepare('SELECT order_id FROM orders WHERE client_order_id = ?').get(clientOrderId),
      'durable order after response loss',
    );

    const replay = await postOrder(port, CUSTOMER_A_TOKEN, orderBody(clientOrderId));
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['idempotency-result'], 'replayed');
    assert.equal(count(database, 'orders'), 1);
    assert.equal(count(database, 'event_log'), 1);
  });
});

test('a live notify failure never rolls back a committed order or changes its HTTP success', async () => {
  await withFixture(async ({ port, database }) => {
    const response = await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_040)));
    assert.equal(response.statusCode, 201);
    assert.equal(count(database, 'orders'), 1);
    assert.equal(count(database, 'order_items'), 1);
    assert.equal(count(database, 'event_log'), 1);
  }, {
    wrapHub(realHub) {
      return {
        attach: realHub.attach,
        close: realHub.close,
        notifyCommitted() {
          throw new Error('intentional wake failure');
        },
      };
    },
  });
});

test('a real SQLite write lock maps to retryable 503 instead of an internal error', async () => {
  await withFixture(async ({ port, connection, database }) => {
    const blocker = initializeDatabase({ databasePath: connection.databasePath });
    blocker.database.exec('BEGIN IMMEDIATE;');
    let response;
    try {
      response = await postOrder(
        port,
        CUSTOMER_A_TOKEN,
        orderBody(uuid(1_055)),
      );
    } finally {
      blocker.database.exec('ROLLBACK;');
      blocker.close();
    }

    assertError(response, 503, 'SERVICE_UNAVAILABLE');
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(count(database, 'orders'), 0);
    assert.equal(count(database, 'event_log'), 0);
  });
});

test('event replay is ordered, bounded by scan limit, and advances through invisible events', async () => {
  await withFixture(async ({ port, database }) => {
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_050)));
    await postOrder(port, CUSTOMER_B_TOKEN, orderBody(uuid(1_051)));
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_052), [
      { menuItemId: 'beer', quantity: 1 },
    ]));
    const { eventEpoch } = currentCursor(database);

    const first = await request({
      port,
      path: `/v1/events/replay?eventEpoch=${eventEpoch}&afterEventId=0&limit=2`,
      headers: bearer(CUSTOMER_A_TOKEN),
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json.audience, 'customer');
    assert.deepEqual(first.json.events.map((event) => event.eventId), [1]);
    assert.equal(first.json.lastEventId, 2);
    assert.equal(first.json.hasMore, true);
    assert.doesNotMatch(first.rawBody, /380|680|price|token|hash/i);

    const second = await request({
      port,
      path: `/v1/events/replay?eventEpoch=${eventEpoch}&afterEventId=2&limit=2`,
      headers: bearer(CUSTOMER_A_TOKEN),
    });
    assert.deepEqual(second.json.events.map((event) => event.eventId), [3]);
    assert.equal(second.json.lastEventId, 3);
    assert.equal(second.json.hasMore, false);

    const kitchen = await request({
      port,
      path: `/v1/events/replay?eventEpoch=${eventEpoch}&afterEventId=0&limit=10`,
      headers: bearer(KITCHEN_TOKEN),
    });
    assert.deepEqual(kitchen.json.events.map((event) => event.eventId), [1, 2, 3]);
  });
});

test('SSE initial connection tails snapshot cursor and reconnect replays exactly the missing range', async () => {
  await withFixture(async ({ port, database }) => {
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_060)));
    const initialCursor = currentCursor(database);
    const firstStream = await openSse({ port, token: KITCHEN_TOKEN });
    assert.equal(firstStream.response.statusCode, 200);
    assert.equal(
      firstStream.response.headers['content-type'],
      'text/event-stream; charset=utf-8',
    );
    assert.match(firstStream.response.headers['cache-control'], /no-store/);
    assert.equal(firstStream.response.headers['x-content-type-options'], 'nosniff');
    assert.match(firstStream.response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(firstStream.response.headers['x-event-epoch'], initialCursor.eventEpoch);
    assert.doesNotMatch(firstStream.text, /event: order\.created/);

    await postOrder(port, CUSTOMER_B_TOKEN, orderBody(uuid(1_061)));
    await waitForSse(firstStream, /id: 2\nevent: order\.created/, 'second live order');
    firstStream.close();

    const reconnected = await openSse({
      port,
      token: KITCHEN_TOKEN,
      eventEpoch: initialCursor.eventEpoch,
      lastEventId: 1,
    });
    await waitForSse(reconnected, /id: 2\nevent: order\.created/, 'replayed missing event');
    assert.equal((reconnected.text.match(/event: order\.created/g) ?? []).length, 1);
    reconnected.close();
  });
});

test('epoch mismatch, future cursor, and deleted cursor return 410 with snapshot recovery', async () => {
  await withFixture(async ({ port, database }) => {
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_070)));
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_071), [
      { menuItemId: 'beer', quantity: 1 },
    ]));
    const cursor = currentCursor(database);

    const cases = [
      { epoch: OTHER_EPOCH, id: 1 },
      { epoch: cursor.eventEpoch, id: cursor.lastEventId + 1 },
    ];
    for (const entry of cases) {
      const response = await request({
        port,
        path: '/v1/events',
        headers: {
          ...bearer(KITCHEN_TOKEN),
          'X-Event-Epoch': entry.epoch,
          'Last-Event-ID': String(entry.id),
        },
      });
      assert.equal(response.statusCode, 410);
      assert.equal(response.json.error.code, 'EVENT_HISTORY_UNAVAILABLE');
      assert.equal(response.json.recovery.strategy, 'snapshot');
      assert.equal(response.json.recovery.snapshotUrl, '/v1/snapshot');
      assert.equal(response.json.recovery.currentEventEpoch, cursor.eventEpoch);
      assert.equal(response.json.recovery.lastEventId, cursor.lastEventId);
    }

    database.prepare('DELETE FROM event_log WHERE event_id = 1').run();
    const deleted = await request({
      port,
      path: '/v1/events',
      headers: {
        ...bearer(KITCHEN_TOKEN),
        'X-Event-Epoch': cursor.eventEpoch,
        'Last-Event-ID': '1',
      },
    });
    assert.equal(deleted.statusCode, 410);
    assert.equal(deleted.json.recovery.lastEventId, 2);

    const snapshot = await request({
      port,
      path: '/v1/snapshot',
      headers: bearer(KITCHEN_TOKEN),
    });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json.eventEpoch, deleted.json.recovery.currentEventEpoch);
    assert.equal(snapshot.json.lastEventId, deleted.json.recovery.lastEventId);
  });
});

test('an initial SSE race still returns JSON 410 or 500 before stream headers open', async () => {
  let rotateOnce = true;
  await withFixture(async ({ port, database }) => {
    const cursor = currentCursor(database);
    const response = await request({
      port,
      path: '/v1/events',
      headers: {
        ...bearer(KITCHEN_TOKEN),
        'X-Event-Epoch': cursor.eventEpoch,
        'Last-Event-ID': '0',
      },
    });
    assertError(response, 410, 'EVENT_HISTORY_UNAVAILABLE');
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['x-event-epoch'], undefined);
  }, {
    wrapHub(realHub, connection) {
      return {
        attach(options) {
          if (rotateOnce) {
            rotateOnce = false;
            connection.database
              .prepare('UPDATE system_state SET event_epoch = ? WHERE singleton_id = 1')
              .run(OTHER_EPOCH);
          }
          return realHub.attach(options);
        },
        notifyCommitted: (notification) => realHub.notifyCommitted(notification),
        close: () => realHub.close(),
      };
    },
  });

  await withFixture(async ({ port }) => {
    const response = await request({
      port,
      path: '/v1/events',
      headers: bearer(KITCHEN_TOKEN),
    });
    assertError(response, 500, 'INTERNAL_ERROR');
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  }, {
    wrapHub(realHub, connection) {
      return {
        attach(options) {
          connection.close();
          return realHub.attach(options);
        },
        notifyCommitted: (notification) => realHub.notifyCommitted(notification),
        close: () => realHub.close(),
      };
    },
  });
});

test('snapshot response is cursor-consistent and strictly role scoped', async () => {
  await withFixture(async ({ port }) => {
    await postOrder(port, CUSTOMER_A_TOKEN, orderBody(uuid(1_080)));

    const customer = await request({ port, path: '/v1/snapshot', headers: bearer(CUSTOMER_A_TOKEN) });
    assert.equal(customer.statusCode, 200);
    assert.equal(customer.json.audience, 'customer');
    assert.equal(customer.json.device.role, 'customer');
    assert.equal(customer.json.menu.audience, 'customer');
    assert.equal(customer.json.eventEpoch, customer.json.device.eventEpoch);
    assert.equal(customer.json.lastEventId, customer.json.menu.lastEventId);
    assert.equal(Object.hasOwn(customer.json, 'activeOrders'), false);
    assert.doesNotMatch(JSON.stringify(customer.json.menu), /priceYen|kitchenAlias/);

    const kitchen = await request({ port, path: '/v1/snapshot', headers: bearer(KITCHEN_TOKEN) });
    assert.equal(kitchen.statusCode, 200);
    assert.equal(kitchen.json.audience, 'kitchen');
    assert.equal(kitchen.json.activeOrders.length, 1);
    assert.equal(kitchen.json.menu.items[0].kitchenAlias, 'Edamame');
    assert.doesNotMatch(JSON.stringify(kitchen.json.menu), /priceYen/);
    assert.equal(kitchen.json.eventEpoch, kitchen.json.menu.eventEpoch);
    assert.equal(kitchen.json.lastEventId, kitchen.json.device.lastEventId);

    const admin = await request({ port, path: '/v1/snapshot', headers: bearer(ADMIN_TOKEN) });
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.json.audience, 'admin');
    assert.equal(admin.json.menu.items[0].priceYen, 380);
    assert.equal(admin.json.activeOrders.length, 1);
    assert.doesNotMatch(JSON.stringify(admin.json), /token_hash|tokenHash|requestFingerprint/);
  });
});

test('customer A receives only an id-only cursor for customer B while kitchen gets the safe event', async () => {
  await withFixture(async ({ port }) => {
    const customerStream = await openSse({ port, token: CUSTOMER_A_TOKEN });
    const kitchenStream = await openSse({ port, token: KITCHEN_TOKEN });

    const response = await postOrder(port, CUSTOMER_B_TOKEN, orderBody(uuid(1_090)));
    assert.equal(response.statusCode, 201);
    await waitForSse(customerStream, /id: 1\n: cursor/, 'customer hidden cursor');
    await waitForSse(kitchenStream, /id: 1\nevent: order\.created/, 'kitchen order event');

    assert.doesNotMatch(customerStream.text, /event: order\.created|data:|order-1/);
    assert.doesNotMatch(kitchenStream.text, /380|price|total|token|hash|formalName|kitchenAlias/i);
    customerStream.close();
    kitchenStream.close();
  });
});

test('real SSE disconnect cleans up and server close releases the port without closing DB ownership', async () => {
  await withFixture(async ({
    port,
    database,
    authenticator,
    hub,
    closeServer: stop,
  }) => {
    const stream = await openSse({ port, token: KITCHEN_TOKEN });
    assert.equal(hub.size, 1);
    stream.close();
    await waitFor(() => hub.size === 0, 'SSE disconnect cleanup');

    await stop();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 5);
    assert.equal(authenticator.authenticateDeviceToken(CUSTOMER_A_TOKEN).deviceId, CUSTOMER_A_ID);

    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
