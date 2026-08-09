import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase } from '../src/db/database.mjs';
import {
  AUTH_ERROR_CODES,
  DeviceAuthError,
} from '../src/auth/auth-errors.mjs';
import {
  authorizeDeviceRole,
  createDeviceAuthenticator,
} from '../src/auth/device-auth.mjs';
import { createOrderRepository } from '../src/orders/order-repository.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tokenFor = (byte) => Buffer.alloc(32, byte).toString('base64url');
const digestFor = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const CUSTOMER_DEVICE_ID = uuid(701);
const KITCHEN_DEVICE_ID = uuid(702);
const ADMIN_DEVICE_ID = uuid(703);
const REVOKED_DEVICE_ID = uuid(704);
const ORDER_ID = uuid(705);
const CLIENT_ORDER_ID = uuid(706);

const CUSTOMER_TOKEN = tokenFor(0x11);
const KITCHEN_TOKEN = tokenFor(0x22);
const ADMIN_TOKEN = tokenFor(0x33);
const REVOKED_TOKEN = tokenFor(0x44);
const UNKNOWN_TOKEN = tokenFor(0x55);
const ROTATED_TOKEN = tokenFor(0x66);
const FIXED_NOW = 1_786_280_100_000;

function seedAuthFixture(database) {
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
    ) VALUES (?, ?, ?, ?, ?, 1000, 1500, ?, 1000, 2000)
  `);

  insertDevice.run(
    CUSTOMER_DEVICE_ID,
    'customer',
    '架空客席認証端末',
    digestFor(CUSTOMER_TOKEN),
    'active',
    null,
  );
  insertDevice.run(
    KITCHEN_DEVICE_ID,
    'kitchen',
    '架空厨房認証端末',
    digestFor(KITCHEN_TOKEN),
    'active',
    null,
  );
  insertDevice.run(
    ADMIN_DEVICE_ID,
    'admin',
    '架空管理認証端末',
    digestFor(ADMIN_TOKEN),
    'active',
    null,
  );
  insertDevice.run(
    REVOKED_DEVICE_ID,
    'customer',
    '架空失効認証端末',
    digestFor(REVOKED_TOKEN),
    'revoked',
    2000,
  );

  database.prepare(`
    INSERT INTO tables (
      table_id,
      label,
      assigned_customer_device_id,
      is_active,
      created_at_ms,
      updated_at_ms
    ) VALUES (1, 'テーブル1', ?, 1, 1000, 1000)
  `).run(CUSTOMER_DEVICE_ID);
}

async function withAuthFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-auth-test-'));
  const databasePath = join(directory, 'auth.sqlite3');
  const connection = initializeDatabase({ databasePath });

  try {
    seedAuthFixture(connection.database);
    await run({
      connection,
      database: connection.database,
      authenticator: createDeviceAuthenticator({ database: connection.database }),
      databasePath,
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

function assertAuthError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof DeviceAuthError && error.code === code,
  );
}

test('authenticates a valid customer token', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.equal(principal.role, 'customer');
  });
});

test('authenticates a valid kitchen token', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(KITCHEN_TOKEN);
    assert.equal(principal.role, 'kitchen');
  });
});

test('authenticates a valid admin token', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(ADMIN_TOKEN);
    assert.equal(principal.role, 'admin');
  });
});

test('principal identity and role come from the database', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.deepEqual(principal, {
      deviceId: CUSTOMER_DEVICE_ID,
      role: 'customer',
      tableId: 1,
      deviceLabel: '架空客席認証端末',
    });
  });
});

test('principal does not expose the raw token or token hash', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.deepEqual(Object.keys(principal).sort(), ['deviceId', 'deviceLabel', 'role', 'tableId']);
    assert.equal(JSON.stringify(principal).includes(CUSTOMER_TOKEN), false);
    assert.equal(JSON.stringify(principal).includes(digestFor(CUSTOMER_TOKEN)), false);
  });
});

test('principal is frozen against accidental mutation', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.equal(Object.isFrozen(principal), true);
    assert.throws(() => {
      principal.role = 'admin';
    }, TypeError);
    assert.equal(principal.role, 'customer');
  });
});

test('empty token is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    assertAuthError(
      () => authenticator.authenticateDeviceToken(''),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('null, undefined, and non-string tokens are rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    for (const token of [null, undefined, 123, {}, Buffer.alloc(32)]) {
      assertAuthError(
        () => authenticator.authenticateDeviceToken(token),
        AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
      );
    }
  });
});

test('short token is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    assertAuthError(
      () => authenticator.authenticateDeviceToken(CUSTOMER_TOKEN.slice(0, -1)),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('long token is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    assertAuthError(
      () => authenticator.authenticateDeviceToken(`${CUSTOMER_TOKEN}A`),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('token containing invalid base64url characters is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    const invalid = `${CUSTOMER_TOKEN.slice(0, -1)}+`;
    assert.equal(invalid.length, 43);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(invalid),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('non-canonical base64url encoding is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    const nonCanonical = `${CUSTOMER_TOKEN.slice(0, -1)}B`;
    assert.equal(Buffer.from(nonCanonical, 'base64url').length, 32);
    assert.notEqual(Buffer.from(nonCanonical, 'base64url').toString('base64url'), nonCanonical);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(nonCanonical),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('token with leading or trailing whitespace is rejected without trimming', async () => {
  await withAuthFixture(({ authenticator }) => {
    for (const token of [` ${CUSTOMER_TOKEN}`, `${CUSTOMER_TOKEN} `]) {
      assertAuthError(
        () => authenticator.authenticateDeviceToken(token),
        AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
      );
    }
  });
});

test('base64url token comparison is case-sensitive', async () => {
  await withAuthFixture(({ authenticator }) => {
    const firstCharacter = CUSTOMER_TOKEN[0];
    const changedCase = firstCharacter === firstCharacter.toUpperCase()
      ? firstCharacter.toLowerCase()
      : firstCharacter.toUpperCase();
    const caseChangedToken = `${changedCase}${CUSTOMER_TOKEN.slice(1)}`;
    assert.equal(caseChangedToken.length, 43);
    assert.notEqual(caseChangedToken, CUSTOMER_TOKEN);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(caseChangedToken),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('unregistered valid token is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    assertAuthError(
      () => authenticator.authenticateDeviceToken(UNKNOWN_TOKEN),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('device row without a token hash is rejected defensively', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-auth-null-hash-test-'));
  const databasePath = join(directory, 'nullable-token.sqlite3');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE devices (
        device_id TEXT,
        role TEXT,
        display_name TEXT,
        token_hash TEXT,
        status TEXT
      );
      CREATE TABLE tables (
        table_id INTEGER,
        assigned_customer_device_id TEXT
      );
    `);
    database.prepare(`
      INSERT INTO devices (device_id, role, display_name, token_hash, status)
      VALUES (?, 'customer', '架空hash未設定端末', NULL, 'active')
    `).run(CUSTOMER_DEVICE_ID);
    const authenticator = createDeviceAuthenticator({ database });
    assert.equal(database.prepare('SELECT token_hash FROM devices').get().token_hash, null);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(CUSTOMER_TOKEN),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('revoked device is rejected with the generic authentication error', async () => {
  await withAuthFixture(({ authenticator }) => {
    assertAuthError(
      () => authenticator.authenticateDeviceToken(REVOKED_TOKEN),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });
});

test('old token is rejected after token hash replacement', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    database.prepare('UPDATE devices SET token_hash = ? WHERE device_id = ?')
      .run(digestFor(ROTATED_TOKEN), CUSTOMER_DEVICE_ID);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(CUSTOMER_TOKEN),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    assert.equal(
      authenticator.authenticateDeviceToken(ROTATED_TOKEN).deviceId,
      CUSTOMER_DEVICE_ID,
    );
  });
});

test('customer is authorized by an explicit customer allow-list', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assert.equal(authorizeDeviceRole(principal, ['customer']), principal);
  });
});

test('customer is rejected by a kitchen-only allow-list', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assertAuthError(
      () => authorizeDeviceRole(principal, ['kitchen']),
      AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
    );
  });
});

test('kitchen is rejected by a customer-only allow-list', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(KITCHEN_TOKEN);
    assertAuthError(
      () => authorizeDeviceRole(principal, ['customer']),
      AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
    );
  });
});

test('admin is authorized only when admin is explicitly allowed', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(ADMIN_TOKEN);
    assert.equal(authorizeDeviceRole(principal, ['admin']), principal);
  });
});

test('admin does not inherit customer permission', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(ADMIN_TOKEN);
    assertAuthError(
      () => authorizeDeviceRole(principal, ['customer']),
      AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
    );
  });
});

test('multiple allowed roles still require an exact role match', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(KITCHEN_TOKEN);
    assert.equal(authorizeDeviceRole(principal, ['kitchen', 'admin']), principal);
  });
});

test('empty allowedRoles is rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assertAuthError(
      () => authorizeDeviceRole(principal, []),
      AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
    );
  });
});

test('invalid principal and invalid allowed role are rejected', async () => {
  await withAuthFixture(({ authenticator }) => {
    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    for (const candidate of [null, {}, { deviceId: CUSTOMER_DEVICE_ID, role: 'customer' }]) {
      assertAuthError(
        () => authorizeDeviceRole(candidate, ['customer']),
        AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
      );
    }
    assertAuthError(
      () => authorizeDeviceRole(principal, ['superadmin']),
      AUTH_ERROR_CODES.AUTHORIZATION_FAILED,
    );
  });
});

test('SQL injection-like token is rejected as an opaque value', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    const injection = "' OR 1=1 --".padEnd(43, 'A');
    assertAuthError(
      () => authenticator.authenticateDeviceToken(injection),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 4);
  });
});

test('successful and failed authentication do not modify device rows', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    const before = database.prepare('SELECT * FROM devices ORDER BY device_id').all();
    authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    assertAuthError(
      () => authenticator.authenticateDeviceToken(UNKNOWN_TOKEN),
      AUTH_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    const after = database.prepare('SELECT * FROM devices ORDER BY device_id').all();
    assert.deepEqual(after, before);
    assert.equal(after.find(({ device_id }) => device_id === CUSTOMER_DEVICE_ID).last_seen_at_ms, 1500);
  });
});

test('authentication error message contains neither raw token nor hash', async () => {
  await withAuthFixture(({ authenticator }) => {
    let caught;
    try {
      authenticator.authenticateDeviceToken(UNKNOWN_TOKEN);
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.code, AUTH_ERROR_CODES.AUTHENTICATION_FAILED);
    assert.equal(caught.message.includes(UNKNOWN_TOKEN), false);
    assert.equal(caught.message.includes(digestFor(UNKNOWN_TOKEN)), false);
    assert.equal(caught.message.includes('registered'), false);
  });
});

test('closed authenticator fails safely without closing the supplied database', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    authenticator.close();
    assertAuthError(
      () => authenticator.authenticateDeviceToken(CUSTOMER_TOKEN),
      AUTH_ERROR_CODES.DATABASE_FAILURE,
    );
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  });
});

test('authentication after database connection close maps to DATABASE_FAILURE', async () => {
  await withAuthFixture(({ connection, authenticator }) => {
    connection.close();
    assertAuthError(
      () => authenticator.authenticateDeviceToken(CUSTOMER_TOKEN),
      AUTH_ERROR_CODES.DATABASE_FAILURE,
    );
  });
});

test('SQLite read failure maps to a generic DATABASE_FAILURE', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    database.exec('ALTER TABLE devices RENAME TO unavailable_devices;');
    let caught;
    try {
      authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.code, AUTH_ERROR_CODES.DATABASE_FAILURE);
    assert.equal(caught.message, 'Device authentication storage is unavailable.');
    assert.equal(caught.message.includes('SELECT'), false);
    assert.equal(caught.message.includes('SQLite'), false);
  });
});

test('authenticated customer principal supplies the order repository device boundary', async () => {
  await withAuthFixture(({ database, authenticator }) => {
    database.exec(`
      INSERT INTO categories (
        category_id, name, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('recommended', 'おすすめ', 1, 1000, 1000);
      INSERT INTO menu_items (
        menu_item_id, category_id, formal_name, kitchen_alias, price_yen,
        sort_order, created_at_ms, updated_at_ms
      ) VALUES ('edamame', 'recommended', '枝豆（塩ゆで）', '枝豆', 380, 1, 1000, 1000);
    `);

    const principal = authenticator.authenticateDeviceToken(CUSTOMER_TOKEN);
    authorizeDeviceRole(principal, ['customer']);
    const repository = createOrderRepository({
      database,
      now: () => FIXED_NOW,
      idFactory: () => ORDER_ID,
    });
    const result = repository.createOrder({
      clientOrderId: CLIENT_ORDER_ID,
      authenticatedDeviceId: principal.deviceId,
      items: [{ menuItemId: 'edamame', quantity: 1 }],
    });

    assert.equal(result.idempotencyResult, 'created');
    assert.equal(result.order.authenticatedDeviceId, principal.deviceId);
    assert.equal(result.order.tableId, 1);
  });
});
