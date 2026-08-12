import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_SCHEMA_PATH, initializeDatabase } from '../src/db/database.mjs';

const EXPECTED_TABLES = [
  'system_state',
  'devices',
  'tables',
  'pairing_codes',
  'categories',
  'menu_items',
  'orders',
  'order_items',
  'staff_calls',
  'event_log',
  'registration_requests',
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
  'idx_order_items_order_served',
  'uq_order_items_order_menu',
  'idx_staff_calls_status_created',
  'idx_staff_calls_table_status',
  'idx_event_log_type_event',
  'idx_event_log_aggregate',
  'idx_registration_requests_status_expiry',
  'uq_registration_requests_live_device',
  'uq_registration_requests_live_secret_hash',
  'uq_registration_requests_approved_table',
];

const EXPECTED_TRIGGERS = [
  'trg_tables_assignment_insert_valid',
  'trg_tables_assignment_update_valid',
  'trg_orders_server_assignment_insert',
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
    await removeDirectoryWithRetry(directory);
  }
}

async function removeDirectoryWithRetry(directory) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
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
    const databasePath = join(directory, 'version-3.sqlite3');
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

test('v1 data is preserved when the v2 migration is applied', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    mkdirSync(dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'));
    seedOrderParents(legacy);
    insertOrder(legacy);
    const eventEpoch = legacy.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get().event_epoch;
    legacy.prepare(`
      INSERT INTO event_log (
        event_epoch, event_type, aggregate_type, aggregate_id,
        actor_device_id, payload_json, created_at_ms
      ) VALUES (?, 'order.created', 'order', ?, ?, '{}', 2000)
    `).run(eventEpoch, ORDER_ID, CUSTOMER_DEVICE_ID);
    legacy.close();

    const migrated = initializeDatabase({ databasePath });
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(pragmaValue(migrated.database, 'user_version'), 2);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM tables').get().count, 1);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, 1);
    assert.equal(migrated.database.prepare('SELECT COUNT(*) AS count FROM registration_requests').get().count, 0);
    migrated.close();
  });
});

test('v2 migration is idempotent after the first successful application', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    mkdirSync(dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'));
    legacy.close();

    initializeDatabase({ databasePath }).close();
    const reopened = initializeDatabase({ databasePath });
    assert.equal(reopened.schemaVersion, 2);
    assert.equal(pragmaValue(reopened.database, 'user_version'), 2);
    assert.equal(reopened.database.prepare('SELECT COUNT(*) AS count FROM registration_requests').get().count, 0);
    reopened.close();
  });
});

test('a failed v2 migration rolls back and can be retried safely', async () => {
  await withTemporaryDatabase(({ directory, databasePath }) => {
    mkdirSync(dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'));
    legacy.close();

    const invalidMigrationPath = join(directory, 'invalid-v2.sql');
    writeFileSync(
      invalidMigrationPath,
      'BEGIN IMMEDIATE; CREATE TABLE migration_marker (id INTEGER); THIS IS INVALID SQL; COMMIT;',
    );

    assert.throws(
      () => initializeDatabase({ databasePath, migrationV2Path: invalidMigrationPath }),
      (error) => error.code === 'INITIALIZATION_FAILED',
    );

    const afterFailure = new DatabaseSync(databasePath);
    assert.equal(pragmaValue(afterFailure, 'user_version'), 1);
    assert.equal(schemaNames(afterFailure, 'table').has('migration_marker'), false);
    assert.equal(schemaNames(afterFailure, 'table').has('registration_requests'), false);
    afterFailure.close();

    const retried = initializeDatabase({ databasePath });
    assert.equal(retried.schemaVersion, 2);
    retried.close();
  });
});

test('the returned close method is idempotent', async () => {
  await withTemporaryDatabase(({ databasePath }) => {
    const connection = initializeDatabase({ databasePath });
    connection.close();
    assert.doesNotThrow(() => connection.close());
  });
});
