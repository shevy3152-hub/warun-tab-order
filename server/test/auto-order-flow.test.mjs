import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bootstrapCustomerOrderClient } from '../../prototype/src/customer-bootstrap.js';
import { createCustomerOrderClient, createMemoryOutbox } from '../../prototype/src/order-outbox.js';
import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const token = (byte) => Buffer.alloc(32, byte).toString('base64url');
const tokenHash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const CUSTOMER_ID = uuid(1);
const KITCHEN_ID = uuid(2);
const ADMIN_ID = uuid(3);
const CUSTOMER_TOKEN = token(0x11);
const KITCHEN_TOKEN = token(0x21);
const ADMIN_TOKEN = token(0x31);

function seed(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, 'active', 1, 1, 1)
  `);
  insertDevice.run(CUSTOMER_ID, 'customer', 'Test customer', tokenHash(CUSTOMER_TOKEN));
  insertDevice.run(KITCHEN_ID, 'kitchen', 'Test kitchen', tokenHash(KITCHEN_TOKEN));
  insertDevice.run(ADMIN_ID, 'admin', 'Test admin', tokenHash(ADMIN_TOKEN));
  database.prepare(`
    INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms)
    VALUES (1, 'Table 1', ?, 1, 1, 1, 1)
  `).run(CUSTOMER_ID);
  database.prepare(`
    INSERT INTO categories (category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms)
    VALUES ('food', 'Food', 1, 1, 1, 1, 1)
  `).run();
  database.prepare(`
    INSERT INTO menu_items (menu_item_id, category_id, formal_name, kitchen_alias, description, price_yen, is_sold_out, is_active, sort_order, version, created_at_ms, updated_at_ms)
    VALUES ('edamame', 'food', 'Edamame', 'Edamame', 'Test menu', 380, 0, 1, 1, 1, 1, 1)
  `).run();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('automatic customer-to-kitchen-to-history flow uses one SQLite order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-auto-order-flow-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'flow.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let orders;
  let events;
  let snapshots;
  let hub;
  try {
    seed(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, idFactory: () => uuid(100), now: () => 1_800_000_000_000 });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 1000 });
    server = createHttpServer({ database: connection.database, authenticator, catalog, eventRepository: events, orderRepository: orders, snapshotService: snapshots, sseHub: hub });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    let fetchCalls = 0;
    const fetchImpl = (...args) => { fetchCalls += 1; return fetch(...args); };
    const createClient = (options) => createCustomerOrderClient({ ...options, store: createMemoryOutbox(), autoRetry: false });
    const credentialStore = { async load() { return { deviceId: CUSTOMER_ID, token: CUSTOMER_TOKEN }; } };
    const environment = { location: { origin }, navigator: { onLine: true }, fetch: fetchImpl };
    const client = await bootstrapCustomerOrderClient({ globalObject: environment, credentialStore, createClient });
    assert.equal(client.mode, 'api');
    const record = await client.enqueue({ items: [{ menuItemId: 'edamame', quantity: 1 }] });
    const first = await client.flush({ clientOrderId: record.clientOrderId });
    assert.equal(first.state, 'synced');
    assert.equal(first.idempotencyResult, 'created');
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count, 1);
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const replay = await fetch(`${origin}/v1/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CUSTOMER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(record.payload),
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Result'), 'replayed');
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count, 1);
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const kitchenSnapshot = await fetch(`${origin}/v1/snapshot`, { headers: { Authorization: `Bearer ${KITCHEN_TOKEN}` } }).then((response) => response.json());
    assert.equal(kitchenSnapshot.activeOrders.length, 1);
    const order = kitchenSnapshot.activeOrders[0];
    const serve = await fetch(`${origin}/v1/kitchen/order-items/serve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KITCHEN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: order.orderId, orderItemId: order.items[0].orderItemId }),
    });
    assert.equal(serve.status, 200);
    assert.equal(connection.database.prepare('SELECT status FROM orders').get().status, 'completed');
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 2);

    const history = await fetch(`${origin}/v1/admin/order-history`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }).then((response) => response.json());
    assert.equal(history.orders.length, 1);
    assert.equal(history.orders[0].status, 'completed');

    const reloaded = await bootstrapCustomerOrderClient({ globalObject: environment, credentialStore, createClient });
    assert.equal(reloaded.mode, 'api');
    await reloaded.start();
    assert.equal(fetchCalls, 1);
  } finally {
    await close(server).catch(() => {});
    hub?.close();
    events?.close();
    orders?.close();
    catalog?.close();
    authenticator?.close();
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
