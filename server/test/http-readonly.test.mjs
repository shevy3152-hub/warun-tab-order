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
import {
  createReadOnlyHttpServer,
  parseBearerAuthorization,
} from '../src/http/http-server.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const digestFor = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CUSTOMER_ID = uuid(901);
const KITCHEN_ID = uuid(902);
const ADMIN_ID = uuid(903);
const REVOKED_ID = uuid(904);
const UNASSIGNED_ID = uuid(905);
const INCONSISTENT_ID = uuid(906);
const CUSTOMER_TOKEN = tokenFor(0x11);
const KITCHEN_TOKEN = tokenFor(0x22);
const ADMIN_TOKEN = tokenFor(0x33);
const REVOKED_TOKEN = tokenFor(0x44);
const UNASSIGNED_TOKEN = tokenFor(0x55);
const INCONSISTENT_TOKEN = tokenFor(0x66);
const UNKNOWN_TOKEN = tokenFor(0x77);

function seedFixture(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status, paired_at_ms,
      last_seen_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, 1500, ?, 1000, 2000)
  `);
  insertDevice.run(CUSTOMER_ID, 'customer', 'Customer tablet', digestFor(CUSTOMER_TOKEN), 'active', null);
  insertDevice.run(KITCHEN_ID, 'kitchen', 'Kitchen tablet', digestFor(KITCHEN_TOKEN), 'active', null);
  insertDevice.run(ADMIN_ID, 'admin', 'Admin tablet', digestFor(ADMIN_TOKEN), 'active', null);
  insertDevice.run(REVOKED_ID, 'customer', 'Revoked tablet', digestFor(REVOKED_TOKEN), 'revoked', 2000);
  insertDevice.run(UNASSIGNED_ID, 'customer', 'Unassigned tablet', digestFor(UNASSIGNED_TOKEN), 'active', null);
  insertDevice.run(INCONSISTENT_ID, 'customer', 'Inactive-table tablet', digestFor(INCONSISTENT_TOKEN), 'active', null);

  const insertTable = database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, version,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 1, 1000, ?)
  `);
  insertTable.run(1, 'Table 1', CUSTOMER_ID, 1, 3001);
  insertTable.run(2, 'Inactive table', INCONSISTENT_ID, 0, 3002);

  const insertCategory = database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?)
  `);
  insertCategory.run('hidden', 'Hidden', 0, 0, 2, 4000);
  insertCategory.run('recommended', 'Recommended', 1, 1, 3, 4001);
  insertCategory.run('drinks', 'Drinks', 2, 1, 4, 4002);

  const insertItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description,
      price_yen, is_sold_out, is_active, sort_order, image_uri, version,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?)
  `);
  insertItem.run('secret', 'hidden', 'Secret item', 'Secret', 'Hidden item', 999, 0, 1, 1, null, 2, 5000);
  insertItem.run('food', 'recommended', 'Formal food', 'Food', 'A description', 580, 0, 1, 1, '/food.webp', 3, 5001);
  insertItem.run('sold-out', 'recommended', 'Sold out food', 'Sold', 'Sold out', 480, 1, 1, 2, null, 4, 5002);
  insertItem.run('inactive', 'recommended', 'Inactive food', 'Inactive', 'Inactive', 420, 0, 0, 3, null, 5, 5003);
  insertItem.run('beer', 'drinks', 'Formal beer', 'Beer', 'Cold beer', 680, 0, 1, 1, null, 6, 5004);

  const { event_epoch: eventEpoch } = database
    .prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1')
    .get();
  database.prepare(`
    INSERT INTO event_log (
      event_epoch, event_type, aggregate_type, aggregate_id,
      actor_device_id, payload_json, created_at_ms
    ) VALUES (?, 'menu.updated', 'menu_item', 'food', ?, '{}', 6000)
  `).run(eventEpoch, ADMIN_ID);
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
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withFixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-http-test-'));
  const databasePath = join(directory, 'http.sqlite3');
  const connection = initializeDatabase({ databasePath });
  let server;
  let authenticator;
  let catalog;
  try {
    seedFixture(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    const serverAuthenticator = options.wrapAuthenticator?.(authenticator) ?? authenticator;
    const serverCatalog = options.wrapCatalog?.(catalog) ?? catalog;
    server = createReadOnlyHttpServer({
      database: connection.database,
      authenticator: serverAuthenticator,
      catalog: serverCatalog,
      readServiceState: options.readServiceState,
      requestIdFactory: options.requestIdFactory,
      now: options.now,
    });
    const port = await listen(server);
    await run({
      connection,
      database: connection.database,
      databasePath,
      authenticator,
      catalog,
      server,
      port,
      closeServer: () => closeServer(server),
    });
  } finally {
    if (server) await closeServer(server).catch(() => {});
    catalog?.close();
    authenticator?.close();
    try {
      connection.close();
    } catch {
      // Some failure-path tests intentionally close the supplied database first.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function authHeaders(token, scheme = 'Bearer') {
  return { Authorization: `${scheme} ${token}` };
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

function assertJsonHeaders(response) {
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['x-request-id'], UUID_PATTERN);
}

function assertError(response, statusCode, code, message) {
  assert.equal(response.statusCode, statusCode);
  assertJsonHeaders(response);
  assert.deepEqual(Object.keys(response.json).sort(), ['error', 'requestId']);
  assert.deepEqual(response.json.error, { code, message });
  assert.match(response.json.requestId, UUID_PATTERN);
  assert.equal(response.headers['x-request-id'], response.json.requestId);
}

function assertNoKeys(value, forbidden) {
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoKeys(entry, forbidden));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `forbidden response key: ${key}`);
      assertNoKeys(nested, forbidden);
    }
  }
}

function assertExactKeys(value, required, optional = []) {
  const actual = Object.keys(value).sort();
  for (const key of required) assert.equal(Object.hasOwn(value, key), true, `missing ${key}`);
  assert.equal(actual.every((key) => required.includes(key) || optional.includes(key)), true);
}

function snapshotDatabase(database) {
  const tables = [
    ['system_state', 'singleton_id'],
    ['devices', 'device_id'],
    ['tables', 'table_id'],
    ['pairing_codes', 'code_hash'],
    ['categories', 'category_id'],
    ['menu_items', 'menu_item_id'],
    ['orders', 'order_id'],
    ['order_items', 'order_item_id'],
    ['staff_calls', 'staff_call_id'],
    ['event_log', 'event_id'],
  ];
  return Object.fromEntries(tables.map(([table, order]) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
  ]));
}

test('01 health is public and returns 200', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.status, 'ready');
    assert.equal(response.json.db, 'ready');
    assert.equal(response.json.schemaVersion, 1);
  }, { now: () => 1_786_300_000_000 });
});

test('02 health uses the JSON response content type', async () => {
  await withFixture(async ({ port }) => assertJsonHeaders(await request({ port, path: '/v1/health' })));
});

test('03 health exposes no secret or internal environment information', async () => {
  await withFixture(async ({ port, databasePath }) => {
    const response = await request({ port, path: '/v1/health' });
    const serialized = JSON.stringify(response.json);
    assertNoKeys(response.json, /token|hash|pairing|path|sql|stack|cause/i);
    assert.equal(serialized.includes(databasePath), false);
    assert.equal(serialized.includes(CUSTOMER_TOKEN), false);
    assert.deepEqual(Object.keys(response.json).sort(), ['db', 'eventEpoch', 'schemaVersion', 'serverTimeMs', 'status']);
  });
});

test('04 health reports database readiness failure as a safe 503', async () => {
  await withFixture(async ({ connection, port }) => {
    connection.close();
    const response = await request({ port, path: '/v1/health' });
    assertError(response, 503, 'SERVICE_UNAVAILABLE', 'Service unavailable.');
  });
});

test('05 a valid Bearer token authenticates successfully', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/device/config', headers: authHeaders(CUSTOMER_TOKEN) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.deviceId, CUSTOMER_ID);
  });
});

test('06 Bearer scheme matching is case-insensitive', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN, 'bEaReR') });
    assert.equal(response.statusCode, 200);
  });
});

test('07 token comparison remains case-sensitive', async () => {
  const changed = `${CUSTOMER_TOKEN[0].toLowerCase()}${CUSTOMER_TOKEN.slice(1)}`;
  assert.notEqual(changed, CUSTOMER_TOKEN);
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: authHeaders(changed) }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('08 a missing Authorization header is rejected', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu' }), 401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('09 an empty Bearer credential is rejected', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: { Authorization: 'Bearer' } }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('10 Basic authentication is rejected', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: { Authorization: 'Basic abc' } }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('11 malformed authorization schemes are rejected', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: { Authorization: `Bearerr ${CUSTOMER_TOKEN}` } }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('12 duplicate Authorization header lines are rejected using raw headers', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({
      port,
      path: '/v1/menu',
      headers: [
        'Host', `127.0.0.1:${port}`,
        'Authorization', `Bearer ${CUSTOMER_TOKEN}`,
        'authorization', `Bearer ${CUSTOMER_TOKEN}`,
      ],
    }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('13 comma-combined Authorization values are rejected', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: { Authorization: `Bearer ${CUSTOMER_TOKEN}, Bearer ${ADMIN_TOKEN}` } }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('14 token whitespace is never trimmed into a successful credential', async () => {
  assert.throws(() => parseBearerAuthorization(['Authorization', `Bearer ${CUSTOMER_TOKEN} `]));
  assert.throws(() => parseBearerAuthorization(['Authorization', `Bearer  ${CUSTOMER_TOKEN}`]));
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: { Authorization: `Bearer  ${CUSTOMER_TOKEN}` } }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('15 a token in the query string is not authentication', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: `/v1/menu?token=${CUSTOMER_TOKEN}` }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('16 body and cookie tokens are not authentication', async () => {
  await withFixture(async ({ port }) => {
    const cookie = await request({ port, path: '/v1/menu', headers: { Cookie: `token=${CUSTOMER_TOKEN}` } });
    assertError(cookie, 401, 'AUTHENTICATION_FAILED', 'Authentication failed.');
    const body = JSON.stringify({ token: CUSTOMER_TOKEN });
    const bodyResponse = await request({
      port,
      path: '/v1/menu',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assertError(bodyResponse, 401, 'AUTHENTICATION_FAILED', 'Authentication failed.');
  });
});

test('17 a revoked token is rejected generically', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: authHeaders(REVOKED_TOKEN) }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('18 an unregistered valid token is rejected generically', async () => {
  await withFixture(async ({ port }) => assertError(
    await request({ port, path: '/v1/menu', headers: authHeaders(UNKNOWN_TOKEN) }),
    401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
  ));
});

test('19 every 401 includes the Bearer challenge', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/device/config' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  });
});

test('20 authentication errors expose neither raw token nor token hash', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/menu', headers: authHeaders(UNKNOWN_TOKEN) });
    const exposed = `${response.rawBody}\n${JSON.stringify(response.headers)}`;
    assert.equal(exposed.includes(UNKNOWN_TOKEN), false);
    assert.equal(exposed.includes(digestFor(UNKNOWN_TOKEN)), false);
  });
});

test('21 customer device config returns 200', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/device/config', headers: authHeaders(CUSTOMER_TOKEN) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.role, 'customer');
  });
});

test('22 customer config uses the latest table assignment and label', async () => {
  await withFixture(async ({ database, port }) => {
    database.exec(`
      UPDATE tables SET assigned_customer_device_id = NULL, updated_at_ms = 7000 WHERE table_id = 1;
      INSERT INTO tables (
        table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms
      ) VALUES (3, 'Latest table', '${CUSTOMER_ID}', 1, 2, 1000, 7001);
    `);
    const response = await request({ port, path: '/v1/device/config', headers: authHeaders(CUSTOMER_TOKEN) });
    assert.equal(response.json.tableId, 3);
    assert.equal(response.json.tableLabel, 'Latest table');
    assert.equal(response.json.tableIsActive, true);
  });
});

test('23 kitchen config contains no table identity', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/device/config', headers: authHeaders(KITCHEN_TOKEN) });
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(response.json, 'tableId'), false);
    assert.equal(Object.hasOwn(response.json, 'tableLabel'), false);
    assert.equal(Object.hasOwn(response.json, 'tableIsActive'), false);
  });
});

test('24 admin config contains no table identity', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/device/config', headers: authHeaders(ADMIN_TOKEN) });
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(response.json, 'tableId'), false);
    assert.equal(Object.hasOwn(response.json, 'tableLabel'), false);
    assert.equal(Object.hasOwn(response.json, 'tableIsActive'), false);
  });
});

test('25 device config exposes no token, hash, or pairing information', async () => {
  await withFixture(async ({ port }) => {
    for (const token of [CUSTOMER_TOKEN, KITCHEN_TOKEN, ADMIN_TOKEN]) {
      const response = await request({ port, path: '/v1/device/config', headers: authHeaders(token) });
      assertNoKeys(response.json, /token|hash|pairing/i);
      assert.equal(response.rawBody.includes(token), false);
      assert.equal(response.rawBody.includes(digestFor(token)), false);
    }
  });
});

test('26 a token stops working immediately after device revocation', async () => {
  await withFixture(async ({ database, port }) => {
    assert.equal((await request({ port, path: '/v1/device/config', headers: authHeaders(CUSTOMER_TOKEN) })).statusCode, 200);
    database.prepare(`
      UPDATE devices SET status = 'revoked', revoked_at_ms = 7000, updated_at_ms = 7000
      WHERE device_id = ?
    `).run(CUSTOMER_ID);
    assertError(
      await request({ port, path: '/v1/device/config', headers: authHeaders(CUSTOMER_TOKEN) }),
      401, 'AUTHENTICATION_FAILED', 'Authentication failed.',
    );
  });
});

test('27 invalid device states become safe 403 or 500 responses', async () => {
  await withFixture(async ({ port }) => {
    assertError(
      await request({ port, path: '/v1/device/config', headers: authHeaders(UNASSIGNED_TOKEN) }),
      403, 'AUTHORIZATION_FAILED', 'Authorization failed.',
    );
    assertError(
      await request({ port, path: '/v1/device/config', headers: authHeaders(INCONSISTENT_TOKEN) }),
      500, 'INTERNAL_ERROR', 'Internal server error.',
    );
  });
});

test('28 customer menu returns 200', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.audience, 'customer');
  });
});

test('29 customer menu contains no price', async () => {
  await withFixture(async ({ port }) => assertNoKeys(
    (await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) })).json,
    /price/i,
  ));
});

test('30 customer menu contains no kitchen alias', async () => {
  await withFixture(async ({ port }) => assertNoKeys(
    (await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) })).json,
    /kitchenAlias/i,
  ));
});

test('31 customer menu excludes hidden and inactive entries', async () => {
  await withFixture(async ({ port }) => {
    const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) })).json;
    assert.deepEqual(menu.categories.map(({ categoryId }) => categoryId), ['recommended', 'drinks']);
    assert.deepEqual(menu.items.map(({ menuItemId }) => menuItemId), ['food', 'sold-out', 'beer']);
  });
});

test('32 kitchen menu includes kitchen aliases', async () => {
  await withFixture(async ({ port }) => {
    const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(KITCHEN_TOKEN) })).json;
    assert.equal(menu.audience, 'kitchen');
    assert.equal(menu.items.every((item) => typeof item.kitchenAlias === 'string'), true);
  });
});

test('33 kitchen menu contains no price', async () => {
  await withFixture(async ({ port }) => assertNoKeys(
    (await request({ port, path: '/v1/menu', headers: authHeaders(KITCHEN_TOKEN) })).json,
    /price/i,
  ));
});

test('34 admin menu includes integer yen prices', async () => {
  await withFixture(async ({ port }) => {
    const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(ADMIN_TOKEN) })).json;
    assert.equal(menu.items.every((item) => Number.isSafeInteger(item.priceYen)), true);
  });
});

test('35 admin menu includes hidden categories and inactive items', async () => {
  await withFixture(async ({ port }) => {
    const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(ADMIN_TOKEN) })).json;
    assert.equal(menu.categories.some(({ categoryId, isVisible }) => categoryId === 'hidden' && !isVisible), true);
    assert.equal(menu.items.some(({ menuItemId, isActive }) => menuItemId === 'inactive' && !isActive), true);
  });
});

test('36 sold-out state is preserved for every role', async () => {
  await withFixture(async ({ port }) => {
    for (const token of [CUSTOMER_TOKEN, KITCHEN_TOKEN, ADMIN_TOKEN]) {
      const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(token) })).json;
      assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'sold-out').isSoldOut, true);
    }
  });
});

test('37 menu ordering is stable and deterministic', async () => {
  await withFixture(async ({ port }) => {
    const first = (await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) })).json;
    const second = (await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) })).json;
    assert.deepEqual(first.categories, second.categories);
    assert.deepEqual(first.items, second.items);
    assert.deepEqual(first.items.map(({ menuItemId }) => menuItemId), ['food', 'sold-out', 'beer']);
  });
});

test('38 query and body role claims cannot expand customer visibility', async () => {
  await withFixture(async ({ port }) => {
    const query = await request({ port, path: '/v1/menu?role=admin', headers: authHeaders(CUSTOMER_TOKEN) });
    assert.equal(query.statusCode, 200);
    assert.equal(query.json.audience, 'customer');
    assertNoKeys(query.json, /price|kitchenAlias/i);
    const body = JSON.stringify({ role: 'admin' });
    const bodyResponse = await request({
      port,
      path: '/v1/menu',
      headers: { ...authHeaders(CUSTOMER_TOKEN), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(bodyResponse.json.audience, 'customer');
    assertNoKeys(bodyResponse.json, /price|kitchenAlias/i);
  });
});

test('39 unknown and ambiguous routes return 404', async () => {
  await withFixture(async ({ port }) => {
    for (const path of ['/v1/unknown', '/v1/menu/', '/v1/menus', '/v1/device/config/']) {
      assertError(await request({ port, path }), 404, 'NOT_FOUND', 'Resource not found.');
    }
  });
});

test('40 known routes reject every unsupported method including HEAD', async () => {
  await withFixture(async ({ port }) => {
    for (const path of ['/v1/health', '/v1/device/config', '/v1/menu']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        const response = await request({ port, path, method });
        assert.equal(response.statusCode, 405);
        if (method !== 'HEAD') assertError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        else assert.equal(response.rawBody, '');
      }
    }
  });
});

test('41 every 405 advertises GET in Allow', async () => {
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/menu', method: 'POST' });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'GET');
  });
});

test('42 unexpected failures return a generic 500 without internal detail', async () => {
  const internal = 'SELECT token_hash FROM devices; C:\\secret\\orders.sqlite3';
  await withFixture(async ({ port }) => {
    const response = await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) });
    assertError(response, 500, 'INTERNAL_ERROR', 'Internal server error.');
    assert.equal(response.rawBody.includes(internal), false);
    assert.equal(response.rawBody.includes('stack'), false);
    assert.equal(response.rawBody.includes('cause'), false);
  }, {
    wrapCatalog: (catalog) => ({
      getDeviceSettings: catalog.getDeviceSettings,
      getMenuForPrincipal() {
        throw new Error(internal, { cause: new Error('private cause') });
      },
    }),
  });
});

test('43 all application JSON responses use nosniff', async () => {
  await withFixture(async ({ port }) => {
    const responses = [
      await request({ port, path: '/v1/health' }),
      await request({ port, path: '/v1/menu' }),
      await request({ port, path: '/missing' }),
      await request({ port, path: '/v1/health', method: 'POST' }),
    ];
    for (const response of responses) assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });
});

test('44 authenticated endpoint responses are never cached', async () => {
  await withFixture(async ({ port }) => {
    const success = await request({ port, path: '/v1/menu', headers: authHeaders(CUSTOMER_TOKEN) });
    const failure = await request({ port, path: '/v1/menu' });
    assert.equal(success.headers['cache-control'], 'no-store');
    assert.equal(failure.headers['cache-control'], 'no-store');
  });
});

test('45 request IDs are valid UUIDs, echoed in headers, and distinct', async () => {
  await withFixture(async ({ port }) => {
    const first = await request({ port, path: '/v1/menu' });
    const second = await request({ port, path: '/v1/menu' });
    assert.match(first.json.requestId, UUID_PATTERN);
    assert.equal(first.headers['x-request-id'], first.json.requestId);
    assert.notEqual(first.json.requestId, second.json.requestId);
  });
});

test('46 concurrent reads do not mix principals or role-scoped data', async () => {
  await withFixture(async ({ port }) => {
    const roles = [
      [CUSTOMER_TOKEN, 'customer'],
      [KITCHEN_TOKEN, 'kitchen'],
      [ADMIN_TOKEN, 'admin'],
    ];
    const requests = Array.from({ length: 30 }, (_, index) => {
      const [token, role] = roles[index % roles.length];
      return request({ port, path: '/v1/menu', headers: authHeaders(token) }).then((response) => ({ response, role }));
    });
    const results = await Promise.all(requests);
    for (const { response, role } of results) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.json.audience, role);
      if (role !== 'admin') assertNoKeys(response.json, /price/i);
      if (role === 'customer') assertNoKeys(response.json, /kitchenAlias/i);
    }
    assert.equal(new Set(results.map(({ response }) => response.headers['x-request-id'])).size, results.length);
  });
});

test('47 server close releases its port without closing external dependencies', async () => {
  await withFixture(async ({ database, authenticator, catalog, port, closeServer: stop }) => {
    await stop();
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.equal(catalog.getDeviceSettings(principal).deviceId, CUSTOMER_ID);
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  });
});

test('48 HTTP reads do not modify any database row or event', async () => {
  await withFixture(async ({ database, port }) => {
    const before = snapshotDatabase(database);
    await request({ port, path: '/v1/health' });
    for (const token of [CUSTOMER_TOKEN, KITCHEN_TOKEN, ADMIN_TOKEN]) {
      await request({ port, path: '/v1/device/config', headers: authHeaders(token) });
      await request({ port, path: '/v1/menu', headers: authHeaders(token) });
    }
    await request({ port, path: '/v1/menu', headers: authHeaders(UNKNOWN_TOKEN) });
    assert.deepEqual(snapshotDatabase(database), before);
  });
});

test('49 over-limit URLs and headers fail safely without crashing the process', async () => {
  await withFixture(async ({ port }) => {
    const longUrl = await request({ port, path: `/v1/${'x'.repeat(8_500)}` });
    assertError(longUrl, 414, 'URI_TOO_LONG', 'Request URI is too long.');
    const longHeader = await request({
      port,
      path: '/v1/health',
      headers: { 'X-Test-Padding': 'x'.repeat(20_000) },
    });
    assert.equal(longHeader.statusCode, 431);
    assert.equal((await request({ port, path: '/v1/health' })).statusCode, 200);
  });
});

test('50 response DTOs exactly match the role-scoped OpenAPI schemas', async () => {
  await withFixture(async ({ port }) => {
    const configRequired = ['deviceId', 'role', 'deviceLabel', 'status', 'configVersion', 'eventEpoch', 'lastEventId'];
    const menuRequired = ['audience', 'eventEpoch', 'lastEventId', 'categories', 'items'];
    const publicCategory = ['categoryId', 'name', 'sortOrder'];
    const adminCategory = [...publicCategory, 'isVisible', 'version', 'updatedAtMs'];
    const customerItem = ['menuItemId', 'categoryId', 'formalName', 'description', 'isSoldOut', 'sortOrder', 'version'];
    const kitchenItem = ['menuItemId', 'categoryId', 'formalName', 'kitchenAlias', 'isSoldOut', 'sortOrder', 'version'];
    const adminItem = [
      'menuItemId', 'categoryId', 'formalName', 'kitchenAlias', 'description', 'priceYen',
      'isSoldOut', 'isActive', 'sortOrder', 'version', 'updatedAtMs',
    ];
    for (const [token, role] of [[CUSTOMER_TOKEN, 'customer'], [KITCHEN_TOKEN, 'kitchen'], [ADMIN_TOKEN, 'admin']]) {
      const config = (await request({ port, path: '/v1/device/config', headers: authHeaders(token) })).json;
      assertExactKeys(config, role === 'customer'
        ? [...configRequired, 'tableId', 'tableLabel', 'tableIsActive']
        : configRequired);
      assert.equal(config.role, role);

      const menu = (await request({ port, path: '/v1/menu', headers: authHeaders(token) })).json;
      assertExactKeys(menu, menuRequired);
      assert.equal(menu.audience, role);
      const categoryKeys = role === 'admin' ? adminCategory : publicCategory;
      const itemKeys = role === 'customer' ? customerItem : role === 'kitchen' ? kitchenItem : adminItem;
      menu.categories.forEach((category) => assertExactKeys(category, categoryKeys));
      menu.items.forEach((item) => assertExactKeys(item, itemKeys, ['imageUri']));
    }
  });
});
