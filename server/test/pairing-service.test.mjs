import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeDatabase } from '../src/db/database.mjs';
import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createPairingService, PAIRING_ERROR_CODES } from '../src/pairing/pairing-service.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (byte) => Buffer.alloc(32, byte).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'warun-pairing-'));
  const databasePath = join(dir, 'test.sqlite3');
  let db;
  try {
    const connection = initializeDatabase({ databasePath });
    db = connection.database;
    const adminId = uuid(1);
    db.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'admin', 'Admin', ?, 'active', 1, 1, 1)`).run(adminId, hash(token(1)));
    db.prepare(`INSERT INTO tables (table_id, label, is_active, version, created_at_ms, updated_at_ms) VALUES (1, 'Table 1', 1, 1, 1, 1)`).run();
    await run({ db, adminId, service: createPairingService({ database: db, now: () => 100000 }) });
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('pairing code is hashed, claim is one-shot, and token revocation works', async () => fixture(async ({ db, adminId, service }) => {
  const created = service.createPairingCodeRequest({ role: 'customer', tableId: 1, expiresAtMs: 200000 }, { createdByDeviceId: adminId });
  assert.throws(() => service.createPairingCodeRequest({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId }, { createdByDeviceId: adminId }), (error) => error.code === PAIRING_ERROR_CODES.INVALID_REQUEST);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_codes WHERE code_hash = ?').get(hash(created.code)).count, 1);
  const deviceId = uuid(2);
  const claimed = service.claimPairingCode({ pairingCode: created.code, deviceId, displayName: 'A90', appVersion: 'test' });
  assert.equal(claimed.tableId, 1);
  assert.notEqual(db.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get(deviceId).token_hash, claimed.deviceToken);
  assert.throws(() => service.claimPairingCode({ pairingCode: created.code, deviceId: uuid(3), displayName: 'Other', appVersion: 'test' }), (error) => error.code === PAIRING_ERROR_CODES.CODE_USED);
  const auth = createDeviceAuthenticator({ database: db });
  assert.equal(auth.authenticateDeviceToken(claimed.deviceToken).deviceId, deviceId);
  service.revokeDevice({ deviceId, actorDeviceId: adminId });
  assert.throws(() => auth.authenticateDeviceToken(claimed.deviceToken));
}));

test('expiry, table conflict, duplicate device and attempt limit are rejected', async () => fixture(async ({ service, adminId, db }) => {
  const expired = service.createPairingCode({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId });
  const later = createPairingService({ database: db, now: () => 300000 });
  assert.throws(() => later.claimPairingCode({ pairingCode: expired.code, deviceId: uuid(4), displayName: 'A90', appVersion: 'test' }), (error) => error.code === PAIRING_ERROR_CODES.CODE_EXPIRED);
  const code = service.createPairingCode({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId });
  const occupied = uuid(5);
  db.prepare('INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, \'customer\', \'Existing\', ?, \'active\', 1, 1, 1)').run(occupied, hash(token(5)));
  db.prepare('UPDATE tables SET assigned_customer_device_id = ? WHERE table_id = 1').run(occupied);
  assert.throws(() => service.claimPairingCode({ pairingCode: code.code, deviceId: uuid(6), displayName: 'A90', appVersion: 'test' }), (error) => error.code === PAIRING_ERROR_CODES.TABLE_CONFLICT);
  db.prepare('UPDATE tables SET assigned_customer_device_id = NULL WHERE table_id = 1').run();
  const duplicate = uuid(7);
  db.prepare('INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, \'customer\', \'Duplicate\', ?, \'active\', 1, 1, 1)').run(duplicate, hash(token(7)));
  const code2 = service.createPairingCode({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId });
  assert.throws(() => service.claimPairingCode({ pairingCode: code2.code, deviceId: duplicate, displayName: 'A90', appVersion: 'test' }), (error) => error.code === PAIRING_ERROR_CODES.DEVICE_CONFLICT);
}));

test('revoked customer device IDs are reactivated without changing order data', async () => fixture(async ({ service, adminId, db }) => {
  const protectedCountsBefore = Object.fromEntries(['orders', 'order_items', 'event_log'].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  for (const [status, deviceNumber, byte] of [['revoked', 8, 0x48]]) {
    const deviceId = uuid(deviceNumber);
    db.prepare(`
      INSERT INTO devices (
        device_id, role, display_name, token_hash, status, app_version,
        paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'customer', ?, ?, ?, 'old', 10, ?, 10, 10)
    `).run(deviceId, 'Old A90', hash(token(byte)), status, status === 'revoked' ? 20 : null);
    const code = service.createPairingCode({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId });
    const claimed = service.claimPairingCode({ pairingCode: code.code, deviceId, displayName: `${status} A90`, appVersion: 'new' });
    const row = db.prepare('SELECT role, display_name, token_hash, status, app_version, paired_at_ms, revoked_at_ms, created_at_ms FROM devices WHERE device_id = ?').get(deviceId);
    assert.equal(claimed.deviceId, deviceId);
    assert.equal(row.role, 'customer');
    assert.equal(row.display_name, `${status} A90`);
    assert.equal(row.token_hash, hash(claimed.deviceToken));
    assert.equal(row.status, 'active');
    assert.equal(row.app_version, 'new');
    assert.equal(row.paired_at_ms, 100000);
    assert.equal(row.revoked_at_ms, null);
    assert.equal(row.created_at_ms, 10);
    assert.equal(db.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 1').get().assigned_customer_device_id, deviceId);
    assert.equal(db.prepare('SELECT used_by_device_id FROM pairing_codes WHERE code_hash = ?').get(hash(code.code)).used_by_device_id, deviceId);
    db.prepare('UPDATE tables SET assigned_customer_device_id = NULL WHERE table_id = 1').run();
  }
  assert.deepEqual(Object.fromEntries(['orders', 'order_items', 'event_log'].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count])), protectedCountsBefore);
}));

test('reactivation never replaces a different active device on the target table', async () => fixture(async ({ service, adminId, db }) => {
  const oldDeviceId = uuid(10);
  const activeDeviceId = uuid(11);
  db.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, revoked_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'customer', 'Revoked A90', ?, 'revoked', 1, 2, 1, 1)`).run(oldDeviceId, hash(token(10)));
  const code = service.createPairingCode({ role: 'customer', tableId: 1, expiresAtMs: 200000, createdByDeviceId: adminId });
  db.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'customer', 'Active A90', ?, 'active', 1, 1, 1)`).run(activeDeviceId, hash(token(11)));
  db.prepare('UPDATE tables SET assigned_customer_device_id = ? WHERE table_id = 1').run(activeDeviceId);
  assert.throws(
    () => service.claimPairingCode({ pairingCode: code.code, deviceId: oldDeviceId, displayName: 'Reused A90', appVersion: 'test' }),
    (error) => error.code === PAIRING_ERROR_CODES.TABLE_CONFLICT,
  );
  assert.equal(db.prepare('SELECT status FROM devices WHERE device_id = ?').get(oldDeviceId).status, 'revoked');
  assert.equal(db.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 1').get().assigned_customer_device_id, activeDeviceId);
  assert.equal(db.prepare('SELECT used_by_device_id FROM pairing_codes WHERE code_hash = ?').get(hash(code.code)).used_by_device_id, null);
}));
