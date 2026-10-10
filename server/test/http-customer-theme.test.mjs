import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { createCustomerThemeRepository } from '../src/customer-theme/customer-theme-repository.mjs';
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
const ADMIN_TOKEN = tokenFor(0x31);
const CUSTOMER_TOKEN = tokenFor(0x32);
const KITCHEN_TOKEN = tokenFor(0x33);

function seed(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'active', 1000, NULL, 1000, 1000)
  `);
  insertDevice.run(ADMIN_ID, 'admin', 'テスト管理端末', hash(ADMIN_TOKEN));
  insertDevice.run(CUSTOMER_ID, 'customer', 'テスト客席端末', hash(CUSTOMER_TOKEN));
  insertDevice.run(KITCHEN_ID, 'kitchen', 'テスト厨房端末', hash(KITCHEN_TOKEN));
  database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, version,
      created_at_ms, updated_at_ms
    ) VALUES (1, 'テーブル1', ?, 1, 1, 1000, 1000)
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

async function openSse({ port, token }) {
  let requestHandle;
  const response = await new Promise((resolve, reject) => {
    requestHandle = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/events',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      agent: false,
    }, resolve);
    requestHandle.on('error', reject);
    requestHandle.end();
  });
  response.setEncoding('utf8');
  let text = '';
  response.on('data', (chunk) => { text += chunk; });
  requestHandle.on('error', () => {});
  return {
    response,
    get text() { return text; },
    close() {
      requestHandle.destroy();
      response.destroy();
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-customer-theme-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'server.sqlite3') });
  let server;
  let authenticator;
  let catalog;
  let theme;
  let events;
  let orders;
  let snapshots;
  let hub;
  try {
    seed(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    theme = createCustomerThemeRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    snapshots = createSnapshotService({ catalog, eventRepository: events });
    hub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 500, maxConnectionMs: 5_000 });
    server = createHttpServer({
      database: connection.database,
      authenticator,
      catalog,
      customerTheme: theme,
      eventRepository: events,
      orderRepository: orders,
      snapshotService: snapshots,
      sseHub: hub,
      now: () => 1_800_000_001_000,
    });
    const port = await listen(server);
    await run({
      database: connection.database,
      port,
      authenticator,
      events,
      principals: {
        admin: authenticator.authenticateDeviceToken(ADMIN_TOKEN),
        customer: authenticator.authenticateDeviceToken(CUSTOMER_TOKEN),
        kitchen: authenticator.authenticateDeviceToken(KITCHEN_TOKEN),
      },
    });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    try { hub?.close(); } catch {}
    try { snapshots?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { events?.close(); } catch {}
    try { theme?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('customer theme API enforces roles, validates themes, and protects optimistic versions', async () => {
  await withFixture(async ({ port, database }) => {
    const unauthenticated = await request({ port, path: '/v1/customer/theme' });
    assert.equal(unauthenticated.statusCode, 401);

    const adminInitial = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/customer-theme' });
    assert.equal(adminInitial.statusCode, 200);
    assert.deepEqual(adminInitial.json, { theme: 'standard', version: 0, updatedAtMs: 0 });

    const customerInitial = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/theme' });
    assert.equal(customerInitial.statusCode, 200);
    assert.deepEqual(customerInitial.json, { theme: 'standard' });
    assert.equal(Object.hasOwn(customerInitial.json, 'version'), false);
    assert.equal(Object.hasOwn(customerInitial.json, 'updatedAtMs'), false);

    const customerWrite = await request({
      port,
      token: CUSTOMER_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 0, theme: 'camellia' },
    });
    assert.equal(customerWrite.statusCode, 403);

    const invalidTheme = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 0, theme: 'autumn' },
    });
    assert.equal(invalidTheme.statusCode, 400);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 0);

    const unknownSimpleField = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 0, theme: 'standard', extra: true },
    });
    assert.equal(unknownSimpleField.statusCode, 400);

    const saved = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 0, theme: 'camellia' },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json, {
      theme: 'camellia',
      version: 1,
      updatedAtMs: 1_800_000_001_000,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 0);

    const customerAfterSave = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/theme' });
    assert.deepEqual(customerAfterSave.json, { theme: 'camellia' });

    const staleWrite = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 0, theme: 'standard' },
    });
    assert.equal(staleWrite.statusCode, 409);
    assert.equal(staleWrite.json.error.code, 'CUSTOMER_THEME_CONFLICT');

    const protectedRows = database.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    const savedAgain = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme',
      body: { expectedVersion: 1, theme: 'standard' },
    });
    assert.equal(savedAgain.statusCode, 200);
    assert.equal(savedAgain.json.version, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, protectedRows);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('customer theme events reach customer SSE clients and remain hidden from kitchen clients', async () => {
  await withFixture(async ({ port, database, events, principals }) => {
    const customerStream = await openSse({ port, token: CUSTOMER_TOKEN });
    const kitchenStream = await openSse({ port, token: KITCHEN_TOKEN });
    try {
      assert.equal(customerStream.response.statusCode, 200);
      assert.equal(kitchenStream.response.statusCode, 200);
      const saved = await request({
        port,
        token: ADMIN_TOKEN,
        method: 'PUT',
        path: '/v1/admin/customer-theme',
        body: { expectedVersion: 0, theme: 'camellia' },
      });
      assert.equal(saved.statusCode, 200);
      await waitFor(() => /event: customer_theme\.updated/.test(customerStream.text), 'customer theme SSE event');
      const themeFrame = customerStream.text.split(/\r?\n\r?\n/).find((frame) => frame.includes('event: customer_theme.updated'));
      assert.ok(themeFrame);
      assert.doesNotMatch(themeFrame, /^id:/m);
      const themeData = themeFrame.split(/\r?\n/).find((line) => line.startsWith('data: '));
      const themeEvent = JSON.parse(themeData.slice(6));
      assert.deepEqual(Object.keys(themeEvent).sort(), ['aggregateId', 'audience', 'eventEpoch', 'occurredAtMs', 'payload', 'type'].sort());
      const { occurredAtMs, ...themeEventWithoutTimestamp } = themeEvent;
      assert.deepEqual(themeEventWithoutTimestamp, {
        audience: 'customer',
        eventEpoch: database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get().event_epoch,
        type: 'customer_theme.updated',
        aggregateId: 'customer-theme',
        payload: { resource: 'customerTheme', refreshRequired: true },
      });
      assert.ok(Number.isSafeInteger(occurredAtMs) && occurredAtMs >= 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.doesNotMatch(kitchenStream.text, /customer_theme\.updated|customerTheme/);

      const eventEpoch = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get().event_epoch;
      const customerReplay = events.replay({ principal: principals.customer, eventEpoch, afterEventId: 0 });
      const kitchenReplay = events.replay({ principal: principals.kitchen, eventEpoch, afterEventId: 0 });
      assert.deepEqual(customerReplay.events, []);
      assert.deepEqual(kitchenReplay.events, []);
    } finally {
      customerStream.close();
      kitchenStream.close();
    }
  });
});

test('customer theme config persists production metadata, exposes only safe placement to customers, and uses optimistic concurrency', async () => {
  await withFixture(async ({ port, database }) => {
    assert.equal((await request({ port, path: '/v1/admin/customer-theme-config' })).statusCode, 401);
    assert.equal((await request({ port, token: CUSTOMER_TOKEN, path: '/v1/admin/customer-theme-config' })).statusCode, 403);
    const adminInitial = await request({ port, token: ADMIN_TOKEN, path: '/v1/admin/customer-theme-config' });
    assert.equal(adminInitial.statusCode, 200);
    assert.equal(adminInitial.json.theme, 'standard');
    assert.equal(adminInitial.json.version, 0);
    assert.deepEqual(Object.keys(adminInitial.json.themes).sort(), ['autumn-leaves', 'camellia', 'japanese-halloween', 'moon-susuki', 'standard']);
    assert.match(adminInitial.json.themes.camellia.notes, /426×1587/);
    assert.match(adminInitial.json.themes.camellia.prompt, /文字.*ロゴ/);

    const customerInitial = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/theme-config' });
    assert.equal(customerInitial.statusCode, 200);
    assert.deepEqual(customerInitial.json, { theme: 'standard', positionX: 0.5, positionY: 0.5, zoom: 1 });
    assert.equal(Object.hasOwn(customerInitial.json, 'prompt'), false);
    assert.equal(Object.hasOwn(customerInitial.json, 'notes'), false);
    assert.equal(Object.hasOwn(customerInitial.json, 'version'), false);

    const draft = {
      ...Object.fromEntries(Object.entries(adminInitial.json.themes).map(([theme, variant]) => [theme, { ...variant }])),
    };
    draft.standard = { ...draft.standard, positionX: 0.25, positionY: 0.75, zoom: 1.1 };
    draft.camellia = { ...draft.camellia, prompt: '椿の背景。文字やロゴを画像に描かない。UIが重なる領域に重要な絵柄を置かない。', notes: '制作確認用メモ', positionX: 0.2, positionY: 0.8, zoom: 0.5 };
    draft['autumn-leaves'] = { ...draft['autumn-leaves'], positionX: 0.15, positionY: 0.65, zoom: 1.4 };
    const saved = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 0, theme: 'camellia', themes: draft },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json.theme, 'camellia');
    assert.equal(saved.json.version, 1);
    assert.equal(saved.json.themes.camellia.positionX, 0.2);
    assert.equal(saved.json.themes.camellia.zoom, 0.5);
    assert.equal(saved.json.themes.camellia.notes, '制作確認用メモ');
    assert.equal(saved.json.themes['autumn-leaves'].positionX, 0.15);
    assert.equal(database.prepare("SELECT theme_key FROM customer_theme_settings").get().theme_key, 'camellia');
    assert.equal(database.prepare("SELECT zoom FROM customer_theme_variants WHERE theme_key = 'autumn-leaves'").get().zoom, 1.4);

    const customerAfterSave = await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/theme-config' });
    assert.deepEqual(customerAfterSave.json, { theme: 'camellia', positionX: 0.2, positionY: 0.8, zoom: 0.5 });
    assert.equal(JSON.stringify(customerAfterSave.json).includes('制作確認用メモ'), false);

    const invalid = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 1, theme: 'camellia', themes: { ...draft, camellia: { ...draft.camellia, zoom: 4 } } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(database.prepare('SELECT version FROM customer_theme_settings').get().version, 1);

    const unknownNestedField = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: {
        expectedVersion: 1,
        theme: 'camellia',
        themes: {
          ...draft,
          camellia: { ...draft.camellia, unsupported: true },
        },
      },
    });
    assert.equal(unknownNestedField.statusCode, 400);

    const unknownTopLevelField = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 1, theme: 'camellia', themes: draft, unsupported: true },
    });
    assert.equal(unknownTopLevelField.statusCode, 400);

    const unknownTheme = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 1, theme: 'unregistered-theme', themes: draft },
    });
    assert.equal(unknownTheme.statusCode, 400);

    const stale = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 0, theme: 'standard', themes: draft },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json.error.code, 'CUSTOMER_THEME_CONFLICT');
    assert.equal(database.prepare('SELECT prompt_text FROM customer_theme_variants WHERE theme_key = \'camellia\'').get().prompt_text, draft.camellia.prompt);

    const seasonalTheme = await request({
      port,
      token: ADMIN_TOKEN,
      method: 'PUT',
      path: '/v1/admin/customer-theme-config',
      body: { expectedVersion: 1, theme: 'autumn-leaves', themes: draft },
    });
    assert.equal(seasonalTheme.statusCode, 200);
    assert.equal(seasonalTheme.json.theme, 'autumn-leaves');
    assert.equal((await request({ port, token: CUSTOMER_TOKEN, path: '/v1/customer/theme-config' })).json.theme, 'autumn-leaves');
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
});
