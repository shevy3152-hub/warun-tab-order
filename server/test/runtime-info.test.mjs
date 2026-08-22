import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDatabaseTarget, createRuntimeInfo, lanIPv4Addresses } from '../src/runtime-info.mjs';

test('runtime info filters loopback and link-local addresses and preserves the actual LAN list', () => {
  assert.deepEqual(lanIPv4Addresses({
    WiFi: [
      { family: 'IPv4', address: '192.0.2.44', internal: false },
      { family: 'IPv4', address: '169.254.10.20', internal: false },
    ],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  }), ['192.0.2.44']);
});

test('database target classification distinguishes safe-copy and production paths', () => {
  const root = 'C:\\runtime-fixture';
  assert.equal(classifyDatabaseTarget({ databasePath: root + '\\server\\var\\safe-copies\\copy.sqlite3', repositoryRoot: root }), 'safe-copy');
  assert.equal(classifyDatabaseTarget({ databasePath: root + '\\server\\var\\warun.sqlite3', repositoryRoot: root }), 'production');
  assert.equal(classifyDatabaseTarget({ databasePath: root + '\\server\\var\\other.sqlite3', repositoryRoot: root }), 'other');
});

test('runtime info generates pairing and admin URLs from supplied ports and LAN addresses', () => {
  const info = createRuntimeInfo({
    databasePath: 'C:\\runtime-fixture\\server\\var\\safe-copies\\copy.sqlite3',
    repositoryRoot: 'C:\\runtime-fixture',
    environment: 'safe-copy',
    apiPort: 28787,
    webPort: 25173,
    addresses: ['192.0.2.44'],
  });
  assert.equal(info.databaseTarget, 'safe-copy');
  assert.equal(info.isProduction, false);
  assert.deepEqual(info.lanIPv4, ['192.0.2.44']);
  assert.equal(info.pairingUrlOrigin, 'http://192.0.2.44:25173');
  assert.equal(info.pairingUrlTemplate, 'http://192.0.2.44:25173/pairing.html#p=<code>');
  assert.equal(info.webOrigins.includes('http://192.0.2.44:25173'), true);
});
