import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import {
  EVENT_ERROR_CODES,
  EventRepositoryError,
} from '../src/events/event-errors.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const DEVICE_A = uuid(1);
const DEVICE_B = uuid(2);
const DEVICE_KITCHEN = uuid(3);
const DEVICE_ADMIN = uuid(4);
const DEVICE_UNASSIGNED = uuid(5);
const DEVICE_REVOKED = uuid(6);
const FIXED_NOW = 1_786_280_000_000;

function rawToken(byte) {
  return Buffer.alloc(32, byte).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKENS = Object.freeze({
  customerA: rawToken(1),
  customerB: rawToken(2),
  kitchen: rawToken(3),
  admin: rawToken(4),
  unassigned: rawToken(5),
  revoked: rawToken(6),
});

function seedFixture(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status,
      paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?, 1000, 1000)
  `);
  insertDevice.run(DEVICE_A, 'customer', '架空客席A', hashToken(TOKENS.customerA), 'active', null);
  insertDevice.run(DEVICE_B, 'customer', '架空客席B', hashToken(TOKENS.customerB), 'active', null);
  insertDevice.run(
    DEVICE_KITCHEN,
    'kitchen',
    '架空厨房',
    hashToken(TOKENS.kitchen),
    'active',
    null,
  );
  insertDevice.run(DEVICE_ADMIN, 'admin', '架空管理', hashToken(TOKENS.admin), 'active', null);
  insertDevice.run(
    DEVICE_UNASSIGNED,
    'customer',
    '架空未割当',
    hashToken(TOKENS.unassigned),
    'active',
    null,
  );
  insertDevice.run(
    DEVICE_REVOKED,
    'customer',
    '架空失効',
    hashToken(TOKENS.revoked),
    'revoked',
    2000,
  );

  const insertTable = database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, 1000, 1000)
  `);
  insertTable.run(1, 'テーブル1', DEVICE_A);
  insertTable.run(2, 'テーブル2', DEVICE_B);

  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, created_at_ms, updated_at_ms
    ) VALUES ('food', '料理', 1, 1000, 1000)
  `).run();
  const insertMenuItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, price_yen,
      is_sold_out, is_active, sort_order, created_at_ms, updated_at_ms
    ) VALUES (?, 'food', ?, ?, ?, 0, 1, ?, 1000, 1000)
  `);
  insertMenuItem.run('edamame', '枝豆（塩ゆで）', '枝豆', 380, 1);
  insertMenuItem.run('beer', '生ビール（中）', '生中', 680, 2);
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-event-test-'));
  const databasePath = join(directory, 'events.sqlite3');
  const connection = initializeDatabase({ databasePath });
  let authenticator;
  let repository;
  try {
    seedFixture(connection.database);
    authenticator = createDeviceAuthenticator({ database: connection.database });
    repository = createEventRepository({ database: connection.database });
    const principals = {
      customerA: authenticator.authenticateDeviceToken(TOKENS.customerA),
      customerB: authenticator.authenticateDeviceToken(TOKENS.customerB),
      kitchen: authenticator.authenticateDeviceToken(TOKENS.kitchen),
      admin: authenticator.authenticateDeviceToken(TOKENS.admin),
      unassigned: authenticator.authenticateDeviceToken(TOKENS.unassigned),
    };
    await run({
      connection,
      database: connection.database,
      repository,
      authenticator,
      principals,
    });
  } finally {
    try { repository?.close(); } catch {}
    try { authenticator?.close(); } catch {}
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

function assertEventError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof EventRepositoryError && error.code === code,
  );
}

function currentEpoch(database) {
  return database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get()
    .event_epoch;
}

function createOrder(database, {
  deviceId = DEVICE_A,
  clientOrderId = uuid(100),
  orderId = uuid(200),
  items = [{ menuItemId: 'edamame', quantity: 1 }],
  now = FIXED_NOW,
} = {}) {
  return createOrderRepository({
    database,
    now: () => now,
    idFactory: () => orderId,
  }).createOrder({
    clientOrderId,
    authenticatedDeviceId: deviceId,
    items,
  });
}

function insertEvent(database, {
  type,
  aggregateType,
  aggregateId,
  actorDeviceId = DEVICE_ADMIN,
  payload = { secret: 'must-not-leak', priceYen: 999999 },
  createdAtMs = FIXED_NOW,
}) {
  return Number(database.prepare(`
    INSERT INTO event_log (
      event_epoch, event_type, aggregate_type, aggregate_id,
      actor_device_id, payload_json, created_at_ms
    )
    SELECT event_epoch, ?, ?, ?, ?, ?, ?
    FROM system_state WHERE singleton_id = 1
  `).run(
    type,
    aggregateType,
    aggregateId,
    actorDeviceId,
    JSON.stringify(payload),
    createdAtMs,
  ).lastInsertRowid);
}

function insertOpenStaffCall(database, {
  staffCallId = uuid(301),
  clientCallId = uuid(302),
  customerDeviceId = DEVICE_A,
  tableId = 1,
  createdAtMs = FIXED_NOW,
} = {}) {
  database.prepare(`
    INSERT INTO staff_calls (
      staff_call_id, client_call_id, customer_device_id, table_id,
      table_number_snapshot, call_type, status, created_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'staff', 'open', ?, 1)
  `).run(
    staffCallId,
    clientCallId,
    customerDeviceId,
    tableId,
    tableId,
    createdAtMs,
  );
  return insertEvent(database, {
    type: 'staff_call.created',
    aggregateType: 'staff_call',
    aggregateId: staffCallId,
    actorDeviceId: customerDeviceId,
    createdAtMs,
  });
}

test('factory requires a ready database', () => {
  assertEventError(
    () => createEventRepository(),
    EVENT_ERROR_CODES.DATABASE_FAILURE,
  );
});

test('getCurrentCursor rejects a forged principal', async () => {
  await withFixture(({ repository }) => {
    assertEventError(
      () => repository.getCurrentCursor({ deviceId: DEVICE_A, role: 'customer' }),
      EVENT_ERROR_CODES.AUTHENTICATION_REQUIRED,
    );
  });
});

test('getCurrentCursor returns current DB audience, epoch, and tail', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    assert.deepEqual(repository.getCurrentCursor(principals.customerA), {
      audience: 'customer',
      eventEpoch: currentEpoch(database),
      lastEventId: 1,
    });
  });
});

test('current DB role replaces the role captured in the principal', async () => {
  await withFixture(({ database, repository, principals }) => {
    database.prepare('UPDATE tables SET assigned_customer_device_id = NULL WHERE table_id = 1').run();
    database.prepare("UPDATE devices SET role = 'kitchen' WHERE device_id = ?").run(DEVICE_A);
    assert.equal(repository.getCurrentCursor(principals.customerA).audience, 'kitchen');
  });
});

test('a principal is rejected after the device is revoked', async () => {
  await withFixture(({ database, repository, principals }) => {
    database.prepare(`
      UPDATE devices
      SET status = 'revoked', revoked_at_ms = 2000, updated_at_ms = 2000
      WHERE device_id = ?
    `).run(DEVICE_A);
    assertEventError(
      () => repository.getCurrentCursor(principals.customerA),
      EVENT_ERROR_CODES.DEVICE_NOT_ACTIVE,
    );
  });
});

test('an unassigned customer cannot read events', async () => {
  await withFixture(({ repository, principals }) => {
    assertEventError(
      () => repository.getCurrentCursor(principals.unassigned),
      EVENT_ERROR_CODES.DEVICE_NOT_ASSIGNED,
    );
  });
});

test('a customer with an inactive table is rejected as inconsistent', async () => {
  await withFixture(({ database, repository, principals }) => {
    database.prepare('UPDATE tables SET is_active = 0 WHERE table_id = 1').run();
    assertEventError(
      () => repository.getCurrentCursor(principals.customerA),
      EVENT_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
    );
  });
});

test('cursor zero is valid and replays current-epoch events', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    const result = repository.replay({
      principal: principals.customerA,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.lastEventId, 1);
  });
});

test('customer sees only orders created by its own device', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, { deviceId: DEVICE_A, clientOrderId: uuid(101), orderId: uuid(201) });
    createOrder(database, { deviceId: DEVICE_B, clientOrderId: uuid(102), orderId: uuid(202) });
    const result = repository.replay({
      principal: principals.customerA,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].aggregateId, uuid(201));
    assert.equal(result.lastEventId, 2, 'hidden rows still advance the scan cursor');
  });
});

test('kitchen sees all committed order events', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, { deviceId: DEVICE_A, clientOrderId: uuid(101), orderId: uuid(201) });
    createOrder(database, { deviceId: DEVICE_B, clientOrderId: uuid(102), orderId: uuid(202) });
    const events = repository.replay({
      principal: principals.kitchen,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    }).events;
    assert.deepEqual(events.map((event) => event.aggregateId), [uuid(201), uuid(202)]);
  });
});

test('admin sees management events while customer and kitchen do not', async () => {
  await withFixture(({ database, repository, principals }) => {
    insertEvent(database, {
      type: 'device.paired',
      aggregateType: 'device',
      aggregateId: uuid(900),
    });
    const input = { eventEpoch: currentEpoch(database), afterEventId: 0 };
    assert.equal(repository.replay({ principal: principals.customerA, ...input }).events.length, 0);
    assert.equal(repository.replay({ principal: principals.kitchen, ...input }).events.length, 0);
    assert.equal(repository.replay({ principal: principals.admin, ...input }).events.length, 1);
  });
});

test('raw event payload, price, and secret fields are never exposed', async () => {
  await withFixture(({ database, repository, principals }) => {
    insertEvent(database, {
      type: 'menu.updated',
      aggregateType: 'menu_item',
      aggregateId: 'hidden-expensive-item',
    });
    const event = repository.replay({
      principal: principals.customerA,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    }).events[0];
    assert.deepEqual(event.payload, { resource: 'menu', refreshRequired: true });
    assert.equal(event.aggregateId, 'menu');
    assert.doesNotMatch(JSON.stringify(event), /secret|priceYen|hidden-expensive-item/);
  });
});

test('customer receives only its current table assignment invalidation', async () => {
  await withFixture(({ database, repository, principals }) => {
    insertEvent(database, {
      type: 'table.assignment_updated',
      aggregateType: 'table',
      aggregateId: '2',
    });
    insertEvent(database, {
      type: 'table.assignment_updated',
      aggregateType: 'table',
      aggregateId: '1',
    });
    const result = repository.replay({
      principal: principals.customerA,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].eventId, 2);
    assert.equal(result.events[0].aggregateId, 'device-config');
    assert.equal(result.lastEventId, 2);
  });
});

test('event epoch mismatch requires snapshot recovery', async () => {
  await withFixture(({ repository, principals }) => {
    assertEventError(
      () => repository.replay({
        principal: principals.customerA,
        eventEpoch: uuid(999),
        afterEventId: 0,
      }),
      EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
    );
  });
});

test('future cursor requires snapshot recovery', async () => {
  await withFixture(({ database, repository, principals }) => {
    assertEventError(
      () => repository.replay({
        principal: principals.customerA,
        eventEpoch: currentEpoch(database),
        afterEventId: 100,
      }),
      EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
    );
  });
});

test('a deleted nonzero cursor requires snapshot recovery', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, { clientOrderId: uuid(101), orderId: uuid(201) });
    insertEvent(database, {
      type: 'menu.updated',
      aggregateType: 'menu_item',
      aggregateId: 'edamame',
    });
    database.prepare('DELETE FROM event_log WHERE event_id = 1').run();
    assertEventError(
      () => repository.replay({
        principal: principals.customerA,
        eventEpoch: currentEpoch(database),
        afterEventId: 1,
      }),
      EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
    );
  });
});

test('epoch rotation makes cursor zero valid even when AUTOINCREMENT starts high', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    const replacementEpoch = uuid(999);
    database.prepare(`
      UPDATE system_state SET event_epoch = ? WHERE singleton_id = 1
    `).run(replacementEpoch);
    insertEvent(database, {
      type: 'menu.updated',
      aggregateType: 'menu_item',
      aggregateId: 'edamame',
    });
    const result = repository.replay({
      principal: principals.customerA,
      eventEpoch: replacementEpoch,
      afterEventId: 0,
    });
    assert.equal(result.events[0].eventId, 2);
    assert.equal(result.lastEventId, 2);
  });
});

test('scan limit counts hidden events and advances cursor through them', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, { deviceId: DEVICE_B, clientOrderId: uuid(101), orderId: uuid(201) });
    createOrder(database, { deviceId: DEVICE_A, clientOrderId: uuid(102), orderId: uuid(202) });
    const first = repository.replay({
      principal: principals.customerA,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
      limit: 1,
    });
    assert.deepEqual(first.events, []);
    assert.equal(first.lastEventId, 1);
    assert.equal(first.hasMore, true);
    const second = repository.replay({
      principal: principals.customerA,
      eventEpoch: first.eventEpoch,
      afterEventId: first.lastEventId,
      limit: 1,
    });
    assert.equal(second.events[0].aggregateId, uuid(202));
    assert.equal(second.hasMore, false);
  });
});

test('range read respects inclusive throughEventId', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, { clientOrderId: uuid(101), orderId: uuid(201) });
    insertEvent(database, {
      type: 'menu.updated', aggregateType: 'menu_item', aggregateId: 'edamame',
    });
    insertEvent(database, {
      type: 'menu.sold_out_updated', aggregateType: 'menu_item', aggregateId: 'beer',
    });
    const result = repository.readCommittedForPrincipal(principals.customerA, {
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
      throughEventId: 2,
    });
    assert.deepEqual(result.events.map((event) => event.eventId), [1, 2]);
    assert.equal(result.lastEventId, 2);
    assert.equal(result.hasMore, false, 'events beyond the requested cap do not set hasMore');
  });
});

test('range read rejects an unavailable throughEventId', async () => {
  await withFixture(({ database, repository, principals }) => {
    assertEventError(
      () => repository.readCommittedForPrincipal(principals.customerA, {
        eventEpoch: currentEpoch(database),
        afterEventId: 0,
        throughEventId: 10,
      }),
      EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
    );
  });
});

test('range read rejects throughEventId below afterEventId', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    assertEventError(
      () => repository.readCommittedForPrincipal(principals.customerA, {
        eventEpoch: currentEpoch(database), afterEventId: 1, throughEventId: 0,
      }),
      EVENT_ERROR_CODES.INVALID_EVENT_REQUEST,
    );
  });
});

test('single committed event read returns null projection for an invisible event', async () => {
  await withFixture(({ database, repository, principals }) => {
    const created = createOrder(database, {
      deviceId: DEVICE_B, clientOrderId: uuid(101), orderId: uuid(201),
    });
    const result = repository.readCommittedEventForPrincipal({
      principal: principals.customerA,
      eventId: created.event.eventId,
    });
    assert.equal(result.event, null);
    assert.equal(result.eventId, created.event.eventId);
  });
});

test('invalid replay arguments use stable INVALID_EVENT_REQUEST errors', async () => {
  await withFixture(({ repository, principals }) => {
    for (const request of [
      { eventEpoch: 'not-a-uuid', afterEventId: 0 },
      { eventEpoch: uuid(999), afterEventId: -1 },
      { eventEpoch: uuid(999), afterEventId: 1.5 },
      { eventEpoch: uuid(999), afterEventId: 0, limit: 0 },
      { eventEpoch: uuid(999), afterEventId: 0, limit: 1001 },
    ]) {
      assertEventError(
        () => repository.replay({ principal: principals.customerA, ...request }),
        EVENT_ERROR_CODES.INVALID_EVENT_REQUEST,
      );
    }
  });
});

test('customer snapshot contains no orders or staff calls', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    insertOpenStaffCall(database);
    assert.deepEqual(repository.getSnapshotOrders(principals.customerA).activeOrders, []);
    assert.deepEqual(repository.getSnapshotOrders(principals.customerA).openStaffCalls, []);
  });
});

test('kitchen snapshot returns active orders with immutable item snapshots', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, {
      items: [
        { menuItemId: 'edamame', quantity: 2 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    });
    const result = repository.getSnapshotOrders(principals.kitchen);
    assert.equal(result.activeOrders.length, 1);
    assert.equal(result.activeOrders[0].totalAmountYen, 1440);
    const edamame = result.activeOrders[0].items.find((item) => item.menuItemId === 'edamame');
    assert.equal(edamame.formalNameSnapshot, '枝豆（塩ゆで）');
    assert.equal(edamame.kitchenAliasSnapshot, '枝豆');
    assert.equal(edamame.unitPriceYenSnapshot, 380);
    assert.equal(result.lastEventId, 1);
  });
});

test('snapshot places unserved items before served items', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database, {
      items: [
        { menuItemId: 'edamame', quantity: 1 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    });
    const servedId = database.prepare(`
      SELECT order_item_id FROM order_items WHERE menu_item_id = 'edamame'
    `).get().order_item_id;
    database.prepare(`
      UPDATE order_items
      SET is_served = 1, served_at_ms = ?, served_by_device_id = ?, updated_at_ms = ?
      WHERE order_item_id = ?
    `).run(FIXED_NOW + 1, DEVICE_KITCHEN, FIXED_NOW + 1, servedId);
    const items = repository.getSnapshotOrders(principals.kitchen).activeOrders[0].items;
    assert.deepEqual(items.map((item) => item.isServed), [false, true]);
  });
});

test('snapshot excludes completed orders', async () => {
  await withFixture(({ database, repository, principals }) => {
    const created = createOrder(database);
    database.prepare(`
      UPDATE orders SET status = 'completed', completed_at_ms = ?, version = 2
      WHERE order_id = ?
    `).run(FIXED_NOW + 1, created.order.orderId);
    assert.deepEqual(repository.getSnapshotOrders(principals.kitchen).activeOrders, []);
  });
});

test('kitchen and admin snapshots include open staff calls in stable order', async () => {
  await withFixture(({ database, repository, principals }) => {
    insertOpenStaffCall(database, {
      staffCallId: uuid(311), clientCallId: uuid(312), createdAtMs: FIXED_NOW + 2,
    });
    insertOpenStaffCall(database, {
      staffCallId: uuid(301), clientCallId: uuid(302), createdAtMs: FIXED_NOW + 1,
    });
    const kitchen = repository.getSnapshotOrders(principals.kitchen);
    const admin = repository.getSnapshotOrders(principals.admin);
    assert.deepEqual(kitchen.openStaffCalls.map((call) => call.staffCallId), [uuid(301), uuid(311)]);
    assert.deepEqual(admin.openStaffCalls, kitchen.openStaffCalls);
  });
});

test('snapshot excludes resolved staff calls', async () => {
  await withFixture(({ database, repository, principals }) => {
    insertOpenStaffCall(database);
    database.prepare(`
      UPDATE staff_calls
      SET status = 'resolved', resolved_at_ms = ?, resolved_by_device_id = ?, version = 2
    `).run(FIXED_NOW + 1, DEVICE_KITCHEN);
    assert.deepEqual(repository.getSnapshotOrders(principals.admin).openStaffCalls, []);
  });
});

test('all returned objects and arrays are recursively frozen', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    const replay = repository.replay({
      principal: principals.kitchen,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    });
    const snapshot = repository.getSnapshotOrders(principals.kitchen);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.events), true);
    assert.equal(Object.isFrozen(replay.events[0].payload), true);
    assert.equal(Object.isFrozen(snapshot.activeOrders[0].items), true);
  });
});

test('reads do not update devices, orders, calls, or event_log', async () => {
  await withFixture(({ database, repository, principals }) => {
    createOrder(database);
    insertOpenStaffCall(database);
    const before = database.prepare(`
      SELECT
        (SELECT total_changes()) AS total_changes,
        (SELECT COUNT(*) FROM event_log) AS event_count,
        (SELECT MAX(updated_at_ms) FROM devices) AS device_updated
    `).get();
    repository.getCurrentCursor(principals.kitchen);
    repository.replay({
      principal: principals.kitchen,
      eventEpoch: currentEpoch(database),
      afterEventId: 0,
    });
    repository.getSnapshotOrders(principals.kitchen);
    const after = database.prepare(`
      SELECT
        (SELECT total_changes()) AS total_changes,
        (SELECT COUNT(*) FROM event_log) AS event_count,
        (SELECT MAX(updated_at_ms) FROM devices) AS device_updated
    `).get();
    assert.deepEqual(after, before);
  });
});

test('repository close prevents further use without closing the database', async () => {
  await withFixture(({ database, repository, principals }) => {
    repository.close();
    assertEventError(
      () => repository.getCurrentCursor(principals.customerA),
      EVENT_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  });
});

test('database failure is converted without exposing SQL or stored payload', async () => {
  await withFixture(({ connection, repository, principals }) => {
    connection.close();
    assert.throws(
      () => repository.getCurrentCursor(principals.customerA),
      (error) => {
        assert.equal(error.code, EVENT_ERROR_CODES.DATABASE_FAILURE);
        assert.doesNotMatch(error.message, /SELECT|token|secret|payload/i);
        return true;
      },
    );
  });
});
