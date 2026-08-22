import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import { createOrderRepository } from '../src/orders/order-repository.mjs';
import { createPairingService } from '../src/pairing/pairing-service.mjs';
import { createRuntimeInfo } from '../src/runtime-info.mjs';

const uuid = (number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const ADMIN_ID = uuid(1);
const CUSTOMER_ID = uuid(2);
const ADMIN_TOKEN = tokenFor(0x31);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request({ port, path, method = 'GET', token = '', body = undefined, host = '192.0.2.44:25173' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: host,
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
      });
    });
    client.on('error', reject);
    client.end(payload);
  });
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-pairing-preflight-'));
  const safeDirectory = join(directory, 'server', 'var', 'safe-copies');
  await mkdir(safeDirectory, { recursive: true });
  const databasePath = join(safeDirectory, 'fixture.sqlite3');
  const connection = initializeDatabase({ databasePath });
  let server;
  let authenticator;
  let catalog;
  let events;
  let orders;
  let snapshots;
  let hub;
  const diagnostics = [];
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'admin', 'Admin', ?, 'active', 1, 1, 1)`).run(ADMIN_ID, hash(ADMIN_TOKEN));
    database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'customer', 'Existing A90', ?, 'active', 1, 1, 1)`).run(CUSTOMER_ID, hash(tokenFor(0x41)));
    database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms) VALUES (1, 'Table 1', ?, 1, 1, 1, 1)`).run(CUSTOMER_ID);
    database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms) VALUES (2, 'Table 2', NULL, 1, 1, 1, 1)`).run();
    authenticator = createDeviceAuthenticator({ database });
    catalog = createCatalogRepository({ database });
    events = createEventRepository({ database });
    orders = createOrderRepository({ database });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events });
    server = createHttpServer({
      database,
      authenticator,
      catalog,
      eventRepository: events,
      orderRepository: orders,
      snapshotService: snapshots,
      sseHub: hub,
      pairingService: createPairingService({ database }),
      pairingDiagnosticLogger: (entry) => diagnostics.push(entry),
      runtimeInfo: createRuntimeInfo({
        databasePath,
        repositoryRoot: directory,
        environment: 'safe-copy',
        apiPort: 28787,
        webPort: 25173,
        addresses: ['192.0.2.44'],
      }),
    });
    const port = await listen(server);
    await run({ port, database, diagnostics });
  } finally {
    await closeServer(server).catch(() => {});
    try { hub?.close(); } catch {}
    try { snapshots?.close?.(); } catch {}
    try { orders?.close?.(); } catch {}
    try { events?.close?.(); } catch {}
    try { catalog?.close?.(); } catch {}
    try { authenticator?.close?.(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('pairing preflight and issuance expose the actual safe-copy/runtime state', async () => {
  await withFixture(async ({ port, database }) => {
    const missingToken = await request({ port, path: '/v1/admin/pairing-preflight' });
    assert.equal(missingToken.statusCode, 401);
    assert.equal(missingToken.json.error.code, 'AUTHENTICATION_FAILED');

    const preflight = await request({ port, path: '/v1/admin/pairing-preflight', token: ADMIN_TOKEN });
    assert.equal(preflight.statusCode, 200);
    assert.equal(preflight.json.database.target, 'safe-copy');
    assert.equal(preflight.json.database.isProduction, false);
    assert.deepEqual(preflight.json.tables.available.map((table) => table.tableId), [2]);
    assert.deepEqual(preflight.json.tables.assigned.map((table) => table.tableId), [1]);
    assert.equal(preflight.json.pairing.canIssue, true);
    assert.equal(preflight.json.server.pairingUrlOrigin, 'http://192.0.2.44:25173');

    const beforeCodes = database.prepare('SELECT COUNT(*) AS count FROM pairing_codes').get().count;
    const occupied = await request({
      port,
      path: '/v1/admin/pairing-codes',
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { role: 'customer', tableId: 1, expiresAtMs: Date.now() + 600000 },
    });
    assert.equal(occupied.statusCode, 409);
    assert.equal(occupied.json.error.code, 'PAIRING_CONFLICT');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM pairing_codes').get().count, beforeCodes);

    const created = await request({
      port,
      path: '/v1/admin/pairing-codes',
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { role: 'customer', tableId: 2, expiresAtMs: Date.now() + 600000 },
    });
    assert.equal(created.statusCode, 201);
    assert.match(created.json.pairingUrl, /^http:\/\/192\.0\.2\.44:25173\/pairing\.html#p=/);
    assert.equal(created.json.role, 'customer');
    assert.equal(created.json.tableId, 2);
    assert.notEqual(database.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 1').get().assigned_customer_device_id, null);

    const protectedCountsBeforeRevoke = {
      orders: database.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    };
    const revoked = await request({
      port,
      path: '/v1/admin/devices/revoke',
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { deviceId: CUSTOMER_ID },
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json.deviceId, CUSTOMER_ID);
    assert.equal(revoked.json.status, 'revoked');
    assert.equal(database.prepare('SELECT status FROM devices WHERE device_id = ?').get(CUSTOMER_ID).status, 'revoked');
    assert.equal(database.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 1').get().assigned_customer_device_id, null);
    assert.deepEqual({
      orders: database.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    }, protectedCountsBeforeRevoke);
  });
});

test('claim returns 409 for active devices, reactivates revoked devices, and returns 410 for expired codes', async () => {
  await withFixture(async ({ port, database, diagnostics }) => {
    const protectedCountsBefore = {
      orders: database.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    };
    const issued = await request({
      port,
      path: '/v1/admin/pairing-codes',
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { role: 'customer', tableId: 2, expiresAtMs: Date.now() + 600000 },
    });
    assert.equal(issued.statusCode, 201);

    const activeConflict = await request({
      port,
      path: '/v1/pairings/claim',
      method: 'POST',
      body: { pairingCode: issued.json.code, deviceId: CUSTOMER_ID, displayName: 'A90 retry', appVersion: 'prototype' },
    });
    assert.equal(activeConflict.statusCode, 409);
    assert.equal(activeConflict.json.error.code, 'PAIRING_CONFLICT');
    assert.deepEqual({ ...diagnostics.at(-1), timestamp: undefined }, {
      status: 409,
      deviceIdHash: hash(CUSTOMER_ID).slice(0, 16),
      result: 'PAIRING_CONFLICT',
      timestamp: undefined,
    });
    assert.match(diagnostics.at(-1).timestamp, /^20\d\d-/);
    assert.equal(database.prepare('SELECT used_by_device_id FROM pairing_codes WHERE code_hash = ?').get(hash(issued.json.code)).used_by_device_id, null);

    const revoked = await request({
      port,
      path: '/v1/admin/devices/revoke',
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { deviceId: CUSTOMER_ID },
    });
    assert.equal(revoked.statusCode, 200);
    const reactivated = await request({
      port,
      path: '/v1/pairings/claim',
      method: 'POST',
      body: { pairingCode: issued.json.code, deviceId: CUSTOMER_ID, displayName: 'A90 reconnected', appVersion: 'prototype' },
    });
    assert.equal(reactivated.statusCode, 201);
    assert.equal(reactivated.json.config.tableId, 2);
    assert.deepEqual({ ...diagnostics.at(-1), timestamp: undefined }, {
      status: 201,
      deviceIdHash: hash(CUSTOMER_ID).slice(0, 16),
      result: 'claimed',
      timestamp: undefined,
    });
    assert.equal(database.prepare('SELECT status FROM devices WHERE device_id = ?').get(CUSTOMER_ID).status, 'active');
    assert.equal(database.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 2').get().assigned_customer_device_id, CUSTOMER_ID);

    const expiredCode = 'ABCD2345EFGH';
    database.prepare(`
      INSERT INTO pairing_codes (code_hash, role, table_id, expires_at_ms, created_by_device_id, created_at_ms)
      VALUES (?, 'customer', 1, ?, ?, ?)
    `).run(hash(expiredCode), Date.now() - 1, ADMIN_ID, Date.now() - 2);
    const expired = await request({
      port,
      path: '/v1/pairings/claim',
      method: 'POST',
      body: { pairingCode: expiredCode, deviceId: uuid(20), displayName: 'Expired A90', appVersion: 'prototype' },
    });
    assert.equal(expired.statusCode, 410);
    assert.equal(expired.json.error.code, 'PAIRING_EXPIRED');
    assert.deepEqual({ ...diagnostics.at(-1), timestamp: undefined }, {
      status: 410,
      deviceIdHash: hash(uuid(20)).slice(0, 16),
      result: 'PAIRING_EXPIRED',
      timestamp: undefined,
    });

    assert.deepEqual({
      orders: database.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    }, protectedCountsBefore);
  });
});
