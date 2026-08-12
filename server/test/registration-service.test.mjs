import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeDatabase } from '../src/db/database.mjs';
import {
  createRegistrationService,
  REGISTRATION_ERROR_CODES,
} from '../src/registration/registration-service.mjs';

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN_TOKEN = randomBytes(32).toString('base64url');
const SECRET_A = randomBytes(32).toString('base64url');
const SECRET_B = randomBytes(32).toString('base64url');

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fixture(run, { start = 1_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-registration-'));
  let time = start;
  const connection = initializeDatabase({ databasePath: join(directory, 'registration.sqlite3') });
  const db = connection.database;
  db.prepare(`
    INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, 'admin', 'Test admin', ?, 'active', ?, ?, ?)
  `).run(ADMIN_ID, hash(ADMIN_TOKEN), time, time, time);
  db.prepare(`
    INSERT INTO tables (table_id, label, is_active, created_at_ms, updated_at_ms)
    VALUES (1, 'Table 1', 1, ?, ?), (2, 'Table 2', 1, ?, ?)
  `).run(time, time, time, time);
  const service = createRegistrationService({ database: db, now: () => time });
  try {
    await run({ db, service, setTime: (next) => { time = next; } });
  } finally {
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('creates a pending request with only the secret hash persisted', async () => {
  await fixture(({ db, service }) => {
    const created = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    assert.equal(created.status, 'pending');
    assert.equal(db.prepare('SELECT request_secret_hash FROM registration_requests WHERE request_id = ?').get(created.requestId).request_secret_hash, hash(SECRET_A));
    assert.doesNotMatch(JSON.stringify(created), new RegExp(SECRET_A));
    assert.deepEqual(service.listRequests().map((item) => item.status), ['pending']);
  });
});

test('repeating the same request secret returns the original pending request safely', async () => {
  await fixture(({ service, db }) => {
    const first = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    const repeated = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    assert.equal(repeated.requestId, first.requestId);
    assert.equal(repeated.status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM registration_requests').get().count, 1);
  });
});

test('admin approval reserves the selected table and is one-shot', async () => {
  await fixture(({ service }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    const approved = service.approveRequest({ requestId: request.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID });
    assert.equal(approved.status, 'approved');
    assert.throws(() => service.approveRequest({ requestId: request.requestId, tableId: 2 }, { approvedByDeviceId: ADMIN_ID }), (error) => error.code === REGISTRATION_ERROR_CODES.ALREADY_APPROVED);
  });
});

test('claim creates the customer assignment and returns the token only once', async () => {
  await fixture(({ db, service }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    service.approveRequest({ requestId: request.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID });
    const claimed = service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_A });
    assert.equal(claimed.tableId, 1);
    assert.equal(db.prepare('SELECT status FROM registration_requests WHERE request_id = ?').get(request.requestId).status, 'claimed');
    assert.equal(db.prepare('SELECT assigned_customer_device_id FROM tables WHERE table_id = 1').get().assigned_customer_device_id, CUSTOMER_ID);
    assert.equal(db.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get(CUSTOMER_ID).token_hash, hash(claimed.deviceToken));
    assert.doesNotMatch(JSON.stringify({ request, claimed, rows: db.prepare('SELECT * FROM registration_requests').all() }), new RegExp(SECRET_A));
    assert.throws(() => service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_A }), (error) => error.code === REGISTRATION_ERROR_CODES.CLAIMED);
  });
});

test('pending claim is rejected and wrong secrets do not reveal request state', async () => {
  await fixture(({ service }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    assert.throws(() => service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_B }), (error) => error.code === REGISTRATION_ERROR_CODES.NOT_FOUND);
    assert.throws(() => service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_A }), (error) => error.code === REGISTRATION_ERROR_CODES.NOT_APPROVED);
  });
});

test('expired requests cannot be approved or claimed', async () => {
  await fixture(async ({ service, setTime }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    setTime(request.expiresAtMs);
    assert.throws(() => service.approveRequest({ requestId: request.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID }), (error) => error.code === REGISTRATION_ERROR_CODES.EXPIRED);
    assert.throws(() => service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_A }), (error) => error.code === REGISTRATION_ERROR_CODES.EXPIRED);
  });
});

test('expired requests remain auditable and the same device can create a fresh request', async () => {
  await fixture(({ db, service, setTime }) => {
    const first = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    setTime(first.expiresAtMs);
    const second = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90 retry', appVersion: 'test' });
    assert.notEqual(second.requestId, first.requestId);
    assert.equal(second.status, 'pending');
    assert.equal(db.prepare('SELECT status FROM registration_requests WHERE request_id = ?').get(first.requestId).status, 'expired');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM registration_requests').get().count, 2);
  });
});

test('cancelled requests remain auditable and can be recreated with the same secret', async () => {
  await fixture(({ db, service }) => {
    const first = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    db.prepare("UPDATE registration_requests SET status = 'cancelled' WHERE request_id = ?").run(first.requestId);
    const second = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90 retry', appVersion: 'test' });
    assert.notEqual(second.requestId, first.requestId);
    assert.equal(second.status, 'pending');
    assert.equal(db.prepare('SELECT status FROM registration_requests WHERE request_id = ?').get(first.requestId).status, 'cancelled');
  });
});

test('table conflict is checked during approval and claim', async () => {
  await fixture(({ db, service }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    db.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'customer', 'Existing', ?, 'active', 1, 1, 1)`).run(SECOND_CUSTOMER_ID, hash(SECRET_B));
    db.prepare('UPDATE tables SET assigned_customer_device_id = ? WHERE table_id = 1').run(SECOND_CUSTOMER_ID);
    assert.throws(() => service.approveRequest({ requestId: request.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID }), (error) => error.code === REGISTRATION_ERROR_CODES.TABLE_CONFLICT);
  });
});

test('device ids cannot create or claim duplicate registrations', async () => {
  await fixture(({ service }) => {
    service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    assert.throws(() => service.createRequest({ requestSecret: SECRET_B, deviceId: CUSTOMER_ID, displayName: 'A90 again', appVersion: 'test' }), (error) => error.code === REGISTRATION_ERROR_CODES.DEVICE_CONFLICT);
  });
});

test('claimed device ids cannot create a new registration request', async () => {
  await fixture(({ service }) => {
    const request = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90', appVersion: 'test' });
    service.approveRequest({ requestId: request.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID });
    service.claimRequest({ requestId: request.requestId, requestSecret: SECRET_A });
    assert.throws(
      () => service.createRequest({ requestSecret: SECRET_B, deviceId: CUSTOMER_ID, displayName: 'A90 again', appVersion: 'test' }),
      (error) => error.code === REGISTRATION_ERROR_CODES.DEVICE_CONFLICT,
    );
  });
});

test('concurrent retry attempts leave one live request for a device', async () => {
  await fixture(async ({ service, db }) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90 one', appVersion: 'test' })),
      Promise.resolve().then(() => service.createRequest({ requestSecret: SECRET_B, deviceId: CUSTOMER_ID, displayName: 'A90 two', appVersion: 'test' })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === REGISTRATION_ERROR_CODES.DEVICE_CONFLICT).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_requests WHERE status IN ('pending', 'approved')").get().count, 1);
  });
});

test('two devices racing for one table leave exactly one approved request', async () => {
  await fixture(async ({ service, db }) => {
    const first = service.createRequest({ requestSecret: SECRET_A, deviceId: CUSTOMER_ID, displayName: 'A90 one', appVersion: 'test' });
    const second = service.createRequest({ requestSecret: SECRET_B, deviceId: SECOND_CUSTOMER_ID, displayName: 'A90 two', appVersion: 'test' });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => service.approveRequest({ requestId: first.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID })),
      Promise.resolve().then(() => service.approveRequest({ requestId: second.requestId, tableId: 1 }, { approvedByDeviceId: ADMIN_ID })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === REGISTRATION_ERROR_CODES.TABLE_CONFLICT).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM registration_requests WHERE status = 'approved'").get().count, 1);
  });
});
