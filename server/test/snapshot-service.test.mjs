import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import {
  CATALOG_ERROR_CODES,
  CatalogRepositoryError,
} from '../src/catalog/catalog-errors.mjs';
import { createCatalogRepository } from '../src/catalog/catalog-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import {
  SNAPSHOT_ERROR_CODES,
  SnapshotServiceError,
} from '../src/events/snapshot-errors.mjs';
import { createSnapshotService } from '../src/events/snapshot-service.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const EPOCH = uuid(900);

function customerDevice(eventId = 1, overrides = {}) {
  return {
    deviceId: uuid(1),
    role: 'customer',
    deviceLabel: '架空客席',
    status: 'active',
    configVersion: 1,
    eventEpoch: EPOCH,
    lastEventId: eventId,
    tableId: 1,
    tableLabel: 'テーブル1',
    tableIsActive: true,
    ...overrides,
  };
}

function customerMenu(eventId = 1, overrides = {}) {
  return {
    audience: 'customer',
    eventEpoch: EPOCH,
    lastEventId: eventId,
    categories: [{ categoryId: 'food', name: '料理', sortOrder: 1 }],
    items: [{
      menuItemId: 'edamame',
      categoryId: 'food',
      formalName: '枝豆（塩ゆで）',
      description: '架空商品',
      isSoldOut: false,
      sortOrder: 1,
      version: 1,
    }],
    ...overrides,
  };
}

function customerOrders(eventId = 1, overrides = {}) {
  return {
    audience: 'customer',
    eventEpoch: EPOCH,
    lastEventId: eventId,
    activeOrders: [],
    openStaffCalls: [],
    ...overrides,
  };
}

function fakeDependencies({ devices, menus, orders }) {
  const deviceQueue = [...devices];
  const menuQueue = [...menus];
  const orderQueue = [...orders];
  const calls = { device: 0, menu: 0, orders: 0 };
  return {
    calls,
    catalog: {
      getDeviceSettings() {
        calls.device += 1;
        return deviceQueue.shift() ?? devices.at(-1);
      },
      getMenuForPrincipal() {
        calls.menu += 1;
        return menuQueue.shift() ?? menus.at(-1);
      },
    },
    eventRepository: {
      getSnapshotOrders() {
        calls.orders += 1;
        return orderQueue.shift() ?? orders.at(-1);
      },
    },
  };
}

function assertSnapshotError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof SnapshotServiceError && error.code === code,
  );
}

test('retries until all role and cursor values match', () => {
  const dependencies = fakeDependencies({
    devices: [customerDevice(1), customerDevice(2)],
    menus: [customerMenu(2), customerMenu(2)],
    orders: [customerOrders(2), customerOrders(2)],
  });
  const snapshot = createSnapshotService(dependencies).getSnapshot({});
  assert.equal(snapshot.lastEventId, 2);
  assert.deepEqual(dependencies.calls, { device: 2, menu: 2, orders: 2 });
});

test('exhausts the bounded retry with SNAPSHOT_UNAVAILABLE', () => {
  const dependencies = fakeDependencies({
    devices: [customerDevice(1)],
    menus: [customerMenu(2)],
    orders: [customerOrders(3)],
  });
  const service = createSnapshotService({ ...dependencies, maxAttempts: 3 });
  assertSnapshotError(() => service.getSnapshot({}), SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE);
  assert.deepEqual(dependencies.calls, { device: 3, menu: 3, orders: 3 });
});

test('role mismatch is retried and never produces a mixed snapshot', () => {
  const dependencies = fakeDependencies({
    devices: [customerDevice()],
    menus: [customerMenu(1, { audience: 'kitchen' })],
    orders: [customerOrders()],
  });
  const service = createSnapshotService({ ...dependencies, maxAttempts: 2 });
  assertSnapshotError(() => service.getSnapshot({}), SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE);
  assert.deepEqual(dependencies.calls, { device: 2, menu: 2, orders: 2 });
});

test('customer snapshot whitelists fields and omits staff state', () => {
  const device = customerDevice(1, { tokenHash: 'secret-device-hash' });
  const menu = customerMenu(1, { internalAudit: 'secret-audit' });
  menu.categories[0].secret = 'hidden';
  menu.items[0].priceYen = 999999;
  const orders = customerOrders(1, {
    activeOrders: [{ secret: 'must-not-appear' }],
    openStaffCalls: [{ secret: 'must-not-appear' }],
  });
  const snapshot = createSnapshotService(fakeDependencies({
    devices: [device], menus: [menu], orders: [orders],
  })).getSnapshot({});
  assert.deepEqual(Object.keys(snapshot), ['audience', 'eventEpoch', 'lastEventId', 'device', 'menu']);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|tokenHash|priceYen|internalAudit/);
});

test('kitchen snapshot includes explicitly projected order and call state', () => {
  const device = {
    deviceId: uuid(3), role: 'kitchen', deviceLabel: '架空厨房', status: 'active',
    configVersion: 1, eventEpoch: EPOCH, lastEventId: 4,
  };
  const menu = {
    audience: 'kitchen', eventEpoch: EPOCH, lastEventId: 4,
    categories: [{ categoryId: 'food', name: '料理', sortOrder: 1 }],
    items: [{
      menuItemId: 'edamame', categoryId: 'food', formalName: '枝豆（塩ゆで）',
      kitchenAlias: '枝豆', isSoldOut: false, sortOrder: 1, version: 1,
    }],
  };
  const order = {
    orderId: uuid(201), clientOrderId: uuid(101), tableId: 1, tableNumberSnapshot: 1,
    status: 'new', totalAmountYen: 380, acceptedAtMs: 1000, version: 1,
    items: [{
      orderItemId: 1, menuItemId: 'edamame', formalNameSnapshot: '枝豆（塩ゆで）',
      kitchenAliasSnapshot: '枝豆', unitPriceYenSnapshot: 380, quantity: 1,
      lineTotalYen: 380, isServed: false, secret: 'hidden',
    }],
    secret: 'hidden',
  };
  const call = {
    staffCallId: uuid(301), clientCallId: uuid(302), tableId: 1,
    tableNumberSnapshot: 1, callType: 'staff', status: 'open', createdAtMs: 1000,
    version: 1, secret: 'hidden',
  };
  const snapshot = createSnapshotService(fakeDependencies({
    devices: [device],
    menus: [menu],
    orders: [{
      audience: 'kitchen', eventEpoch: EPOCH, lastEventId: 4,
      activeOrders: [order], openStaffCalls: [call],
    }],
  })).getSnapshot({});
  assert.equal(snapshot.activeOrders[0].totalAmountYen, 380);
  assert.equal(snapshot.openStaffCalls[0].status, 'open');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test('returned snapshot is recursively frozen without freezing dependency DTOs', () => {
  const device = customerDevice();
  const menu = customerMenu();
  const orders = customerOrders();
  const snapshot = createSnapshotService(fakeDependencies({
    devices: [device], menus: [menu], orders: [orders],
  })).getSnapshot({});
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.device), true);
  assert.equal(Object.isFrozen(snapshot.menu.items), true);
  assert.equal(Object.isFrozen(snapshot.menu.items[0]), true);
  assert.equal(Object.isFrozen(device), false);
  assert.equal(Object.isFrozen(menu), false);
});

test('catalog authentication errors map to a stable safe service code', () => {
  const catalog = {
    getDeviceSettings() {
      throw new CatalogRepositoryError(
        CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED,
        'SELECT token_hash FROM devices -- secret SQL',
      );
    },
    getMenuForPrincipal() { throw new Error('not reached'); },
  };
  const service = createSnapshotService({
    catalog,
    eventRepository: { getSnapshotOrders() {} },
  });
  assert.throws(() => service.getSnapshot({}), (error) => {
    assert.equal(error.code, SNAPSHOT_ERROR_CODES.AUTHENTICATION_REQUIRED);
    assert.doesNotMatch(error.message, /SELECT|token|SQL|secret/i);
    return true;
  });
});

test('invalid dependencies and retry bounds fail safely', () => {
  assertSnapshotError(() => createSnapshotService(), SNAPSHOT_ERROR_CODES.DATABASE_FAILURE);
  const dependencies = fakeDependencies({
    devices: [customerDevice()], menus: [customerMenu()], orders: [customerOrders()],
  });
  assertSnapshotError(
    () => createSnapshotService({ ...dependencies, maxAttempts: 0 }),
    SNAPSHOT_ERROR_CODES.DATABASE_FAILURE,
  );
});

const DEVICE_CUSTOMER = uuid(11);
const DEVICE_KITCHEN = uuid(12);
const TOKEN_CUSTOMER = Buffer.alloc(32, 11).toString('base64url');
const TOKEN_KITCHEN = Buffer.alloc(32, 12).toString('base64url');

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function seedIntegration(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'active', 1000, 1000, 1000)
  `);
  insertDevice.run(DEVICE_CUSTOMER, 'customer', '架空客席', tokenHash(TOKEN_CUSTOMER));
  insertDevice.run(DEVICE_KITCHEN, 'kitchen', '架空厨房', tokenHash(TOKEN_KITCHEN));
  database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, created_at_ms, updated_at_ms
    ) VALUES (1, 'テーブル1', ?, 1, 1000, 1000)
  `).run(DEVICE_CUSTOMER);
  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, created_at_ms, updated_at_ms
    ) VALUES ('food', '料理', 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description, price_yen,
      is_sold_out, is_active, sort_order, created_at_ms, updated_at_ms
    ) VALUES ('edamame', 'food', '枝豆（塩ゆで）', '枝豆', '架空商品', 380,
      0, 1, 1, 1000, 1000)
  `).run();
}

async function withIntegration(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-snapshot-test-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'snapshot.sqlite3') });
  let authenticator;
  let catalog;
  let events;
  try {
    seedIntegration(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    catalog = createCatalogRepository({ database: connection.database });
    events = createEventRepository({ database: connection.database });
    await run({
      database: connection.database,
      service: createSnapshotService({ catalog, eventRepository: events }),
      customer: authenticator.authenticateDeviceToken(TOKEN_CUSTOMER),
      kitchen: authenticator.authenticateDeviceToken(TOKEN_KITCHEN),
    });
  } finally {
    try { events?.close(); } catch {}
    try { catalog?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

test('real repositories compose a genuine role-scoped customer snapshot without writes', async () => {
  await withIntegration(({ database, service, customer }) => {
    const before = database.prepare('SELECT total_changes() AS count').get().count;
    const snapshot = service.getSnapshot(customer);
    const after = database.prepare('SELECT total_changes() AS count').get().count;
    assert.equal(snapshot.audience, 'customer');
    assert.equal(snapshot.device.tableId, 1);
    assert.equal(snapshot.menu.items[0].formalName, '枝豆（塩ゆで）');
    assert.equal('priceYen' in snapshot.menu.items[0], false);
    assert.equal(after, before);
  });
});

test('real repositories compose active orders for kitchen from one stable cursor', async () => {
  await withIntegration(({ database, service, kitchen }) => {
    createOrderRepository({
      database,
      now: () => 2000,
      idFactory: () => uuid(201),
    }).createOrder({
      clientOrderId: uuid(101),
      authenticatedDeviceId: DEVICE_CUSTOMER,
      items: [{ menuItemId: 'edamame', quantity: 2 }],
    });
    const snapshot = service.getSnapshot(kitchen);
    assert.equal(snapshot.audience, 'kitchen');
    assert.equal(snapshot.activeOrders[0].totalAmountYen, 760);
    assert.equal(snapshot.lastEventId, 1);
    assert.equal(snapshot.device.lastEventId, snapshot.lastEventId);
    assert.equal(snapshot.menu.lastEventId, snapshot.lastEventId);
  });
});

test('real catalog rejects a forged principal through the service boundary', async () => {
  await withIntegration(({ service }) => {
    assertSnapshotError(
      () => service.getSnapshot({ deviceId: DEVICE_CUSTOMER, role: 'customer' }),
      SNAPSHOT_ERROR_CODES.AUTHENTICATION_REQUIRED,
    );
  });
});
