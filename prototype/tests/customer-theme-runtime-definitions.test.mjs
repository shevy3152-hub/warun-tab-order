import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCustomerTheme } from '../src/customer-theme.js';
import { fetchCustomerThemeConfig } from '../src/order-outbox.js';

test('customer theme config registers the public selected definition before normalizing its theme key', async () => {
  const key = 'isolated-browser-theme';
  const definition = { id: key, label: '隔離確認テーマ', assetPath: '/v1/customer-theme-images/00000000-0000-4000-8000-000000000001.png', available: true, image: { width: 640, height: 1600 } };
  const result = await fetchCustomerThemeConfig({
    config: { enabled: true, baseUrl: 'http://127.0.0.1/v1', token: 'isolated-test-token' },
    fetchImpl: async () => ({ status: 200, json: async () => ({ theme: key, definition, positionX: 0.37, positionY: 0.68, zoom: 1.28 }) }),
  });
  assert.equal(result.theme, key);
  assert.equal(normalizeCustomerTheme(result.theme), key);
  assert.equal(result.positionX, 0.37);
  assert.equal(result.positionY, 0.68);
  assert.equal(result.zoom, 1.28);
});
