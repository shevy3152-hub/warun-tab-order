import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase } from '../src/db/database.mjs';

const EXPECTED_TABLES = [
  'system_state',
  'devices',
  'tables',
  'pairing_codes',
  'categories',
  'menu_items',
  'table_sessions',
  'orders',
  'order_items',
  'staff_calls',
  'event_log',
];

const EXPECTED_INDEXES = [
  'idx_devices_status_role',
  'idx_pairing_codes_expiry_unused',
  'idx_categories_visible_sort',
  'idx_menu_items_category_sort',
  'idx_menu_items_sold_out',
  'idx_orders_status_accepted',
  'idx_orders_table_status',
  'idx_orders_customer_device',
  'idx_table_sessions_table_opened',
  'uq_table_sessions_open_table',
  'idx_order_items_order_served',
  'uq_order_items_order_menu',
  'idx_staff_calls_status_created',
  'idx_staff_calls_table_status',
  'idx_event_log_type_event',
  'idx_event_log_aggregate',
];

const EXPECTED_TRIGGERS = [
  'trg_tables_assignment_insert_valid',
  'trg_tables_assignment_update_valid',
  'trg_orders_server_assignment_insert',
  'trg_orders_session_valid_insert',
  'trg_orders_session_immutable',
  'trg_table_sessions_immutable_origin',
  'trg_staff_calls_server_assignment_insert',
  'trg_event_log_current_epoch',
  'trg_orders_immutable_identity',
  'trg_order_items_immutable_snapshots',
  'trg_completed_order_items_read_only',
  'trg_staff_calls_immutable_origin',
];

async function withTemporaryDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-sqlite-test-'));
  const databasePath = join(directory, 'nested', 'orders.sqlite3');

  try {
    await run({ directory, databasePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pragmaValue(database, name) {
  return Object.values(database.prepare(`PRAGMA ${name}`).get())[0];
}

function schemaNames(database, type) {
  return new Set(
    database
      .prepare('SELECT name FROM sqlite_schema WHERE type = ?')
      .all(type)
      .map(({ name }) => name),
  );
}

const CUSTOMER_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ORDER_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_ORDER_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_CLIENT_ORDER_ID = '55555555-5555-4555-8555-555555555555';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function seedOrderParents(database) {
  database.exec(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, paired_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${CUSTOMER_DEVICE_ID}', 'customer', 'テーブル1端末', '${HASH_A}', 1000, 1000, 1000
    );

    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, created_at_ms, updated_at_ms
    ) VALUES (1, 'テーブル1', '${CUSTOMER_DEVICE_ID}', 1000, 1000);

    INSERT INTO categories (
      category_id, name, sort_order, created_at_ms, updated_at_ms
    ) VALUES ('recommended', 'おすすめ', 1, 1000, 1000);

    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, price_yen,
      sort_order, created_at_ms, updated_at_ms
    ) VALUES ('edamame', 'recommended', '枝豆（塩ゆで）', '枝豆', 380, 1, 1000, 1000);
  `);
}

function insertOrder(
  database,
  {
    orderId = ORDER_ID,
    clientOrderId = CLIENT_ORDER_ID,
    fingerprint = HASH_B,
    status = 'new',
  } = {},
) {
  database.exec(`
    INSERT INTO orders (
      order_id, client_order_id, request_fingerprint, canonical_request_json,
      customer_device_id, table_id, table_number_snapshot, status,
      total_amount_yen, accepted_at_ms
    ) VALUES (
      '${orderId}', '${clientOrderId}', '${fingerprint}', '{"items":[{"id":"edamame","quantity":1}]}',
      '${CUSTOMER_DEVICE_ID}', 1, 1, '${status}', 380, 2000
    );
  `);
}

function legacySchemaSql() {
  let schema = readFileSync(new URL('../../docs/schema-v1.sql', import.meta.url), 'utf8');
  schema = schema.replace(/CREATE TABLE table_sessions [\s\S]*?\n\);\n\n(?=CREATE TABLE orders)/, '');
  schema = schema.replace('  session_id TEXT,\n', '');
  schema = schema.replace(
    '  FOREIGN KEY (session_id) REFERENCES table_sessions(session_id)\n    ON UPDATE RESTRICT ON DELETE RESTRICT,\n',
    '',
  );
  schema = schema.replace(
    'CREATE INDEX idx_table_sessions_table_opened\n  ON table_sessions (table_id, opened_at_ms, session_id);\nCREATE UNIQUE INDEX uq_table_sessions_open_table\n  ON table_sessions (table_id)\n  WHERE closed_at_ms IS NULL;\n',
    '',
  );
  schema = schema.replace(/CREATE TRIGGER trg_orders_session_valid_insert[\s\S]*?END;\n\n/, '');
  schema = schema.replace(/CREATE TRIGGER trg_orders_session_immutable[\s\S]*?END;\n\n/, '');
  schema = schema.replace(/CREATE TRIGGER trg_table_sessions_immutable_origin[\s\S]*?END;\n\n/, '');
  return schema;
}

test('new database creates its parent directory and applies schema v2', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(existsSync(databasePath), true);
    assert.equal(connection.schemaVersion, 2);
    connection.close();
  });
});

test('new database records PRAGMA user_version = 2', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(pragmaValue(connection.database, 'user_version'), 2);
    connection.close();
  });
});

test('schema contains every required table', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    const names = schemaNames(connection.database, 'table');
    for (const name of EXPECTED_TABLES) assert.equal(names.has(name), true, name);
    connection.close();
  });
});

test('schema contains every required explicit index', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    const names = schemaNames(connection.database, 'index');
    for (const name of EXPECTED_INDEXES) assert.equal(names.has(name), true, name);
    connection.close();
  });
});

test('schema contains every required trigger', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    const names = schemaNames(connection.database, 'trigger');
    for (const name of EXPECTED_TRIGGERS) assert.equal(names.has(name), true, name);
    connection.close();
  });
});

test('foreign key enforcement is enabled on the returned connection', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(pragmaValue(connection.database, 'foreign_keys'), 1);
    connection.close();
  });
});

test('busy timeout is 5000 milliseconds on the returned connection', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(pragmaValue(connection.database, 'busy_timeout'), 5000);
    connection.close();
  });
});

test('journal mode is WAL', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(String(pragmaValue(connection.database, 'journal_mode')).toLowerCase(), 'wal');
    connection.close();
  });
});

test('synchronous mode is FULL', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.equal(pragmaValue(connection.database, 'synchronous'), 2);
    connection.close();
  });
});

test('a valid schema v2 database can be closed and reopened', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    initializeDatabase({ databasePath }).close();
    const reopened = initializeDatabase({ databasePath });
    assert.equal(reopened.schemaVersion, 2);
    reopened.close();
  });
});

test('reopening schema v2 preserves existing data', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const first = initializeDatabase({ databasePath });
    first.database.exec(`
      INSERT INTO categories (
        category_id, name, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('beer', 'ビール', 2, 1000, 1000);
    `);
    const epoch = first.database.prepare('SELECT event_epoch FROM system_state').get().event_epoch;
    first.close();

    const reopened = initializeDatabase({ databasePath });
    assert.equal(
      reopened.database.prepare("SELECT name FROM categories WHERE category_id = 'beer'").get().name,
      'ビール',
    );
    assert.equal(reopened.database.prepare('SELECT event_epoch FROM system_state').get().event_epoch, epoch);
    reopened.close();
  });
});

test('legacy schema v1 migrates to schema v2 and assigns existing orders to one open table session', async () => {
  await withTemporaryDatabase(({ directory }) => {
    const legacyPath = join(directory, 'legacy.sqlite3');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(legacySchemaSql());
    seedOrderParents(legacy);
    insertOrder(legacy);
    const eventEpoch = legacy.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get().event_epoch;
    legacy.prepare(`
      INSERT INTO order_items (
        order_id, line_index, menu_item_id, formal_name_snapshot,
        kitchen_alias_snapshot, unit_price_yen_snapshot, quantity,
        line_total_yen, created_at_ms, updated_at_ms
      ) VALUES (?, 0, 'edamame', '枝豆（塩ゆで）', '枝豆', 380, 1, 380, 2000, 2000)
    `).run(ORDER_ID);
    legacy.prepare(`
      INSERT INTO event_log (
        event_epoch, event_type, aggregate_type, aggregate_id,
        actor_device_id, payload_json, created_at_ms
      ) VALUES (?, 'order.created', 'order', ?, ?, '{"orderId":"${ORDER_ID}"}', 2000)
    `).run(eventEpoch, ORDER_ID, CUSTOMER_DEVICE_ID);
    const countsBefore = {
      orders: legacy.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: legacy.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: legacy.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    };
    legacy.close();

    const connection = initializeDatabase({ databasePath: legacyPath });
    const session = connection.database.prepare(`
      SELECT session_id, table_id, opened_at_ms, closed_at_ms
      FROM table_sessions
      WHERE table_id = 1
    `).get();
    const order = connection.database.prepare(`
      SELECT session_id, accepted_at_ms
      FROM orders
      WHERE order_id = ?
    `).get(ORDER_ID);

    assert.equal(connection.schemaVersion, 2);
    assert.equal(pragmaValue(connection.database, 'user_version'), 2);
    assert.equal(connection.database.prepare('SELECT schema_version FROM system_state').get().schema_version, 2);
    assert.deepEqual({
      orders: connection.database.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
      orderItems: connection.database.prepare('SELECT COUNT(*) AS count FROM order_items').get().count,
      events: connection.database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count,
    }, countsBefore);
    assert.equal(connection.database.prepare('SELECT COUNT(*) AS count FROM table_sessions').get().count, 1);
    assert.equal(connection.database.prepare('SELECT formal_name_snapshot FROM order_items WHERE order_id = ?').get(ORDER_ID).formal_name_snapshot, '枝豆（塩ゆで）');
    assert.equal(connection.database.prepare('SELECT payload_json FROM event_log WHERE aggregate_id = ?').get(ORDER_ID).payload_json, `{"orderId":"${ORDER_ID}"}`);
    assert.equal(session.session_id, order.session_id);
    assert.equal(session.table_id, 1);
    assert.equal(session.opened_at_ms, order.accepted_at_ms);
    assert.equal(session.closed_at_ms, null);
    connection.close();
  });
});

test('duplicate client_order_id violates the idempotency UNIQUE constraint', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    seedOrderParents(connection.database);
    insertOrder(connection.database);
    assert.throws(
      () => insertOrder(connection.database, { orderId: SECOND_ORDER_ID }),
      /UNIQUE constraint failed/,
    );
    connection.close();
  });
});

test('foreign key violations are rejected', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    assert.throws(
      () => connection.database.exec(`
        INSERT INTO menu_items (
          menu_item_id, category_id, formal_name, kitchen_alias, price_yen,
          sort_order, created_at_ms, updated_at_ms
        ) VALUES ('invalid', 'missing', '不正商品', '不正', 100, 1, 1000, 1000);
      `),
      /FOREIGN KEY constraint failed/,
    );
    connection.close();
  });
});

test('invalid status values are rejected by CHECK constraints', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    seedOrderParents(connection.database);
    assert.throws(
      () => insertOrder(connection.database, { status: 'cooking' }),
      /CHECK constraint failed/,
    );
    connection.close();
  });
});

test('invalid item quantities are rejected by CHECK constraints', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    seedOrderParents(connection.database);
    insertOrder(connection.database);
    assert.throws(
      () => connection.database.exec(`
        INSERT INTO order_items (
          order_id, line_index, menu_item_id, formal_name_snapshot,
          kitchen_alias_snapshot, unit_price_yen_snapshot, quantity,
          line_total_yen, created_at_ms, updated_at_ms
        ) VALUES (
          '${ORDER_ID}', 0, 'edamame', '枝豆（塩ゆで）', '枝豆', 380, 0, 0, 2000, 2000
        );
      `),
      /CHECK constraint failed/,
    );
    connection.close();
  });
});

test('schema versions newer than v2 are rejected without migration', async () => {
  await withTemporaryDatabase(({ directory }) => {
    const databasePath = join(directory, 'version-2.sqlite3');
    const raw = new DatabaseSync(databasePath);
    raw.exec('PRAGMA user_version = 3;');
    raw.close();

    assert.throws(
      () => initializeDatabase({ databasePath }),
      (error) => error.code === 'UNSUPPORTED_SCHEMA_VERSION',
    );
  });
});

test('unversioned databases containing user tables are rejected', async () => {
  await withTemporaryDatabase(({ directory }) => {
    const databasePath = join(directory, 'unversioned.sqlite3');
    const raw = new DatabaseSync(databasePath);
    raw.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY);');
    raw.close();

    assert.throws(
      () => initializeDatabase({ databasePath }),
      (error) => error.code === 'UNVERSIONED_DATABASE',
    );
  });
});

test('incomplete databases claiming schema v1 are rejected', async () => {
  await withTemporaryDatabase(({ directory }) => {
    const databasePath = join(directory, 'incomplete-v1.sqlite3');
    const raw = new DatabaseSync(databasePath);
    raw.exec('CREATE TABLE system_state (singleton_id INTEGER); PRAGMA user_version = 1;');
    raw.close();

    assert.throws(
      () => initializeDatabase({ databasePath }),
      (error) => error.code === 'SCHEMA_INCOMPLETE',
    );
  });
});

test('a schema application failure closes the database file', async () => {
  await withTemporaryDatabase(({ directory, databasePath }) => {
    const schemaPath = join(directory, 'invalid-schema.sql');
    writeFileSync(schemaPath, 'BEGIN; CREATE TABLE partial (id INTEGER); INVALID SQL;');

    assert.throws(
      () => initializeDatabase({ databasePath, schemaPath }),
      (error) => error.code === 'INITIALIZATION_FAILED',
    );

    const movedPath = join(directory, 'released.sqlite3');
    assert.doesNotThrow(() => renameSync(databasePath, movedPath));
    const raw = new DatabaseSync(movedPath);
    raw.close();
  });
});

test('the returned close method is idempotent', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    connection.close();
    assert.doesNotThrow(() => connection.close());
  });
});
