import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../src/db/database.mjs';
import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { ensureAdminRuntime } from '../src/bootstrap/admin-runtime.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-admin-runtime-'));
  const connection = initializeDatabase({ databasePath: join(directory, 'store.sqlite3') });
  try {
    await run({ database: connection.database, tokenFilePath: join(directory, 'runtime', 'admin-token') });
  } finally {
    connection.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('auto-provision creates one reusable admin and default customer tables', async () => fixture(async ({ database, tokenFilePath }) => {
  const first = ensureAdminRuntime({ database, tokenFilePath, autoProvision: true, now: () => 1000 });
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices WHERE role = 'admin' AND status = 'active'").get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tables').get().count, 4);
  const saved = await readFile(tokenFilePath, 'utf8');
  assert.equal(saved.trim(), first.token);

  const second = ensureAdminRuntime({ database, tokenFilePath, autoProvision: true, now: () => 2000 });
  assert.equal(second.token, first.token);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM devices WHERE role = 'admin' AND status = 'active'").get().count, 1);

  const authenticator = createDeviceAuthenticator({ database });
  try {
    assert.equal(authenticator.authenticateDeviceToken(first.token).deviceId, first.deviceId);
  } finally {
    authenticator.close();
  }
}));

test('configured token is used without exposing it in the database as raw text', async () => fixture(async ({ database, tokenFilePath }) => {
  const configuredToken = Buffer.alloc(32, 7).toString('base64url');
  const result = ensureAdminRuntime({ database, tokenFilePath, configuredToken, autoProvision: true, now: () => 1000 });
  assert.equal(result.token, configuredToken);
  const row = database.prepare('SELECT token_hash FROM devices WHERE device_id = ?').get(result.deviceId);
  assert.equal(row.token_hash.includes(configuredToken), false);
  assert.equal((await readFile(tokenFilePath, 'utf8')).trim(), configuredToken);
}));

test('auto-provision is opt-in and preserves the existing no-token behavior', async () => fixture(async ({ database, tokenFilePath }) => {
  const result = ensureAdminRuntime({ database, tokenFilePath });
  assert.equal(result.token, '');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 0);
}));

test('auto-provision rejects an invalid configured admin token instead of silently replacing it', async () => fixture(async ({ database, tokenFilePath }) => {
  assert.throws(
    () => ensureAdminRuntime({ database, tokenFilePath, configuredToken: 'not-a-token', autoProvision: true }),
    /canonical 43-character token/,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 0);
}));
