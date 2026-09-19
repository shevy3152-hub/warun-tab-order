import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createBusinessHoursRepository } from '../src/business-hours/business-hours-repository.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const ADMIN_ID = '00000000-0000-4000-8000-000000009001';
const ADMIN_TOKEN = Buffer.alloc(32, 0x31).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function seedAdmin(database) {
  database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, 'admin', 'テスト管理端末', ?, 'active', 1000, 1000, 1000)
  `).run(ADMIN_ID, hash(ADMIN_TOKEN));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function request({ port, token, body, method = 'GET', path }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
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
  const directory = await mkdtemp(join(tmpdir(), 'warun-business-hours-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'server.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let businessHours;
  let events;
  let orders;
  let snapshots;
  let hub;
  try {
    seedAdmin(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    businessHours = createBusinessHoursRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 500, maxConnectionMs: 5_000 });
    server = createHttpServer({
      database: connection.database,
      authenticator,
      catalog,
      businessHours,
      eventRepository: events,
      orderRepository: orders,
      snapshotService: snapshots,
      sseHub: hub,
      now: () => 1_800_000_001_000,
    });
    const port = await listen(server);
    await run({ connection, database: connection.database, port });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    try { hub?.close(); } catch {}
    try { snapshots?.close(); } catch {}
    try { events?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { businessHours?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('business-hours public/admin API validates versions, boundaries, and atomic events', async () => {
  await withFixture(async ({ database, port }) => {
    const publicInitial = await request({ port, path: '/v1/business-hours' });
    assert.equal(publicInitial.statusCode, 200);
    assert.deepEqual(publicInitial.json, {
      openTime: '17:00',
      closeTime: '24:00',
      lastOrderTime: '23:30',
      isVisible: true,
      displayText: '17:00－24:00（ラストオーダー23:30）',
    });

    const adminInitial = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/business-hours' });
    assert.equal(adminInitial.statusCode, 200);
    assert.equal(adminInitial.json.version, 1);
    assert.equal(adminInitial.json.updatedAtMs, 0);

    const protectedBefore = Object.fromEntries(
      ['orders', 'order_items', 'table_sessions', 'menu_items', 'event_log']
        .map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
    );
    const saved = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/business-hours',
      body: { expectedVersion: 1, openTime: '17:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: false },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json.version, 2);
    assert.equal(saved.json.isVisible, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const conflict = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/business-hours',
      body: { expectedVersion: 1, openTime: '17:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: true },
    });
    assert.equal(conflict.statusCode, 409);
    for (const body of [
      { expectedVersion: 2, openTime: '9:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: true },
      { expectedVersion: 2, openTime: '17:00', closeTime: '30:00', lastOrderTime: '23:30', isVisible: true },
      { expectedVersion: 2, openTime: '20:00', closeTime: '24:00', lastOrderTime: '19:00', isVisible: true },
      { openTime: '17:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: true },
    ]) {
      const invalid = await request({ port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/business-hours', body });
      assert.equal(invalid.statusCode, 400);
    }
    const unauthenticatedGet = await request({ port, path: '/v1/admin/business-hours' });
    assert.equal(unauthenticatedGet.statusCode, 401);
    const unauthorized = await request({
      port,
      method: 'PUT',
      path: '/v1/admin/business-hours',
      body: { expectedVersion: 2, openTime: '17:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: true },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const boundary = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/business-hours',
      body: { expectedVersion: 2, openTime: '23:00', closeTime: '29:59', lastOrderTime: '29:59', isVisible: true },
    });
    assert.equal(boundary.statusCode, 200);
    assert.equal(boundary.json.closeTime, '29:59');
    assert.equal(boundary.json.lastOrderTime, '29:59');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 2);

    const protectedAfter = Object.fromEntries(
      ['orders', 'order_items', 'table_sessions', 'menu_items'].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
    );
    assert.deepEqual(protectedAfter, Object.fromEntries(Object.entries(protectedBefore).filter(([table]) => table !== 'event_log')));
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('missing business-hours row keeps the legacy public display fallback', async () => {
  await withFixture(async ({ database, port }) => {
    database.prepare('DELETE FROM business_hours WHERE singleton_id = 1').run();
    const publicResponse = await request({ port, path: '/v1/business-hours' });
    assert.equal(publicResponse.statusCode, 200);
    assert.equal(publicResponse.json.displayText, '17:00－24:00（ラストオーダー23:30）');
    const adminResponse = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/business-hours' });
    assert.equal(adminResponse.statusCode, 200);
    assert.equal(adminResponse.json.version, 0);
  });
});
