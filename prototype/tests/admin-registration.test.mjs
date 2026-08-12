import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  approveAdminRegistrationRequest,
  fetchAdminRegistrationRequests,
} from '../src/admin-pairing.js';

const ADMIN_TOKEN = randomBytes(32).toString('base64url');

function environment(fetchImpl) {
  return {
    location: { origin: 'http://127.0.0.1:5173' },
    WARUN_ADMIN_API_TOKEN: ADMIN_TOKEN,
    fetch: fetchImpl,
  };
}

test('admin registration list and approval use the runtime Bearer token without exposing request secrets', async () => {
  const calls = [];
  const env = environment(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/registration-requests')) {
      return {
        ok: true,
        async json() {
          return {
            requests: [{
              requestId: '00000000-0000-4000-8000-000000000801',
              deviceId: '00000000-0000-4000-8000-000000000802',
              displayName: 'A90',
              appVersion: 'test',
              role: 'customer',
              tableId: null,
              status: 'pending',
              expiresAtMs: 123456,
            }],
          };
        },
      };
    }
    return { ok: true, async json() { return { status: 'approved', tableId: 3 }; } };
  });

  const requests = await fetchAdminRegistrationRequests({ env });
  assert.equal(requests[0].status, 'pending');
  const approved = await approveAdminRegistrationRequest({
    env,
    requestId: requests[0].requestId,
    tableId: 3,
  });
  assert.equal(approved.status, 'approved');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.equal(calls[0].url.includes(ADMIN_TOKEN), false);
  assert.equal(calls[1].options.body.includes(ADMIN_TOKEN), false);
});
