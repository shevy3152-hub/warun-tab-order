import assert from 'node:assert/strict';
import test from 'node:test';
import { claimCustomerDevice, createMemoryCredentialStore, loadOrCreateCustomerDevice } from '../src/device-credentials.js';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'token-is-only-used-by-the-credential-store';

test('deviceId survives reload and claim stores credentials without putting token in URL', async () => {
  const store = createMemoryCredentialStore({ deviceId: DEVICE_ID, token: null, config: null });
  const first = await loadOrCreateCustomerDevice({ store });
  const second = await loadOrCreateCustomerDevice({ store });
  assert.equal(first.deviceId, second.deviceId);
  let request;
  await claimCustomerDevice({
    store,
    baseUrl: 'http://tablet.local/v1',
    pairingCode: 'pairing-code',
    deviceId: DEVICE_ID,
    displayName: 'A90',
    appVersion: 'test',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return { deviceToken: TOKEN, config: { role: 'customer', tableId: 1 } }; } };
    },
  });
  assert.equal(request.url, 'http://tablet.local/v1/pairings/claim');
  assert.equal(request.options.body.includes(TOKEN), false);
  const reloaded = await store.load();
  assert.equal(reloaded.deviceId, DEVICE_ID);
  assert.equal(reloaded.token, TOKEN);
});
