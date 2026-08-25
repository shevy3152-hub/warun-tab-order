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
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { createHttpServer } from '../src/http/http-server.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const ADMIN_ID = uuid(9_001);
const CUSTOMER_ID = uuid(9_002);
const ADMIN_TOKEN = tokenFor(0x31);
const CUSTOMER_TOKEN = tokenFor(0x11);
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function seed(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status, paired_at_ms,
      revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'active', 1000, NULL, 1000, 1000)
  `);
  insertDevice.run(ADMIN_ID, 'admin', 'Admin', hash(ADMIN_TOKEN));
  insertDevice.run(CUSTOMER_ID, 'customer', 'Customer', hash(CUSTOMER_TOKEN));
  database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, version,
      created_at_ms, updated_at_ms
    ) VALUES (1, 'Table 1', ?, 1, 1, 1000, 1000)
  `).run(CUSTOMER_ID);
  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms
    ) VALUES ('drink', 'Drink', 1, 1, 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description,
      price_yen, is_sold_out, is_active, sort_order, image_uri, version,
      created_at_ms, updated_at_ms, section_key
    ) VALUES ('sake', 'drink', '日本酒', '日本酒', '説明', 700, 0, 1, 1, NULL, 1, 1000, 1000, NULL)
  `).run();
}

function seedShochu(database) {
  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms
    ) VALUES ('shochu', '焼酎', 2, 1, 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description,
      price_yen, is_sold_out, is_active, sort_order, image_uri, version,
      created_at_ms, updated_at_ms, section_key
    ) VALUES ('shochu-imo-kuro-kirishima', 'shochu', '黒霧島', '黒霧島', '黒麹仕込み', 550, 0, 1, 1,
      '/menu-images/shochu/shochu-imo-kuro-kirishima-thumb-v1.webp', 1, 1000, 1000, '芋')
  `).run();
  database.prepare(`
    INSERT INTO menu_item_details (
      menu_item_id, detail_enabled, detail_image_uri, reading, item_type, producer,
      taste, detail_description, created_at_ms, updated_at_ms
    ) VALUES ('shochu-imo-kuro-kirishima', 1,
      '/menu-images/shochu/shochu-imo-kuro-kirishima-detail-v1.webp', 'くろきりしま', '芋焼酎', '霧島酒造',
      'とろりとした甘み、キリッとした後切れ', '黒麹仕込み。とろりとした甘み、キリッとした後切れ。', 1000, 1000)
  `).run();
  const options = [
    ['rock', 'ロック', 1],
    ['water', '水割り', 2],
    ['soda', 'ソーダ割り', 3],
    ['hot', 'お湯割り', 4],
  ];
  const insert = database.prepare(`
    INSERT INTO menu_item_serving_options (
      serving_option_id, menu_item_id, name, is_active, sort_order, version, created_at_ms, updated_at_ms
    ) VALUES (?, 'shochu-imo-kuro-kirishima', ?, 1, ?, 1, 1000, 1000)
  `);
  for (const [suffix, name, sortOrder] of options) insert.run(`shochu-imo-kuro-kirishima-${suffix}`, name, sortOrder);
}

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

function request({ port, token, body, method = 'PUT', path = '/v1/admin/catalog/menu-item' }) {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...JSON_HEADERS,
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
    client.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-admin-catalog-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'server.sqlite3') });
  let server;
  let catalog;
  let orders;
  let events;
  let hub;
  try {
    seed(connection.database);
    const authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    events = createEventRepository({ database: connection.database });
    orders = createOrderRepository({ database: connection.database, now: () => 1_800_000_001_000 });
    const snapshots = createSnapshotService({ catalog, eventRepository: events });
    const realHub = createSseHub({ eventRepository: events, heartbeatIntervalMs: 500, maxConnectionMs: 5_000 });
    const notifications = [];
    hub = {
      attach: realHub.attach,
      close: realHub.close,
      notifyCommitted: (cursor) => { notifications.push(cursor); return realHub.notifyCommitted(cursor); },
    };
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
    await run({ connection, database: connection.database, port, notifications });
    await closeServer(server);
    hub.close();
    events.close();
    orders.close();
    catalog.close();
    authenticator.close();
  } finally {
    await closeServer(server).catch(() => {});
    try { hub?.close?.(); } catch {}
    try { events?.close(); } catch {}
    try { orders?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

function writeBody(expectedVersion = 1) {
  return {
    expectedVersion,
    menuItemId: 'sake',
    categoryId: 'drink',
    formalName: '純米吟醸',
    kitchenAlias: '純米吟醸',
    description: '香りの確認用',
    priceYen: 880,
    isSoldOut: false,
    isActive: true,
    sortOrder: 2,
    imageUri: '/images/sake.webp',
    sectionKey: null,
    detail: {
      enabled: true,
      showImageInList: true,
      reading: 'じゅんまいぎんじょう',
      itemType: '日本酒',
      origin: '新潟',
      producer: '架空酒造',
      taste: 'すっきり',
      aroma: '穏やか',
      sweetness: 'やや辛口',
      finish: 'きれい',
      recommendation: '食中酒に',
      description: '詳細説明',
    },
    variants: [
      { variantId: 'sake_glass', name: 'グラス', volumeLabel: '90ml', priceYen: 480, isActive: true, sortOrder: 1, temperatureOptions: ['冷酒'] },
      { variantId: 'sake_tokuri', name: '徳利1合', volumeLabel: '180ml', priceYen: 980, isActive: true, sortOrder: 2, temperatureOptions: ['冷酒', '燗酒'] },
    ],
    servingOptions: [],
  };
}

function shochuBrowserBody(expectedVersion = 1, showImageInList = true) {
  return {
    expectedVersion,
    menuItemId: 'shochu-imo-kuro-kirishima',
    categoryId: 'shochu',
    formalName: '黒霧島',
    kitchenAlias: '黒霧島',
    description: '黒麹仕込み。とろりとした甘み、キリッとした後切れ。',
    priceYen: 550,
    isSoldOut: false,
    isActive: true,
    sortOrder: 1,
    imageUri: '/menu-images/shochu/shochu-imo-kuro-kirishima-thumb-v1.webp',
    sectionKey: '芋',
    detail: {
      enabled: true,
      showImageInList,
      imageUri: '/menu-images/shochu/shochu-imo-kuro-kirishima-detail-v1.webp',
      reading: 'くろきりしま',
      itemType: '芋焼酎',
      origin: '',
      producer: '霧島酒造',
      taste: 'とろりとした甘み、キリッとした後切れ',
      aroma: '',
      sweetness: '',
      finish: '',
      recommendation: '',
      description: '黒麹仕込み。とろりとした甘み、キリッとした後切れ。',
    },
    variants: [],
    servingOptions: [
      { servingOptionId: 'shochu-imo-kuro-kirishima-rock', name: 'ロック', isActive: true, sortOrder: 1 },
      { servingOptionId: 'shochu-imo-kuro-kirishima-water', name: '水割り', isActive: true, sortOrder: 2 },
      { servingOptionId: 'shochu-imo-kuro-kirishima-soda', name: 'ソーダ割り', isActive: true, sortOrder: 3 },
      { servingOptionId: 'shochu-imo-kuro-kirishima-hot', name: 'お湯割り', isActive: true, sortOrder: 4 },
    ],
  };
}

test('admin catalog write requires admin authentication and persists one atomic menu update', async () => {
  await withFixture(async ({ port, database, notifications }) => {
    const unauthenticated = await request({ port, body: writeBody() });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json.error.code, 'AUTHENTICATION_FAILED');

    const customer = await request({ port, token: CUSTOMER_TOKEN, body: writeBody() });
    assert.equal(customer.statusCode, 403);
    assert.equal(customer.json.error.code, 'AUTHORIZATION_FAILED');

    const response = await request({ port, token: ADMIN_TOKEN, body: writeBody() });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json).sort(), ['eventEpoch', 'eventId', 'menuItemId', 'version']);
    assert.equal(response.json.menuItemId, 'sake');
    assert.equal(response.json.version, 2);
    assert.equal(notifications.length, 1);

    const item = database.prepare('SELECT * FROM menu_items WHERE menu_item_id = ?').get('sake');
    assert.equal(item.formal_name, '純米吟醸');
    assert.equal(item.price_yen, 880);
    assert.equal(item.version, 2);
    const detail = database.prepare('SELECT * FROM menu_item_details WHERE menu_item_id = ?').get('sake');
    assert.equal(detail.aroma, '穏やか');
    assert.equal(detail.sweetness, 'やや辛口');
    assert.equal(detail.finish, 'きれい');
    assert.equal(detail.show_image_in_list, 1);
    assert.equal(detail.reading, 'じゅんまいぎんじょう');
    const reloaded = await request({ port, token: ADMIN_TOKEN, method: 'GET', path: '/v1/menu' });
    assert.equal(reloaded.statusCode, 200);
    const reloadedItem = reloaded.json.items.find((entry) => entry.menuItemId === 'sake');
    assert.equal(reloadedItem.detail.showImageInList, true);
    assert.equal(reloadedItem.detail.reading, 'じゅんまいぎんじょう');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_item_variants WHERE menu_item_id = ?').get('sake').count, 2);
    assert.equal(database.prepare('SELECT temperature_options_json FROM menu_item_variants WHERE variant_id = ?').get('sake_glass').temperature_options_json, '["冷酒"]');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log WHERE event_type = ?').get('menu.updated').count, 1);
  });
});

test('admin catalog write rejects stale versions without changing the catalog or event cursor', async () => {
  await withFixture(async ({ port, database }) => {
    const first = await request({ port, token: ADMIN_TOKEN, body: writeBody() });
    assert.equal(first.statusCode, 200);
    const before = database.prepare('SELECT version, price_yen FROM menu_items WHERE menu_item_id = ?').get('sake');
    const eventCount = database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count;
    const stale = await request({ port, token: ADMIN_TOKEN, body: writeBody(1) });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json.error.code, 'CATALOG_CONFLICT');
    assert.deepEqual(database.prepare('SELECT version, price_yen FROM menu_items WHERE menu_item_id = ?').get('sake'), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, eventCount);
  });
});

test('browser-shaped shochu catalog payload preserves canonical serving IDs and image/readings', async () => {
  await withFixture(async ({ port, database }) => {
    seedShochu(database);
    const response = await request({ port, token: ADMIN_TOKEN, body: shochuBrowserBody() });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.menuItemId, 'shochu-imo-kuro-kirishima');
    assert.equal(response.json.version, 2);

    const detail = database.prepare('SELECT show_image_in_list, reading FROM menu_item_details WHERE menu_item_id = ?').get('shochu-imo-kuro-kirishima');
    assert.deepEqual({ ...detail }, { show_image_in_list: 1, reading: 'くろきりしま' });
    assert.deepEqual(
      database.prepare('SELECT serving_option_id FROM menu_item_serving_options WHERE menu_item_id = ? AND is_active = 1 ORDER BY sort_order').all('shochu-imo-kuro-kirishima').map((row) => row.serving_option_id),
      [
        'shochu-imo-kuro-kirishima-rock',
        'shochu-imo-kuro-kirishima-water',
        'shochu-imo-kuro-kirishima-soda',
        'shochu-imo-kuro-kirishima-hot',
      ],
    );
    const reloaded = await request({ port, token: ADMIN_TOKEN, method: 'GET', path: '/v1/menu' });
    const item = reloaded.json.items.find((entry) => entry.menuItemId === 'shochu-imo-kuro-kirishima');
    assert.equal(item.detail.showImageInList, true);
    assert.equal(item.detail.reading, 'くろきりしま');
  });
});
