import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createRegistrationService } from '../src/registration/registration-service.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ADMIN_ID = uuid(700);
const ADMIN_TOKEN = tokenFor(0x70);
const DEVICE_ID = uuid(701);
const REQUEST_SECRET = tokenFor(0x71);

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

async function removeDirectoryWithRetry(directory) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
}

async function request({ port, path, method = 'GET', headers = {}, body } = {}) {
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
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          rawBody,
          json: rawBody ? JSON.parse(rawBody) : null,
        });
      });
    });
    client.on('error', reject);
    client.end(body);
  });
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-registration-http-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'registration.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  try {
    const database = connection.database;
    database.prepare(`
      INSERT INTO devices (
        device_id, role, display_name, token_hash, status,
        paired_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'admin', 'Test admin', ?, 'active', 1, 1, 1)
    `).run(ADMIN_ID, tokenHash(ADMIN_TOKEN));
    database.prepare(`
      INSERT INTO tables (table_id, label, is_active, version, created_at_ms, updated_at_ms)
      VALUES (3, 'Table 3', 1, 1, 1, 1)
    `).run();
    authenticator = createDeviceAuthenticator({ database });
    catalog = createCatalogRepository({ database });
    const registrations = createRegistrationService({ database, now: () => 2_000 });
    const eventRepository = {
      replay() { return { eventEpoch: uuid(702), lastEventId: 0, hasMore: false, events: [] }; },
      readCommittedForPrincipal() { return []; },
      getCurrentCursor() { return { eventEpoch: uuid(702), lastEventId: 0 }; },
    };
    const sseHub = { attach() { throw new Error('SSE is not part of this focused test.'); }, notifyCommitted() {}, close() {} };
    server = createHttpServer({
      database,
      authenticator,
      catalog,
      registrationService: registrations,
      orderRepository: { createOrder() {}, getHistory() {}, markItemServed() {} },
      eventRepository,
      snapshotService: { getSnapshot() {} },
      sseHub,
      now: () => 2_000,
    });
    const port = await listen(server);
    await run({ port, database });
  } finally {
    await closeServer(server).catch(() => {});
    catalog?.close();
    authenticator?.close();
    connection.close();
    await removeDirectoryWithRetry(directory);
  }
}

test('registration HTTP flow requires explicit admin approval and returns a token only on claim', async () => {
  await withFixture(async ({ port, database }) => {
    const createResponse = await request({
      port,
      path: '/v1/registration-requests',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        requestSecret: REQUEST_SECRET,
        deviceId: DEVICE_ID,
        displayName: 'A90 test tablet',
        appVersion: 'test',
        role: 'customer',
      }),
    });
    assert.equal(createResponse.statusCode, 201);
    assert.equal(createResponse.json.status, 'pending');
    assert.doesNotMatch(createResponse.rawBody, new RegExp(REQUEST_SECRET));

    const pendingOrder = await request({
      port,
      path: '/v1/orders',
      method: 'POST',
      headers: { ...JSON_HEADERS, ...bearer(tokenFor(0x72)) },
      body: JSON.stringify({
        schemaVersion: 1,
        clientOrderId: uuid(703),
        items: [{ menuItemId: 'unused', quantity: 1 }],
      }),
    });
    assert.equal(pendingOrder.statusCode, 401);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices WHERE device_id = ?').get(DEVICE_ID).count, 0);

    const list = await request({
      port,
      path: '/v1/admin/registration-requests',
      headers: bearer(ADMIN_TOKEN),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json.requests.length, 1);
    assert.doesNotMatch(list.rawBody, new RegExp(REQUEST_SECRET));

    const beforeApproval = await request({
      port,
      path: '/v1/registration-requests/claim',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId: createResponse.json.requestId, requestSecret: REQUEST_SECRET }),
    });
    assert.equal(beforeApproval.statusCode, 409);
    assert.equal(beforeApproval.json.error.code, 'REGISTRATION_CONFLICT');
    assert.doesNotMatch(beforeApproval.rawBody, new RegExp(REQUEST_SECRET));

    const approved = await request({
      port,
      path: '/v1/admin/registration-requests/approve',
      method: 'POST',
      headers: { ...JSON_HEADERS, ...bearer(ADMIN_TOKEN) },
      body: JSON.stringify({ requestId: createResponse.json.requestId, tableId: 3 }),
    });
    assert.equal(approved.statusCode, 200, approved.json?.error?.code || 'approval failed');
    assert.equal(approved.json.status, 'approved');
    assert.equal(approved.json.tableId, 3);

    const secondApproval = await request({
      port,
      path: '/v1/admin/registration-requests/approve',
      method: 'POST',
      headers: { ...JSON_HEADERS, ...bearer(ADMIN_TOKEN) },
      body: JSON.stringify({ requestId: createResponse.json.requestId, tableId: 3 }),
    });
    assert.equal(secondApproval.statusCode, 409);

    const claimed = await request({
      port,
      path: '/v1/registration-requests/claim',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId: createResponse.json.requestId, requestSecret: REQUEST_SECRET }),
    });
    assert.equal(claimed.statusCode, 201);
    assert.equal(typeof claimed.json.deviceToken, 'string');
    assert.equal(claimed.json.config.tableId, 3);
    assert.doesNotMatch(claimed.rawBody, new RegExp(REQUEST_SECRET));

    const claimedAgain = await request({
      port,
      path: '/v1/registration-requests/claim',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId: createResponse.json.requestId, requestSecret: REQUEST_SECRET }),
    });
    assert.equal(claimedAgain.statusCode, 409);
    assert.doesNotMatch(claimedAgain.rawBody, new RegExp(claimed.json.deviceToken));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices WHERE device_id = ?').get(DEVICE_ID).count, 1);
    assert.equal(database.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 3').get().assigned_customer_device_id, DEVICE_ID);
    assert.equal(database.prepare("SELECT status FROM registration_requests WHERE request_id = ?").get(createResponse.json.requestId).status, 'claimed');
  });
});

test('registration HTTP endpoints enforce admin authorization', async () => {
  await withFixture(async ({ port }) => {
    const unauthenticated = await request({ port, path: '/v1/admin/registration-requests' });
    assert.equal(unauthenticated.statusCode, 401);
    const approval = await request({
      port,
      path: '/v1/admin/registration-requests/approve',
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ requestId: uuid(704), tableId: 3 }),
    });
    assert.equal(approval.statusCode, 401);
  });
});
