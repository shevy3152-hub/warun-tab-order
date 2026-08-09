import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  authorizeDeviceRole,
  createDeviceAuthenticator,
} from '../src/auth/device-auth.mjs';
import {
  CATALOG_ERROR_CODES,
  CatalogRepositoryError,
} from '../src/catalog/catalog-errors.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const digestFor = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const CUSTOMER_DEVICE_ID = uuid(801);
const SECOND_CUSTOMER_DEVICE_ID = uuid(802);
const UNASSIGNED_DEVICE_ID = uuid(803);
const INACTIVE_TABLE_DEVICE_ID = uuid(804);
const KITCHEN_DEVICE_ID = uuid(805);
const ADMIN_DEVICE_ID = uuid(806);

const CUSTOMER_TOKEN = tokenFor(0x11);
const SECOND_CUSTOMER_TOKEN = tokenFor(0x12);
const UNASSIGNED_TOKEN = tokenFor(0x13);
const INACTIVE_TABLE_TOKEN = tokenFor(0x14);
const KITCHEN_TOKEN = tokenFor(0x21);
const ADMIN_TOKEN = tokenFor(0x31);

const CLIENT_ORDER_ID = uuid(850);
const ORDER_ID = uuid(851);
const FIXED_NOW = 1_786_280_200_000;

function seedCatalogFixture(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id,
      role,
      display_name,
      token_hash,
      status,
      paired_at_ms,
      last_seen_at_ms,
      revoked_at_ms,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, 'active', 1000, 1500, NULL, 1000, ?)
  `);

  insertDevice.run(CUSTOMER_DEVICE_ID, 'customer', '客席端末1', digestFor(CUSTOMER_TOKEN), 2001);
  insertDevice.run(
    SECOND_CUSTOMER_DEVICE_ID,
    'customer',
    '客席端末2',
    digestFor(SECOND_CUSTOMER_TOKEN),
    2002,
  );
  insertDevice.run(
    UNASSIGNED_DEVICE_ID,
    'customer',
    '未割当端末',
    digestFor(UNASSIGNED_TOKEN),
    2003,
  );
  insertDevice.run(
    INACTIVE_TABLE_DEVICE_ID,
    'customer',
    '無効卓端末',
    digestFor(INACTIVE_TABLE_TOKEN),
    2004,
  );
  insertDevice.run(KITCHEN_DEVICE_ID, 'kitchen', '厨房端末', digestFor(KITCHEN_TOKEN), 2005);
  insertDevice.run(ADMIN_DEVICE_ID, 'admin', '管理端末', digestFor(ADMIN_TOKEN), 2006);

  const insertTable = database.prepare(`
    INSERT INTO tables (
      table_id,
      label,
      assigned_customer_device_id,
      is_active,
      version,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?)
  `);
  insertTable.run(1, 'テーブル1', CUSTOMER_DEVICE_ID, 1, 1, 3001);
  insertTable.run(2, 'テーブル2', SECOND_CUSTOMER_DEVICE_ID, 1, 1, 3002);
  insertTable.run(3, 'テーブル3', null, 1, 1, 3003);
  insertTable.run(4, 'テーブル4', INACTIVE_TABLE_DEVICE_ID, 0, 1, 3004);

  const insertCategory = database.prepare(`
    INSERT INTO categories (
      category_id,
      name,
      sort_order,
      is_visible,
      version,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?)
  `);
  insertCategory.run('hidden', '非表示', 0, 0, 3, 4100);
  insertCategory.run('recommended', 'おすすめ', 1, 1, 4, 4101);
  insertCategory.run('alpha', '一品', 2, 1, 5, 4102);
  insertCategory.run('drinks', '飲み物', 2, 1, 6, 4103);

  const insertMenuItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id,
      category_id,
      formal_name,
      kitchen_alias,
      description,
      price_yen,
      is_sold_out,
      is_active,
      sort_order,
      image_uri,
      version,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?)
  `);
  insertMenuItem.run(
    'secret-item',
    'hidden',
    '非表示商品',
    '非表示',
    '管理画面だけに表示',
    999,
    0,
    1,
    1,
    null,
    2,
    5100,
  );
  insertMenuItem.run(
    'tamago',
    'recommended',
    'だし巻き玉子',
    'だし巻き',
    'ふんわり出汁が香る',
    580,
    0,
    1,
    1,
    '/images/tamago.webp',
    7,
    5101,
  );
  insertMenuItem.run(
    'edamame',
    'recommended',
    '枝豆',
    '枝豆',
    'まずは定番',
    380,
    0,
    1,
    2,
    null,
    8,
    5102,
  );
  insertMenuItem.run(
    'sold-out',
    'recommended',
    '本日の売り切れ',
    '売切品',
    '売り切れ確認用',
    480,
    1,
    1,
    3,
    null,
    9,
    5103,
  );
  insertMenuItem.run(
    'inactive-item',
    'recommended',
    '提供終了品',
    '終了品',
    '非表示商品の確認用',
    420,
    0,
    0,
    4,
    null,
    10,
    5104,
  );
  insertMenuItem.run(
    'alpha-item',
    'alpha',
    '冷奴',
    '冷奴',
    '一品料理',
    350,
    0,
    1,
    1,
    null,
    11,
    5105,
  );
  insertMenuItem.run(
    'beer',
    'drinks',
    '生ビール',
    '生中',
    'よく冷えた生ビール',
    680,
    0,
    1,
    1,
    null,
    12,
    5106,
  );
  insertMenuItem.run(
    'beer-z',
    'drinks',
    '瓶ビール',
    '瓶',
    '瓶ビール',
    720,
    0,
    1,
    1,
    null,
    13,
    5107,
  );

  const { event_epoch: eventEpoch } = database
    .prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1')
    .get();
  database.prepare(`
    INSERT INTO event_log (
      event_epoch,
      event_type,
      aggregate_type,
      aggregate_id,
      actor_device_id,
      payload_json,
      created_at_ms
    ) VALUES (?, 'menu.updated', 'menu_item', 'tamago', ?, '{}', 6000)
  `).run(eventEpoch, ADMIN_DEVICE_ID);
}

async function withCatalogFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-catalog-test-'));
  const databasePath = join(directory, 'catalog.sqlite3');
  const connection = initializeDatabase({ databasePath });

  try {
    seedCatalogFixture(connection.database);
    const authenticator = createDeviceAuthenticator({ database: connection.database });
    const catalog = createCatalogRepository({ database: connection.database });
    await run({
      connection,
      database: connection.database,
      databasePath,
      authenticator,
      catalog,
    });
  } finally {
    try {
      connection.close();
    } catch {
      // The test may intentionally close the connection first.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function authenticate(authenticator, token) {
  return authenticator.authenticateDeviceToken(token);
}

function assertCatalogError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof CatalogRepositoryError && error.code === code,
  );
}

function assertNoSecretFields(value) {
  const forbidden = /(?:^|_)(?:raw_?token|token(?:_?hash)?|pairing(?:_?code)?(?:_?hash)?)(?:$|_)/i;
  const visit = (current) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, nested] of Object.entries(current)) {
        assert.doesNotMatch(key, forbidden);
        visit(nested);
      }
    }
  };
  visit(value);
}

function assertRecursivelyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {
    assertRecursivelyFrozen(nested);
  }
}

function snapshotReadOnlyTables(database) {
  return {
    devices: database.prepare('SELECT * FROM devices ORDER BY device_id').all(),
    tables: database.prepare('SELECT * FROM tables ORDER BY table_id').all(),
    categories: database.prepare('SELECT * FROM categories ORDER BY category_id').all(),
    menuItems: database.prepare('SELECT * FROM menu_items ORDER BY menu_item_id').all(),
    eventLog: database.prepare('SELECT * FROM event_log ORDER BY event_id').all(),
    systemState: database.prepare('SELECT * FROM system_state ORDER BY singleton_id').all(),
  };
}

function itemIds(menu) {
  return menu.items.map(({ menuItemId }) => menuItemId);
}

test('customer principal retrieves current device settings', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(settings.deviceId, CUSTOMER_DEVICE_ID);
    assert.equal(settings.role, 'customer');
    assert.equal(settings.deviceLabel, '客席端末1');
    assert.equal(settings.status, 'active');
    assert.ok(Number.isSafeInteger(settings.configVersion) && settings.configVersion >= 1);
  });
});

test('kitchen principal retrieves current device settings', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, KITCHEN_TOKEN));
    assert.deepEqual(
      Object.keys(settings).sort(),
      ['configVersion', 'deviceId', 'deviceLabel', 'role', 'status'],
    );
    assert.equal(settings.role, 'kitchen');
  });
});

test('admin principal retrieves current device settings', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, ADMIN_TOKEN));
    assert.equal(settings.deviceId, ADMIN_DEVICE_ID);
    assert.equal(settings.role, 'admin');
    assert.equal(settings.deviceLabel, '管理端末');
  });
});

test('forged plain object principal is rejected', async () => {
  await withCatalogFixture(({ catalog }) => {
    assertCatalogError(
      () => catalog.getDeviceSettings({
        deviceId: CUSTOMER_DEVICE_ID,
        role: 'customer',
        tableId: 1,
      }),
      CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED,
    );
  });
});

test('principal is rejected after its device is revoked in the database', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.prepare(`
      UPDATE devices
      SET status = 'revoked', revoked_at_ms = 7000, updated_at_ms = 7000
      WHERE device_id = ?
    `).run(CUSTOMER_DEVICE_ID);
    assertCatalogError(
      () => catalog.getDeviceSettings(principal),
      CATALOG_ERROR_CODES.DEVICE_NOT_ACTIVE,
    );
  });
});

test('latest database role supersedes the role captured in the principal', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, KITCHEN_TOKEN);
    database.prepare(`
      UPDATE devices SET role = 'admin', updated_at_ms = 7001 WHERE device_id = ?
    `).run(KITCHEN_DEVICE_ID);
    assert.equal(catalog.getDeviceSettings(principal).role, 'admin');
    const menu = catalog.getMenuForPrincipal(principal);
    assert.equal(menu.audience, 'admin');
    assert.equal(menu.items.some((item) => 'priceYen' in item), true);
  });
});

test('customer settings include the current table identity and active state', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(settings.tableId, 1);
    assert.equal(settings.tableLabel, 'テーブル1');
    assert.equal(settings.tableIsActive, true);
  });
});

test('customer settings use a table reassigned after principal issuance', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.exec(`
      UPDATE tables
      SET assigned_customer_device_id = NULL, version = 2, updated_at_ms = 7002
      WHERE table_id IN (1, 2);
    `);
    database.prepare(`
      UPDATE tables
      SET assigned_customer_device_id = ?, version = 3, updated_at_ms = 7003
      WHERE table_id = 2
    `).run(CUSTOMER_DEVICE_ID);
    const settings = catalog.getDeviceSettings(principal);
    assert.equal(settings.tableId, 2);
    assert.equal(settings.tableLabel, 'テーブル2');
  });
});

test('customer without a current table assignment is rejected', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    assertCatalogError(
      () => catalog.getDeviceSettings(authenticate(authenticator, UNASSIGNED_TOKEN)),
      CATALOG_ERROR_CODES.DEVICE_NOT_ASSIGNED,
    );
  });
});

test('customer assigned to an inactive table is rejected', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    assertCatalogError(
      () => catalog.getDeviceSettings(authenticate(authenticator, INACTIVE_TABLE_TOKEN)),
      CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
    );
  });
});

test('device role and table assignment inconsistency is rejected', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.prepare(`
      UPDATE devices SET role = 'kitchen', updated_at_ms = 7004 WHERE device_id = ?
    `).run(CUSTOMER_DEVICE_ID);
    assertCatalogError(
      () => catalog.getDeviceSettings(principal),
      CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
    );
  });
});

test('kitchen and admin settings never invent table fields', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    for (const token of [KITCHEN_TOKEN, ADMIN_TOKEN]) {
      const settings = catalog.getDeviceSettings(authenticate(authenticator, token));
      assert.equal(Object.hasOwn(settings, 'tableId'), false);
      assert.equal(Object.hasOwn(settings, 'tableLabel'), false);
      assert.equal(Object.hasOwn(settings, 'tableIsActive'), false);
    }
  });
});

test('device settings expose no token or pairing secret', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, CUSTOMER_TOKEN));
    assertNoSecretFields(settings);
    const serialized = JSON.stringify(settings);
    assert.equal(serialized.includes(CUSTOMER_TOKEN), false);
    assert.equal(serialized.includes(digestFor(CUSTOMER_TOKEN)), false);
  });
});

test('device settings are frozen against accidental mutation', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const settings = catalog.getDeviceSettings(authenticate(authenticator, CUSTOMER_TOKEN));
    assertRecursivelyFrozen(settings);
    assert.throws(() => {
      settings.role = 'admin';
    }, TypeError);
    assert.equal(settings.role, 'customer');
  });
});

test('device settings read the latest device label from the database', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.prepare(`
      UPDATE devices SET display_name = '客席端末・更新後', updated_at_ms = 7005
      WHERE device_id = ?
    `).run(CUSTOMER_DEVICE_ID);
    assert.equal(catalog.getDeviceSettings(principal).deviceLabel, '客席端末・更新後');
  });
});

test('customer menu includes visible categories only', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.deepEqual(menu.categories.map(({ categoryId }) => categoryId), [
      'recommended',
      'alpha',
      'drinks',
    ]);
  });
});

test('customer menu includes active items only', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(itemIds(menu).includes('inactive-item'), false);
    assert.equal(itemIds(menu).includes('tamago'), true);
  });
});

test('customer menu retains sold-out items with an explicit sold-out flag', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    const soldOut = menu.items.find(({ menuItemId }) => menuItemId === 'sold-out');
    assert.ok(soldOut);
    assert.equal(soldOut.isSoldOut, true);
  });
});

test('customer menu never exposes prices', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(menu.items.every((item) => !Object.hasOwn(item, 'priceYen')), true);
    assert.equal(JSON.stringify(menu).includes('price_yen'), false);
  });
});

test('customer menu never exposes kitchen aliases', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(menu.items.every((item) => !Object.hasOwn(item, 'kitchenAlias')), true);
    assert.equal(JSON.stringify(menu).includes('生中'), false);
  });
});

test('customer menu excludes items belonging to hidden categories', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(itemIds(menu).includes('secret-item'), false);
  });
});

test('customer categories and items follow the documented stable ordering', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.deepEqual(menu.categories.map(({ categoryId }) => categoryId), [
      'recommended',
      'alpha',
      'drinks',
    ]);
    assert.deepEqual(itemIds(menu), [
      'tamago',
      'edamame',
      'sold-out',
      'alpha-item',
      'beer',
      'beer-z',
    ]);
  });
});

test('customer menu returns only the identifiers and fields needed for ordering', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    assert.equal(menu.audience, 'customer');
    assert.equal(typeof menu.eventEpoch, 'string');
    assert.equal(menu.lastEventId, 1);
    assert.deepEqual(Object.keys(menu.categories[0]).sort(), ['categoryId', 'name', 'sortOrder']);
    const tamago = menu.items.find(({ menuItemId }) => menuItemId === 'tamago');
    assert.deepEqual(Object.keys(tamago).sort(), [
      'categoryId',
      'description',
      'formalName',
      'imageUri',
      'isSoldOut',
      'menuItemId',
      'sortOrder',
      'version',
    ]);
    const edamame = menu.items.find(({ menuItemId }) => menuItemId === 'edamame');
    assert.equal(Object.hasOwn(edamame, 'imageUri'), false);
  });
});

test('kitchen menu exposes formal menu names', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    assert.equal(menu.audience, 'kitchen');
    assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'beer').formalName, '生ビール');
  });
});

test('kitchen menu exposes kitchen aliases', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'beer').kitchenAlias, '生中');
  });
});

test('kitchen menu exposes sold-out state', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'sold-out').isSoldOut, true);
  });
});

test('kitchen menu shape is distinct from the customer shape', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const customer = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    const kitchen = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    const customerItem = customer.items.find(({ menuItemId }) => menuItemId === 'beer');
    const kitchenItem = kitchen.items.find(({ menuItemId }) => menuItemId === 'beer');
    assert.equal(Object.hasOwn(customerItem, 'description'), true);
    assert.equal(Object.hasOwn(customerItem, 'kitchenAlias'), false);
    assert.equal(Object.hasOwn(kitchenItem, 'description'), false);
    assert.equal(Object.hasOwn(kitchenItem, 'kitchenAlias'), true);
  });
});

test('kitchen menu omits prices that are not required for kitchen work', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    assert.equal(menu.items.every((item) => !Object.hasOwn(item, 'priceYen')), true);
  });
});

test('kitchen menu uses visible categories, active items, and stable order', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    assert.deepEqual(itemIds(menu), [
      'tamago',
      'edamame',
      'sold-out',
      'alpha-item',
      'beer',
      'beer-z',
    ]);
    assert.equal(itemIds(menu).includes('secret-item'), false);
    assert.equal(itemIds(menu).includes('inactive-item'), false);
  });
});

test('admin menu includes hidden categories', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    assert.deepEqual(menu.categories.map(({ categoryId }) => categoryId), [
      'hidden',
      'recommended',
      'alpha',
      'drinks',
    ]);
    assert.equal(menu.categories[0].isVisible, false);
  });
});

test('admin menu includes hidden and inactive items', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    assert.equal(itemIds(menu).includes('secret-item'), true);
    assert.equal(itemIds(menu).includes('inactive-item'), true);
    assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'inactive-item').isActive, false);
  });
});

test('admin menu exposes integer yen prices', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    const tamago = menu.items.find(({ menuItemId }) => menuItemId === 'tamago');
    assert.equal(tamago.priceYen, 580);
    assert.equal(Number.isInteger(tamago.priceYen), true);
  });
});

test('admin menu exposes both formal names and kitchen aliases', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    const item = menu.items.find(({ menuItemId }) => menuItemId === 'tamago');
    assert.equal(item.formalName, 'だし巻き玉子');
    assert.equal(item.kitchenAlias, 'だし巻き');
  });
});

test('admin menu exposes sale, visibility, sort, version, and update state', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    const category = menu.categories.find(({ categoryId }) => categoryId === 'hidden');
    assert.deepEqual(category, {
      categoryId: 'hidden',
      name: '非表示',
      sortOrder: 0,
      isVisible: false,
      version: 3,
      updatedAtMs: 4100,
    });
    const item = menu.items.find(({ menuItemId }) => menuItemId === 'sold-out');
    assert.equal(item.isSoldOut, true);
    assert.equal(item.isActive, true);
    assert.equal(item.sortOrder, 3);
    assert.equal(item.version, 9);
    assert.equal(item.updatedAtMs, 5103);
  });
});

test('admin menu contains no token or pairing secret', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    assertNoSecretFields(menu);
    const serialized = JSON.stringify(menu);
    for (const secret of [CUSTOMER_TOKEN, ADMIN_TOKEN, digestFor(ADMIN_TOKEN)]) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

test('admin menu has deterministic category and item ordering', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const menu = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));
    assert.deepEqual(itemIds(menu), [
      'secret-item',
      'tamago',
      'edamame',
      'sold-out',
      'inactive-item',
      'alpha-item',
      'beer',
      'beer-z',
    ]);
  });
});

test('menu results are recursively frozen and cannot affect later reads', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    const first = catalog.getMenuForPrincipal(principal);
    assertRecursivelyFrozen(first);
    assert.throws(() => first.items.push({ menuItemId: 'forged' }), TypeError);
    assert.throws(() => {
      first.items[0].formalName = '改ざん';
    }, TypeError);
    assert.deepEqual(catalog.getMenuForPrincipal(principal), first);
  });
});

test('settings and menu reads do not update any persisted row', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principals = [
      authenticate(authenticator, CUSTOMER_TOKEN),
      authenticate(authenticator, KITCHEN_TOKEN),
      authenticate(authenticator, ADMIN_TOKEN),
    ];
    const before = snapshotReadOnlyTables(database);
    for (const principal of principals) {
      catalog.getDeviceSettings(principal);
      catalog.getMenuForPrincipal(principal);
    }
    assert.deepEqual(snapshotReadOnlyTables(database), before);
  });
});

test('SQLite failure during a menu read maps to DATABASE_FAILURE', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.exec('DROP TABLE menu_items;');
    assertCatalogError(
      () => catalog.getMenuForPrincipal(principal),
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(database.isTransaction, false);
    database.exec('BEGIN; ROLLBACK;');
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  });
});

test('catalog errors do not expose SQL text, raw tokens, hashes, or internal details', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    database.exec('DROP TABLE menu_items;');
    let error;
    try {
      catalog.getMenuForPrincipal(principal);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CatalogRepositoryError);
    const externalText = `${error.name}: ${error.message}`;
    assert.doesNotMatch(externalText, /SELECT|menu_items|SQLITE|DROP TABLE/i);
    assert.equal(externalText.includes(CUSTOMER_TOKEN), false);
    assert.equal(externalText.includes(digestFor(CUSTOMER_TOKEN)), false);
  });
});

test('closed catalog repository rejects use without closing the supplied database', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    catalog.close();
    assertCatalogError(
      () => catalog.getDeviceSettings(principal),
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  });
});

test('catalog use after the supplied database is closed fails safely', async () => {
  await withCatalogFixture(({ connection, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    connection.close();
    assertCatalogError(
      () => catalog.getDeviceSettings(principal),
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
    );
  });
});

test('SQL injection-like stored labels and names remain inert values', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    const injectionText = "x'); DROP TABLE menu_items; --";
    database.prepare('UPDATE devices SET display_name = ? WHERE device_id = ?')
      .run(injectionText, CUSTOMER_DEVICE_ID);
    database.prepare('UPDATE menu_items SET formal_name = ? WHERE menu_item_id = ?')
      .run(injectionText, 'edamame');
    assert.equal(catalog.getDeviceSettings(principal).deviceLabel, injectionText);
    const menu = catalog.getMenuForPrincipal(principal);
    assert.equal(menu.items.find(({ menuItemId }) => menuItemId === 'edamame').formalName, injectionText);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count, 8);
  });
});

test('consecutive menu reads return identical content and order', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const principal = authenticate(authenticator, KITCHEN_TOKEN);
    const first = catalog.getMenuForPrincipal(principal);
    const second = catalog.getMenuForPrincipal(principal);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});

test('customer, kitchen, and admin menus do not leak forbidden cross-role fields', async () => {
  await withCatalogFixture(({ authenticator, catalog }) => {
    const customer = catalog.getMenuForPrincipal(authenticate(authenticator, CUSTOMER_TOKEN));
    const kitchen = catalog.getMenuForPrincipal(authenticate(authenticator, KITCHEN_TOKEN));
    const admin = catalog.getMenuForPrincipal(authenticate(authenticator, ADMIN_TOKEN));

    assert.equal(customer.items.every((item) => (
      !('priceYen' in item) && !('kitchenAlias' in item) && !('isActive' in item)
    )), true);
    assert.equal(kitchen.items.every((item) => (
      !('priceYen' in item) && !('description' in item) && 'kitchenAlias' in item
    )), true);
    assert.equal(admin.items.every((item) => (
      'priceYen' in item && 'kitchenAlias' in item && 'isActive' in item
    )), true);
    assertNoSecretFields({ customer, kitchen, admin });
  });
});

test('authenticated principal flows through settings, menu, authorization, and order persistence', async () => {
  await withCatalogFixture(({ database, authenticator, catalog }) => {
    const principal = authenticate(authenticator, CUSTOMER_TOKEN);
    const settings = catalog.getDeviceSettings(principal);
    const menu = catalog.getMenuForPrincipal(principal);
    authorizeDeviceRole(principal, ['customer']);

    const orderRepository = createOrderRepository({
      database,
      now: () => FIXED_NOW,
      idFactory: () => ORDER_ID,
    });
    const result = orderRepository.createOrder({
      clientOrderId: CLIENT_ORDER_ID,
      authenticatedDeviceId: principal.deviceId,
      items: [{ menuItemId: menu.items[0].menuItemId, quantity: 1 }],
    });

    assert.equal(settings.tableId, 1);
    assert.equal(result.idempotencyResult, 'created');
    assert.equal(result.order.authenticatedDeviceId, CUSTOMER_DEVICE_ID);
    assert.equal(result.order.tableId, settings.tableId);
  });
});
