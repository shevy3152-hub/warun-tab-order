import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimCustomerDevice,
  claimCustomerRegistration,
  createCustomerRegistrationRequest,
  createMemoryCredentialStore,
  fetchCustomerRegistrationStatus,
  loadOrCreateCustomerDevice,
} from '../src/device-credentials.js';

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

test('registration request is created once and survives a second client bootstrap', async () => {
  const store = createMemoryCredentialStore({ deviceId: DEVICE_ID, token: null, config: null });
  const calls = [];
  const globalObject = {
    crypto: {
      getRandomValues(bytes) {
        bytes.fill(0x41);
        return bytes;
      },
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          requestId: '00000000-0000-4000-8000-000000000702',
          deviceId: DEVICE_ID,
          status: 'pending',
          expiresAtMs: 123456,
        };
      },
    };
  };

  await createCustomerRegistrationRequest({
    store,
    baseUrl: 'http://tablet.local/v1',
    deviceId: DEVICE_ID,
    displayName: 'A90',
    appVersion: 'test',
    globalObject,
    fetchImpl,
  });
  await createCustomerRegistrationRequest({
    store,
    baseUrl: 'http://tablet.local/v1',
    deviceId: DEVICE_ID,
    displayName: 'A90',
    appVersion: 'test',
    globalObject,
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://tablet.local/v1/registration-requests');
  assert.equal(calls[0].options.body.includes('token'), false);
  assert.equal((await store.load()).requestId, '00000000-0000-4000-8000-000000000702');
});

test('approved registration claims once, persists the credential, and keeps secrets out of URLs', async () => {
  const store = createMemoryCredentialStore({ deviceId: DEVICE_ID, token: null, config: null });
  const token = Buffer.alloc(32, 0x44).toString('base64url');
  const calls = [];
  let requestCount = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    requestCount += 1;
    if (url.endsWith('/status')) {
      return {
        ok: true,
        async json() {
          return {
            requestId: '00000000-0000-4000-8000-000000000703',
            deviceId: DEVICE_ID,
            status: 'approved',
            tableId: 3,
            expiresAtMs: 123456,
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { deviceToken: token, config: { role: 'customer', tableId: 3 } };
      },
    };
  };
  await store.save({
    deviceId: DEVICE_ID,
    token: null,
    config: null,
    requestId: '00000000-0000-4000-8000-000000000703',
    requestSecret: Buffer.alloc(32, 0x45).toString('base64url'),
    requestStatus: 'pending',
  });

  const status = await fetchCustomerRegistrationStatus({ store, baseUrl: 'http://tablet.local/v1', fetchImpl });
  assert.equal(status.status, 'approved');
  await claimCustomerRegistration({ store, baseUrl: 'http://tablet.local/v1', fetchImpl });
  const saved = await store.load();
  assert.equal(saved.token, token);
  assert.equal(saved.requestId, undefined);
  assert.equal(calls.every(({ url }) => !url.includes(token)), true);
  assert.equal(requestCount, 2);
});

test('a lost registration response can be retried with the same IndexedDB-held secret', async () => {
  const store = createMemoryCredentialStore({ deviceId: DEVICE_ID, token: null, config: null });
  const bodies = [];
  let attempts = 0;
  const fetchImpl = async (_url, options) => {
    bodies.push(options.body);
    attempts += 1;
    if (attempts === 1) throw new Error('simulated response loss');
    return {
      ok: true,
      async json() {
        return {
          requestId: '00000000-0000-4000-8000-000000000704',
          deviceId: DEVICE_ID,
          status: 'pending',
          expiresAtMs: 123456,
        };
      },
    };
  };
  await assert.rejects(() => createCustomerRegistrationRequest({
    store,
    baseUrl: 'http://tablet.local/v1',
    deviceId: DEVICE_ID,
    displayName: 'A90',
    appVersion: 'test',
    globalObject: {
      crypto: { getRandomValues(bytes) { bytes.fill(0x43); return bytes; } },
    },
    fetchImpl,
  }));
  await createCustomerRegistrationRequest({
    store,
    baseUrl: 'http://tablet.local/v1',
    deviceId: DEVICE_ID,
    displayName: 'A90',
    appVersion: 'test',
    globalObject: { crypto: { getRandomValues() { throw new Error('a new secret was generated'); } } },
    fetchImpl,
  });
  assert.equal(JSON.parse(bodies[0]).requestSecret, JSON.parse(bodies[1]).requestSecret);
});
