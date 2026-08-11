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
