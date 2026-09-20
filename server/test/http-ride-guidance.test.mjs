import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { createBusinessHoursRepository } from '../src/business-hours/business-hours-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';
import { createRideGuidanceRepository } from '../src/ride-guidance/ride-guidance-repository.mjs';

const ADMIN_ID = '00000000-0000-4000-8000-000000009101';
const ADMIN_TOKEN = Buffer.alloc(32, 0x41).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function seedAdmin(database) {
  database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, 'admin', '隔離テスト管理端末', ?, 'active', 1000, 1000, 1000)
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
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(serializedBody === undefined ? {} : { 'Content-Length': Buffer.byteLength(serializedBody) }),
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
    client.end(serializedBody);
  });
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-ride-guidance-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'server.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let businessHours;
  let rideGuidance;
  let events;
  let orders;
  let snapshots;
  let hub;
  try {
    seedAdmin(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    businessHours = createBusinessHoursRepository({ database: connection.database, now: () => 1_900_000_000_000 });
    rideGuidance = createRideGuidanceRepository({ database: connection.database, now: () => 1_900_000_000_000, idFactory: (() => { let n = 0; return () => `ride-${++n}`; })() });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, now: () => 1_900_000_000_000 });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 500, maxConnectionMs: 5_000 });
    server = createHttpServer({
      database: connection.database,
      authenticator,
      catalog,
      businessHours,
      rideGuidance,
      eventRepository: events,
      orderRepository: orders,
      snapshotService: snapshots,
      sseHub: hub,
      now: () => 1_900_000_000_000,
    });
    const port = await listen(server);
    await run({ connection, database: connection.database, port });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    try { hub?.close(); } catch {}
    try { snapshots?.close(); } catch {}
    try { events?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { rideGuidance?.close(); } catch {}
    try { businessHours?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('ride-guidance API is isolated, validated, transactional, and admin protected', async () => {
  await withFixture(async ({ database, port }) => {
    const protectedBefore = Object.fromEntries(
      ['orders', 'order_items', 'table_sessions', 'menu_items', 'categories', 'business_hours', 'event_log']
        .map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
    );
    const hoursBefore = database.prepare('SELECT * FROM business_hours WHERE singleton_id = 1').get();

    const publicInitial = await request({ port, path: '/v1/ride-guidance' });
    assert.equal(publicInitial.statusCode, 200);
    assert.deepEqual(publicInitial.json, { pickup: { pickupLabel: '', pickupAddress: '' }, contacts: [] });
    const adminInitial = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/ride-guidance' });
    assert.equal(adminInitial.statusCode, 200);
    assert.equal(adminInitial.json.pickup.version, 0);
    assert.deepEqual(adminInitial.json.contacts, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 0);

    const pickup = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/ride-guidance/pickup',
      body: { expectedVersion: 0, pickupLabel: '  駅前ロータリー  ', pickupAddress: '  岐阜県岐阜市架空町1-2-3  ' },
    });
    assert.equal(pickup.statusCode, 200);
    assert.deepEqual(pickup.json.pickup, { pickupLabel: '駅前ロータリー', pickupAddress: '岐阜県岐阜市架空町1-2-3', version: 1, updatedAtMs: 1_900_000_000_000 });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const taxi = await request({
      port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/admin/ride-guidance/contacts',
      body: { type: 'taxi', name: '  架空タクシー  ', phone: '  012-345-6789  ', note: '<b>深夜</b>', isVisible: true },
    });
    assert.equal(taxi.statusCode, 400);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);

    const taxi1 = await request({
      port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/admin/ride-guidance/contacts',
      body: { type: 'taxi', name: '架空タクシーA', phone: '012-345-6789', note: '24時間', isVisible: true },
    });
    const taxi2 = await request({
      port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/admin/ride-guidance/contacts',
      body: { type: 'taxi', name: '架空タクシーB', phone: '+81 (0)12 345 6789', note: '', isVisible: false },
    });
    const driver = await request({
      port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/admin/ride-guidance/contacts',
      body: { type: 'driver_service', name: '架空運転代行', phone: '090-1111-2222', note: '要予約', isVisible: true },
    });
    assert.equal(taxi1.statusCode, 201);
    assert.equal(taxi2.statusCode, 201);
    assert.equal(driver.statusCode, 201);
    assert.equal(taxi1.json.contact.id, 'ride-1');
    assert.equal(taxi2.json.contact.sortOrder, 1);
    assert.equal(driver.json.contact.sortOrder, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 4);

    const publicAfterCreate = await request({ port, path: '/v1/ride-guidance' });
    assert.equal(publicAfterCreate.statusCode, 200);
    assert.deepEqual(publicAfterCreate.json.contacts.map(({ id, type, name, phone, note, sortOrder, ...rest }) => ({ id, type, name, phone, note, sortOrder, rest })), [
      { id: 'ride-1', type: 'taxi', name: '架空タクシーA', phone: '012-345-6789', note: '24時間', sortOrder: 0, rest: {} },
      { id: 'ride-3', type: 'driver_service', name: '架空運転代行', phone: '090-1111-2222', note: '要予約', sortOrder: 0, rest: {} },
    ]);

    const updated = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: `/v1/admin/ride-guidance/contacts/${taxi1.json.contact.id}`,
      body: { expectedVersion: 1, type: 'taxi', name: '架空タクシーA改', phone: '03-1234-5678', note: '更新', isVisible: false },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json.contact.version, 2);
    const conflict = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: `/v1/admin/ride-guidance/contacts/${taxi1.json.contact.id}`,
      body: { expectedVersion: 1, type: 'taxi', name: '競合', phone: '03-0000-0000', note: '', isVisible: true },
    });
    assert.equal(conflict.statusCode, 409);

    const reorder = await request({
      port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/ride-guidance/contacts/order',
      body: { type: 'taxi', contactIds: [taxi2.json.contact.id, taxi1.json.contact.id] },
    });
    assert.equal(reorder.statusCode, 200);
    assert.deepEqual(reorder.json.contacts.map((contact) => contact.id), [taxi2.json.contact.id, taxi1.json.contact.id]);
    assert.deepEqual(database.prepare('SELECT id, sort_order FROM ride_service_contacts WHERE type = ? ORDER BY sort_order').all('taxi').map((row) => ({ ...row })), [
      { id: taxi2.json.contact.id, sort_order: 0 },
      { id: taxi1.json.contact.id, sort_order: 1 },
    ]);

    const deleted = await request({
      port, token: ADMIN_TOKEN, method: 'DELETE', path: `/v1/admin/ride-guidance/contacts/${taxi2.json.contact.id}`,
      body: { expectedVersion: 2 },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json.id, taxi2.json.contact.id);

    for (const body of [
      { expectedVersion: 1, pickupLabel: 'a'.repeat(101), pickupAddress: '' },
      { expectedVersion: 1, pickupLabel: '', pickupAddress: '<p>HTML</p>' },
    ]) {
      const invalid = await request({ port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/ride-guidance/pickup', body });
      assert.equal(invalid.statusCode, 400);
    }
    for (const body of [
      { type: 'other', name: 'x', phone: '0123', isVisible: true },
      { type: 'taxi', name: 'x', phone: 'abc', isVisible: true },
      { type: 'taxi', name: 'x', phone: '0123', isVisible: true, note: 'n'.repeat(201) },
    ]) {
      const invalid = await request({ port, token: ADMIN_TOKEN, method: 'POST', path: '/v1/admin/ride-guidance/contacts', body });
      assert.equal(invalid.statusCode, 400);
    }
    const unauthenticated = await request({ port, method: 'POST', path: '/v1/admin/ride-guidance/contacts', body: { type: 'taxi', name: 'x', phone: '0123', isVisible: true } });
    assert.equal(unauthenticated.statusCode, 401);
    const pickupConflict = await request({ port, token: ADMIN_TOKEN, method: 'PUT', path: '/v1/admin/ride-guidance/pickup', body: { expectedVersion: 0, pickupLabel: '', pickupAddress: '' } });
    assert.equal(pickupConflict.statusCode, 409);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 7);

    const protectedAfter = Object.fromEntries(
      ['orders', 'order_items', 'table_sessions', 'menu_items', 'categories', 'business_hours'].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
    );
    assert.deepEqual(protectedAfter, Object.fromEntries(Object.entries(protectedBefore).filter(([table]) => table !== 'event_log')));
    assert.deepEqual(database.prepare('SELECT * FROM business_hours WHERE singleton_id = 1').get(), hoursBefore);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});
