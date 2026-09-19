import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAdminBusinessHours, saveAdminBusinessHours, saveAdminCategory, saveAdminMenuItem, saveAdminMenuOrdering } from '../src/admin-pairing.js';

const env = {
  WARUN_ADMIN_API_TOKEN: 'admin-token-for-test',
  WARUN_API_BASE: 'http://127.0.0.1:8787/v1',
  location: { origin: 'http://127.0.0.1:8787' },
};

test('saveAdminMenuItem sends the authenticated optimistic catalog write contract', async () => {
  let captured;
  const result = await saveAdminMenuItem({
    env,
    expectedVersion: 4,
    item: {
      id: 'sake',
      categoryId: 'drink',
      name: '純米吟醸',
      kitchenAlias: '純米吟醸',
      description: '説明',
      price: 880,
      isSoldOut: false,
      sortOrder: 2,
      detail: { enabled: true, showImageInList: true, reading: 'じゅんまいぎんじょう', aroma: '穏やか', sweetness: 'やや辛口', finish: 'きれい' },
      variants: [],
      servingOptions: [],
    },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ menuItemId: 'sake', version: 5, eventEpoch: '00000000-0000-4000-8000-000000000001', eventId: 8 }) };
    },
  });

  assert.equal(captured.url, 'http://127.0.0.1:8787/v1/admin/catalog/menu-item');
  assert.equal(captured.options.method, 'PUT');
  assert.equal(captured.options.headers.Authorization, 'Bearer admin-token-for-test');
  assert.equal(JSON.parse(captured.options.body).expectedVersion, 4);
  assert.equal(JSON.parse(captured.options.body).detail.aroma, '穏やか');
  assert.equal(JSON.parse(captured.options.body).detail.showImageInList, true);
  assert.equal(JSON.parse(captured.options.body).detail.reading, 'じゅんまいぎんじょう');
  assert.equal(result.version, 5);
});

test('saveAdminMenuItem preserves the server conflict code for the admin screen', async () => {
  await assert.rejects(
    () => saveAdminMenuItem({
      env,
      item: { id: 'sake', categoryId: 'drink', name: '日本酒', price: 700 },
      fetchImpl: async () => ({ ok: false, json: async () => ({ error: { code: 'CATALOG_CONFLICT' } }) }),
    }),
    (error) => error.code === 'CATALOG_CONFLICT',
  );
});

test('saveAdminMenuItem exposes the safe HTTP status, code, and request ID on failure', async () => {
  await assert.rejects(
    () => saveAdminMenuItem({
      env,
      item: { id: 'sake', categoryId: 'drink', name: '日本酒', price: 700 },
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: (name) => name === 'x-request-id' ? '00000000-0000-4000-8000-000000000003' : null },
        json: async () => ({ error: { code: 'INTERNAL_ERROR' } }),
      }),
    }),
    (error) => error.status === 500
      && error.code === 'INTERNAL_ERROR'
      && error.requestId === '00000000-0000-4000-8000-000000000003',
  );
});

test('admin category and ordering writes keep the authenticated batch contracts', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ categoryId: 'food-ready', version: 3, menuItemIds: ['a', 'b'], eventEpoch: '00000000-0000-4000-8000-000000000001', eventId: 9 }) };
  };
  await saveAdminCategory({ env, fetchImpl, category: { id: 'food-ready', name: 'とりあえず', sectionKey: 'food', sortOrder: 10, isVisible: true, version: 2 } });
  await saveAdminMenuOrdering({ env, fetchImpl, categoryId: 'food-ready', menuItemIds: ['a', 'b'], expectedVersion: 3 });
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/v1/admin/catalog/category');
  assert.equal(requests[0].body.expectedVersion, 2);
  assert.equal(requests[1].url, 'http://127.0.0.1:8787/v1/admin/catalog/menu-order');
  assert.deepEqual(requests[1].body.menuItemIds, ['a', 'b']);
});

test('business-hours admin client uses GET/PUT with optimistic versioning', async () => {
  const requests = [];
  const responseBody = { openTime: '17:00', closeTime: '29:59', lastOrderTime: '29:30', isVisible: true, version: 8, updatedAtMs: 1234, displayText: '17:00－29:59（ラストオーダー29:30）' };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => responseBody };
  };
  const loaded = await fetchAdminBusinessHours({ env, fetchImpl });
  const saved = await saveAdminBusinessHours({ env, settings: loaded, expectedVersion: 7, fetchImpl });
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/v1/admin/business-hours');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer admin-token-for-test');
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].body.expectedVersion, 7);
  assert.equal(requests[1].body.closeTime, '29:59');
  assert.equal(saved.version, 8);
});

test('business-hours admin client preserves 409 conflict and does not report success', async () => {
  await assert.rejects(
    () => saveAdminBusinessHours({
      env,
      settings: { openTime: '17:00', closeTime: '24:00', lastOrderTime: '23:30', isVisible: true, version: 2 },
      fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'BUSINESS_HOURS_CONFLICT' } }) }),
    }),
    (error) => error.code === 'BUSINESS_HOURS_CONFLICT' && error.status === 409,
  );
});
