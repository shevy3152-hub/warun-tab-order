import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

import { initializeDatabase } from '../src/db/database.mjs';
import {
  ORDER_ERROR_CODES,
  OrderRepositoryError,
} from '../src/orders/order-errors.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const DEVICE_A = uuid(1);
const DEVICE_B = uuid(2);
const DEVICE_UNASSIGNED = uuid(3);
const DEVICE_INACTIVE_TABLE = uuid(4);
const DEVICE_KITCHEN = uuid(5);
const DEVICE_REVOKED = uuid(6);
const UNKNOWN_DEVICE = uuid(99);

const CLIENT_ORDER_A = uuid(101);
const CLIENT_ORDER_B = uuid(102);
const CLIENT_ORDER_C = uuid(103);
const ORDER_A = uuid(201);
const ORDER_B = uuid(202);
const ORDER_C = uuid(203);
const FIXED_NOW = 1_786_280_000_000;

function tokenHash(index) {
  return index.toString(16).padStart(64, '0');
}

function seedFixture(database) {
  const insertDevice = database.prepare(`
    INSERT INTO devices (
      device_id,
      role,
      display_name,
      token_hash,
      status,
      paired_at_ms,
      revoked_at_ms,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1000, ?, 1000, 1000)
  `);

  insertDevice.run(DEVICE_A, 'customer', '架空客席端末A', tokenHash(1), 'active', null);
  insertDevice.run(DEVICE_B, 'customer', '架空客席端末B', tokenHash(2), 'active', null);
  insertDevice.run(
    DEVICE_UNASSIGNED,
    'customer',
    '架空未割当端末',
    tokenHash(3),
    'active',
    null,
  );
  insertDevice.run(
    DEVICE_INACTIVE_TABLE,
    'customer',
    '架空休止席端末',
    tokenHash(4),
    'active',
    null,
  );
  insertDevice.run(DEVICE_KITCHEN, 'kitchen', '架空厨房端末', tokenHash(5), 'active', null);
  insertDevice.run(DEVICE_REVOKED, 'customer', '架空失効端末', tokenHash(6), 'revoked', 2000);

  const insertTable = database.prepare(`
    INSERT INTO tables (
      table_id,
      label,
      assigned_customer_device_id,
      is_active,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, 1000, 1000)
  `);
  insertTable.run(1, 'テーブル1', DEVICE_A, 1);
  insertTable.run(2, 'テーブル2', DEVICE_B, 1);
  insertTable.run(3, 'テーブル3', null, 1);
  insertTable.run(4, 'テーブル4', DEVICE_INACTIVE_TABLE, 0);

  database.prepare(`
    INSERT INTO categories (
      category_id,
      name,
      sort_order,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, 1000, 1000)
  `).run('recommended', 'おすすめ', 1);

  const insertMenuItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id,
      category_id,
      formal_name,
      kitchen_alias,
      price_yen,
      is_sold_out,
      is_active,
      sort_order,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, 'recommended', ?, ?, ?, ?, ?, ?, 1000, 1000)
  `);
  insertMenuItem.run('edamame', '枝豆（塩ゆで）', '枝豆', 380, 0, 1, 1);
  insertMenuItem.run('beer', '生ビール（中）', '生中', 680, 0, 1, 2);
  insertMenuItem.run('soldout', '本日の売り切れ品', '売切品', 500, 1, 1, 3);
  insertMenuItem.run('inactive', '提供終了品', '終了品', 400, 0, 0, 4);
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-order-test-'));
  const databasePath = join(directory, 'orders.sqlite3');
  const connections = [];

  try {
    const primary = initializeDatabase({ databasePath });
    connections.push(primary);
    seedFixture(primary.database);

    await run({
      database: primary.database,
      databasePath,
      openAdditionalConnection() {
        const connection = initializeDatabase({ databasePath });
        connections.push(connection);
        return connection.database;
      },
    });
  } finally {
    for (const connection of connections.reverse()) {
      try {
        connection.close();
      } catch {
        // Preserve the test result while still attempting all cleanup.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function makeRepository(database, options = {}) {
  const orderIds = [...(options.orderIds ?? [ORDER_A, ORDER_B, ORDER_C])];
  return createOrderRepository({
    database,
    now: options.now ?? (() => FIXED_NOW),
    idFactory: options.idFactory ?? (() => orderIds.shift()),
  });
}

function orderRequest(overrides = {}) {
  return {
    clientOrderId: CLIENT_ORDER_A,
    authenticatedDeviceId: DEVICE_A,
    items: [{ menuItemId: 'edamame', quantity: 1 }],
    ...overrides,
  };
}

function countRows(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function assertOrderError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof OrderRepositoryError && error.code === code,
  );
}

test('creates a new order and returns created', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest());
    assert.equal(result.idempotencyResult, 'created');
    assert.equal(result.order.orderId, ORDER_A);
    assert.equal(result.order.status, 'new');
  });
});

test('new order inserts exactly one orders row', async () => {
  await withFixture(({ database }) => {
    makeRepository(database).createOrder(orderRequest());
    assert.equal(countRows(database, 'orders'), 1);
  });
});

test('new order inserts one order_items row per input line', async () => {
  await withFixture(({ database }) => {
    makeRepository(database).createOrder(orderRequest({
      items: [
        { menuItemId: 'edamame', quantity: 2 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    }));
    assert.equal(countRows(database, 'order_items'), 2);
  });
});

test('new order inserts exactly one order.created event', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest());
    assert.equal(countRows(database, 'event_log'), 1);
    assert.equal(result.event.eventType, 'order.created');
  });
});

test('server calculates the order total from current prices', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest({
      items: [
        { menuItemId: 'edamame', quantity: 2 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    }));
    assert.equal(result.order.totalAmountYen, 1440);
    assert.equal(database.prepare('SELECT total_amount_yen FROM orders').get().total_amount_yen, 1440);
  });
});

test('stores formal name, kitchen alias, unit price, and table snapshots', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest());
    const item = database.prepare('SELECT * FROM order_items').get();
    const order = database.prepare('SELECT * FROM orders').get();
    assert.equal(item.formal_name_snapshot, '枝豆（塩ゆで）');
    assert.equal(item.kitchen_alias_snapshot, '枝豆');
    assert.equal(item.unit_price_yen_snapshot, 380);
    assert.equal(order.table_number_snapshot, 1);
    assert.equal(result.order.tableNumberSnapshot, 1);
  });
});

test('different input item order produces the same fingerprint', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    const first = repository.createOrder(orderRequest({
      items: [
        { menuItemId: 'edamame', quantity: 2 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    }));
    const second = repository.createOrder(orderRequest({
      clientOrderId: CLIENT_ORDER_B,
      items: [
        { menuItemId: 'beer', quantity: 1 },
        { menuItemId: 'edamame', quantity: 2 },
      ],
    }));
    assert.equal(first.order.requestFingerprint, second.order.requestFingerprint);
  });
});

test('canonical JSON has fixed keys and sorted items', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest({
      items: [
        { menuItemId: 'edamame', quantity: 2 },
        { menuItemId: 'beer', quantity: 1 },
      ],
    }));
    const expected = `{"fingerprintVersion":1,"authenticatedDeviceId":"${DEVICE_A}","items":[{"menuItemId":"beer","quantity":1},{"menuItemId":"edamame","quantity":2}]}`;
    assert.equal(result.order.canonicalRequestJson, expected);
    assert.equal(
      result.order.requestFingerprint,
      createHash('sha256').update(expected, 'utf8').digest('hex'),
    );
  });
});

test('same clientOrderId and intent returns replayed', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    const replay = repository.createOrder(orderRequest());
    assert.equal(replay.idempotencyResult, 'replayed');
    assert.equal(replay.order.orderId, ORDER_A);
    assert.equal(replay.event, null);
  });
});

test('replay does not add an orders row', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    repository.createOrder(orderRequest());
    assert.equal(countRows(database, 'orders'), 1);
  });
});

test('replay does not add order_items rows', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    repository.createOrder(orderRequest());
    assert.equal(countRows(database, 'order_items'), 1);
  });
});

test('replay does not add event_log rows', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    repository.createOrder(orderRequest());
    assert.equal(countRows(database, 'event_log'), 1);
  });
});

test('same clientOrderId with changed quantity returns ORDER_CONFLICT', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    assertOrderError(
      () => repository.createOrder(orderRequest({
        items: [{ menuItemId: 'edamame', quantity: 2 }],
      })),
      ORDER_ERROR_CODES.ORDER_CONFLICT,
    );
  });
});

test('same clientOrderId with a different item returns ORDER_CONFLICT', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    assertOrderError(
      () => repository.createOrder(orderRequest({
        items: [{ menuItemId: 'beer', quantity: 1 }],
      })),
      ORDER_ERROR_CODES.ORDER_CONFLICT,
    );
  });
});

test('same clientOrderId from a different device returns ORDER_CONFLICT', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    assertOrderError(
      () => repository.createOrder(orderRequest({ authenticatedDeviceId: DEVICE_B })),
      ORDER_ERROR_CODES.ORDER_CONFLICT,
    );
  });
});

test('replay after price change returns the stored price snapshot', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    database.prepare(`
      UPDATE menu_items SET price_yen = 450, version = version + 1, updated_at_ms = 2000
      WHERE menu_item_id = 'edamame'
    `).run();
    const replay = repository.createOrder(orderRequest());
    assert.equal(replay.idempotencyResult, 'replayed');
    assert.equal(replay.order.items[0].unitPriceYenSnapshot, 380);
    assert.equal(replay.order.totalAmountYen, 380);
  });
});

test('replay after sold-out change returns the stored order', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    database.prepare(`
      UPDATE menu_items SET is_sold_out = 1, version = version + 1, updated_at_ms = 2000
      WHERE menu_item_id = 'edamame'
    `).run();
    const replay = repository.createOrder(orderRequest());
    assert.equal(replay.idempotencyResult, 'replayed');
    assert.equal(replay.order.items[0].formalNameSnapshot, '枝豆（塩ゆで）');
  });
});

test('replay after table reassignment returns the original table snapshot', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.createOrder(orderRequest());
    database.exec(`
      UPDATE tables SET assigned_customer_device_id = NULL, version = version + 1, updated_at_ms = 2000
      WHERE table_id = 1;
      UPDATE tables SET assigned_customer_device_id = '${DEVICE_A}', version = version + 1, updated_at_ms = 2000
      WHERE table_id = 3;
    `);
    const replay = repository.createOrder(orderRequest());
    assert.equal(replay.idempotencyResult, 'replayed');
    assert.equal(replay.order.tableId, 1);
    assert.equal(replay.order.tableNumberSnapshot, 1);
  });
});

test('a new order uses the latest menu price', async () => {
  await withFixture(({ database }) => {
    database.prepare(`
      UPDATE menu_items SET price_yen = 450, version = version + 1, updated_at_ms = 2000
      WHERE menu_item_id = 'edamame'
    `).run();
    const result = makeRepository(database).createOrder(orderRequest());
    assert.equal(result.order.totalAmountYen, 450);
    assert.equal(result.order.items[0].unitPriceYenSnapshot, 450);
  });
});

test('unregistered device is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        authenticatedDeviceId: UNKNOWN_DEVICE,
      })),
      ORDER_ERROR_CODES.DEVICE_NOT_REGISTERED,
    );
  });
});

test('non-customer device is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        authenticatedDeviceId: DEVICE_KITCHEN,
      })),
      ORDER_ERROR_CODES.DEVICE_NOT_AUTHORIZED,
    );
  });
});

test('revoked customer device is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        authenticatedDeviceId: DEVICE_REVOKED,
      })),
      ORDER_ERROR_CODES.DEVICE_NOT_AUTHORIZED,
    );
  });
});

test('customer device without a table assignment is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        authenticatedDeviceId: DEVICE_UNASSIGNED,
      })),
      ORDER_ERROR_CODES.DEVICE_NOT_ASSIGNED,
    );
  });
});

test('inactive assigned table is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        authenticatedDeviceId: DEVICE_INACTIVE_TABLE,
      })),
      ORDER_ERROR_CODES.TABLE_INACTIVE,
    );
  });
});

test('missing menu item is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [{ menuItemId: 'missing', quantity: 1 }],
      })),
      ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND,
    );
  });
});

test('inactive menu item is treated as unavailable', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [{ menuItemId: 'inactive', quantity: 1 }],
      })),
      ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND,
    );
  });
});

test('sold-out menu item is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [{ menuItemId: 'soldout', quantity: 1 }],
      })),
      ORDER_ERROR_CODES.MENU_ITEM_SOLD_OUT,
    );
  });
});

test('zero, negative, fractional, and over-limit quantities are rejected', async () => {
  await withFixture(({ database }) => {
    for (const quantity of [0, -1, 1.5, 100]) {
      assertOrderError(
        () => makeRepository(database).createOrder(orderRequest({
          items: [{ menuItemId: 'edamame', quantity }],
        })),
        ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
      );
    }
    assert.equal(countRows(database, 'orders'), 0);
  });
});

test('schema quantity maximum of 99 is accepted', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest({
      items: [{ menuItemId: 'edamame', quantity: 99 }],
    }));
    assert.equal(result.order.items[0].quantity, 99);
    assert.equal(result.order.totalAmountYen, 37_620);
  });
});

test('empty items are rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({ items: [] })),
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
    );
  });
});

test('duplicate menuItemId lines are rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [
          { menuItemId: 'edamame', quantity: 1 },
          { menuItemId: 'edamame', quantity: 2 },
        ],
      })),
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
    );
  });
});

test('invalid clientOrderId UUID is rejected', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({ clientOrderId: 'not-a-uuid' })),
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
    );
  });
});

test('client-supplied table identity is rejected instead of trusted', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({ tableId: 2 })),
      ORDER_ERROR_CODES.INVALID_ORDER_REQUEST,
    );
  });
});

test('event_log failure rolls back order and all order items', async () => {
  await withFixture(({ database }) => {
    database.exec(`
      CREATE TRIGGER test_reject_order_event
      BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'order.created'
      BEGIN
        SELECT RAISE(ABORT, 'intentional event failure');
      END;
    `);
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest()),
      ORDER_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(countRows(database, 'orders'), 0);
    assert.equal(countRows(database, 'order_items'), 0);
    assert.equal(countRows(database, 'event_log'), 0);
  });
});

test('failure during a later order item rolls back order, earlier item, and event', async () => {
  await withFixture(({ database }) => {
    database.exec(`
      CREATE TRIGGER test_reject_second_item
      BEFORE INSERT ON order_items
      WHEN NEW.menu_item_id = 'edamame'
      BEGIN
        SELECT RAISE(ABORT, 'intentional item failure');
      END;
    `);
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [
          { menuItemId: 'beer', quantity: 1 },
          { menuItemId: 'edamame', quantity: 1 },
        ],
      })),
      ORDER_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(countRows(database, 'orders'), 0);
    assert.equal(countRows(database, 'order_items'), 0);
    assert.equal(countRows(database, 'event_log'), 0);
  });
});

test('same connection accepts a valid order after a rolled-back failure', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    database.exec(`
      CREATE TRIGGER test_one_failure
      BEFORE INSERT ON event_log
      BEGIN
        SELECT RAISE(ABORT, 'intentional event failure');
      END;
    `);
    assertOrderError(
      () => repository.createOrder(orderRequest()),
      ORDER_ERROR_CODES.DATABASE_FAILURE,
    );
    database.exec('DROP TRIGGER test_one_failure;');

    const result = repository.createOrder(orderRequest({ clientOrderId: CLIENT_ORDER_B }));
    assert.equal(result.idempotencyResult, 'created');
    assert.equal(result.order.orderId, ORDER_B);
    assert.equal(countRows(database, 'orders'), 1);
    assert.equal(countRows(database, 'event_log'), 1);
  });
});

test('two database connections processing the same clientOrderId leave one order', async () => {
  await withFixture(({ database, openAdditionalConnection }) => {
    const secondDatabase = openAdditionalConnection();
    const firstRepository = makeRepository(database, { orderIds: [ORDER_A] });
    const secondRepository = makeRepository(secondDatabase, { orderIds: [ORDER_B] });

    const created = firstRepository.createOrder(orderRequest());
    const replayed = secondRepository.createOrder(orderRequest());

    assert.equal(created.idempotencyResult, 'created');
    assert.equal(replayed.idempotencyResult, 'replayed');
    assert.equal(replayed.order.orderId, ORDER_A);
    assert.equal(countRows(secondDatabase, 'orders'), 1);
    assert.equal(countRows(secondDatabase, 'order_items'), 1);
    assert.equal(countRows(secondDatabase, 'event_log'), 1);
  });
});

test('parallel worker threads converge the same clientOrderId to one order', async () => {
  await withFixture(async ({ database, databasePath }) => {
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');

      (async () => {
        let connection;
        try {
          const [{ initializeDatabase }, { createOrderRepository }] = await Promise.all([
            import(workerData.databaseModuleUrl),
            import(workerData.repositoryModuleUrl),
          ]);
          connection = initializeDatabase({ databasePath: workerData.databasePath });
          const repository = createOrderRepository({
            database: connection.database,
            now: () => workerData.now,
            idFactory: () => workerData.orderId,
          });
          parentPort.postMessage({ kind: 'ready' });
          await new Promise((resolve) => parentPort.once('message', resolve));
          const result = repository.createOrder(workerData.request);
          parentPort.postMessage({
            kind: 'result',
            idempotencyResult: result.idempotencyResult,
            orderId: result.order.orderId,
          });
        } catch (error) {
          parentPort.postMessage({
            kind: 'error',
            code: error.code,
            message: error.message,
          });
        } finally {
          connection?.close();
        }
      })();
    `;

    const sharedData = {
      databasePath,
      databaseModuleUrl: new URL('../src/db/database.mjs', import.meta.url).href,
      repositoryModuleUrl: new URL('../src/orders/order-repository.mjs', import.meta.url).href,
      now: FIXED_NOW,
      request: orderRequest(),
    };
    const workers = [ORDER_A, ORDER_B].map((orderId) => new Worker(workerSource, {
      eval: true,
      workerData: { ...sharedData, orderId },
    }));

    try {
      const readyMessages = await Promise.all(workers.map(async (worker) => {
        const [message] = await once(worker, 'message');
        return message;
      }));
      assert.deepEqual(readyMessages.map(({ kind }) => kind), ['ready', 'ready']);

      const resultPromises = workers.map(async (worker) => {
        const [message] = await once(worker, 'message');
        return message;
      });
      for (const worker of workers) worker.postMessage({ kind: 'start' });
      const results = await Promise.all(resultPromises);

      assert.deepEqual(
        results.map(({ idempotencyResult }) => idempotencyResult).sort(),
        ['created', 'replayed'],
      );
      assert.equal(new Set(results.map(({ orderId }) => orderId)).size, 1);
      assert.equal(countRows(database, 'orders'), 1);
      assert.equal(countRows(database, 'order_items'), 1);
      assert.equal(countRows(database, 'event_log'), 1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});

test('conflicting reuse does not modify the existing order', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    const created = repository.createOrder(orderRequest());
    const before = database.prepare('SELECT * FROM orders').get();
    assertOrderError(
      () => repository.createOrder(orderRequest({
        items: [{ menuItemId: 'beer', quantity: 2 }],
      })),
      ORDER_ERROR_CODES.ORDER_CONFLICT,
    );
    const after = database.prepare('SELECT * FROM orders').get();
    assert.deepEqual(after, before);
    assert.equal(created.order.items[0].formalNameSnapshot, '枝豆（塩ゆで）');
    assert.equal(countRows(database, 'order_items'), 1);
    assert.equal(countRows(database, 'event_log'), 1);
  });
});

test('SQL injection-like menuItemId is bound as a value', async () => {
  await withFixture(({ database }) => {
    assertOrderError(
      () => makeRepository(database).createOrder(orderRequest({
        items: [{ menuItemId: "edamame' OR 1=1 --", quantity: 1 }],
      })),
      ORDER_ERROR_CODES.MENU_ITEM_NOT_FOUND,
    );
    assert.equal(countRows(database, 'orders'), 0);
    assert.equal(countRows(database, 'menu_items'), 4);
  });
});

test('order.created payload identifies the order and table without a token', async () => {
  await withFixture(({ database }) => {
    const result = makeRepository(database).createOrder(orderRequest());
    const event = database.prepare('SELECT * FROM event_log').get();
    assert.equal(event.aggregate_id, ORDER_A);
    assert.equal(event.actor_device_id, DEVICE_A);
    assert.deepEqual(JSON.parse(event.payload_json), {
      orderId: ORDER_A,
      tableId: 1,
      tableNumberSnapshot: 1,
      createdAtMs: FIXED_NOW,
    });
    assert.equal(event.payload_json.includes(tokenHash(1)), false);
    assert.equal(result.event.eventEpoch.length, 36);
  });
});

test('closed repository rejects further use without closing the supplied database', async () => {
  await withFixture(({ database }) => {
    const repository = makeRepository(database);
    repository.close();
    assertOrderError(
      () => repository.createOrder(orderRequest()),
      ORDER_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  });
});

test('default idFactory creates a valid UUID order id', async () => {
  await withFixture(({ database }) => {
    const repository = createOrderRepository({ database, now: () => FIXED_NOW });
    const result = repository.createOrder(orderRequest());
    assert.match(result.order.orderId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
