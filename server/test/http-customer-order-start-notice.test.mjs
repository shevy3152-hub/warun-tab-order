import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { createCustomerOrderNoticeRepository } from '../src/customer-order-notice-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ADMIN_ID = uuid(1);
const CUSTOMER_ID = uuid(2);
const KITCHEN_ID = uuid(3);
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const ADMIN_TOKEN = tokenFor(0x51);
const CUSTOMER_TOKEN = tokenFor(0x52);
const KITCHEN_TOKEN = tokenFor(0x53);

function seed(database) {
  const insert = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'active', 1000, NULL, 1000, 1000)
  `);
  insert.run(ADMIN_ID, 'admin', '架空の管理端末', hash(ADMIN_TOKEN));
  insert.run(CUSTOMER_ID, 'customer', '架空の客席端末', hash(CUSTOMER_TOKEN));
  insert.run(KITCHEN_ID, 'kitchen', '架空の厨房端末', hash(KITCHEN_TOKEN));
  database.prepare(`
    INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms)
    VALUES (1, 'QAテーブル', ?, 1, 1, 1000, 1000)
  `).run(CUSTOMER_ID);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function request({ port, token, method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, json: raw ? JSON.parse(raw) : null });
      });
    });
    client.on('error', reject);
    client.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-customer-order-notice-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'qa.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let settings;
  let events;
  let orders;
  let snapshots;
  let hub;
  const transientNotifications = [];
  try {
    seed(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    settings = createCustomerOrderNoticeRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 500, maxConnectionMs: 5_000 });
    const observedHub = {
      ...hub,
      notifyTransient(notification) {
        transientNotifications.push(notification);
        return hub.notifyTransient(notification);
      },
    };
    server = createHttpServer({
      database: connection.database, authenticator, catalog, customerOrderNotice: settings,
      eventRepository: events, orderRepository: orders, snapshotService: snapshots, sseHub: observedHub,
      now: () => 1_800_000_001_000,
    });
    const port = await listen(server);
    await run({ port, database: connection.database, events, transientNotifications });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    try { hub?.close(); } catch {}
    try { snapshots?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { events?.close(); } catch {}
    try { settings?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('customer notice API shares plain text and exposes versions only to admins', async () => {
  await withFixture(async ({ port }) => {
    const noAuth = await request({ port, path: '/v1/customer/order-start-notice' });
    assert.equal(noAuth.statusCode, 401);
    const guest = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/order-start-notice' });
    assert.equal(guest.statusCode, 200);
    assert.deepEqual(guest.json, {
      heading: 'ご注文の前にご確認ください',
      body: '20歳未満の入店禁止\n飲酒運転しません・させません\nSNS投稿・LIVE配信禁止\nお支払いは現金のみ',
    });
    assert.equal(Object.hasOwn(guest.json, 'version'), false);
    const admin = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/customer-order-start-notice' });
    assert.equal(admin.statusCode, 200);
    assert.deepEqual(admin.json, { ...guest.json, version: 0, updatedAtMs: 0 });
    assert.equal((await request({ port, token: KITCHEN_TOKEN, path: '/v1/customer/order-start-notice' })).statusCode, 403);
    assert.equal((await request({ port, token: CUSTOMER_TOKEN, path: '/v1/admin/customer-order-start-notice' })).statusCode, 403);
  });
});

test('admin updates shared notice atomically and stale versions are rejected', async () => {
  await withFixture(async ({ port, database, transientNotifications }) => {
    const beforeEventCount = database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count;
    const body = '店内ルール\n2行目はプレーンテキスト';
    const saved = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/customer-order-start-notice',
      body: { expectedVersion: 0, heading: 'ご利用前に確認', body },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(transientNotifications, [{
      eventEpoch: database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get().event_epoch,
      type: 'customer_order_start_notice.updated',
      aggregateId: 'customer-order-notice',
      occurredAtMs: 1_800_000_001_000,
      payload: { resource: 'customerOrderStartNotice', refreshRequired: true },
    }]);
    assert.deepEqual(saved.json, { heading: 'ご利用前に確認', body, version: 1, updatedAtMs: 1_800_000_001_000 });
    const guest = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/order-start-notice' });
    assert.deepEqual(guest.json, { heading: saved.json.heading, body });
    const stale = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/customer-order-start-notice',
      body: { expectedVersion: 0, heading: '古い版', body: '上書きしない' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json.error.code, 'CUSTOMER_ORDER_NOTICE_CONFLICT');
    const current = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/customer-order-start-notice' });
    assert.equal(current.json.heading, saved.json.heading);
    assert.equal(current.json.body, body);
    assert.equal(current.json.version, 1);
    const invalid = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/customer-order-start-notice',
      body: { expectedVersion: 1, heading: '   ', body },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, beforeEventCount);
  });
});
