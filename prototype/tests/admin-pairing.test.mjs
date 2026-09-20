import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminRideGuidanceContact, deleteAdminRideGuidanceContact, fetchAdminRideGuidance, saveAdminRideGuidanceOrdering, saveAdminRideGuidancePickup, updateAdminRideGuidanceContact, fetchAdminBusinessHours, saveAdminBusinessHours, saveAdminCategory, saveAdminMenuItem, saveAdminMenuOrdering } from '../src/admin-pairing.js';

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
  const responseBody = { openTime: '17:00', closeTime: '29:59', lastOrderTime: '29:30', isVisible: true, noticeText: '定休日\n臨時営業時間は店頭をご確認ください。', noticeEnabled: true, version: 8, updatedAtMs: 1234, displayText: '17:00－29:59（ラストオーダー29:30）' };
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
  assert.equal(loaded.noticeText, responseBody.noticeText);
  assert.equal(loaded.noticeEnabled, true);
  assert.equal(requests[1].body.noticeText, responseBody.noticeText);
  assert.equal(requests[1].body.noticeEnabled, true);
  assert.equal(saved.noticeText, responseBody.noticeText);
  assert.equal(saved.noticeEnabled, true);
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

test('ride-guidance admin client uses the authenticated CRUD and ordering contracts', async () => {
  const requests = [];
  const responseBodies = [
    { pickup: { pickupLabel: 'お迎え先（当店）', pickupAddress: '架空住所', version: 3 } , contacts: [] },
    { pickup: { pickupLabel: 'お迎え先（当店）', pickupAddress: '架空住所', version: 4 }, contacts: [] },
    { contact: { id: 'contact-1', type: 'taxi', name: '架空タクシー', phone: '03-0000-0000', note: '', isVisible: true, version: 1 } },
    { contact: { id: 'contact-1', type: 'driver_service', name: '架空代行', phone: '+81 (0)3 0000 0000', note: '架空', isVisible: false, version: 2 } },
    { deleted: true },
    { type: 'taxi', contacts: [] },
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => responseBodies.shift() };
  };
  await fetchAdminRideGuidance({ env, fetchImpl });
  await saveAdminRideGuidancePickup({ env, pickup: { pickupLabel: 'お迎え先（当店）', pickupAddress: '架空住所', version: 3 }, expectedVersion: 3, fetchImpl });
  await createAdminRideGuidanceContact({ env, contact: { type: 'taxi', name: '架空タクシー', phone: '03-0000-0000', note: '', isVisible: true }, fetchImpl });
  await updateAdminRideGuidanceContact({ env, contact: { id: 'contact-1', type: 'driver_service', name: '架空代行', phone: '+81 (0)3 0000 0000', note: '架空', isVisible: false, version: 1 }, fetchImpl });
  await deleteAdminRideGuidanceContact({ env, contactId: 'contact-1', expectedVersion: 2, fetchImpl });
  await saveAdminRideGuidanceOrdering({ env, type: 'taxi', contactIds: ['contact-2', 'contact-1'], fetchImpl });
  assert.equal(requests[0].url, `${env.WARUN_API_BASE}/admin/ride-guidance`);
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].body.expectedVersion, 3);
  assert.equal(requests[2].options.method, 'POST');
  assert.equal(requests[3].body.type, 'driver_service');
  assert.equal(requests[4].options.method, 'DELETE');
  assert.equal(requests[5].body.type, 'taxi');
  assert.deepEqual(requests[5].body.contactIds, ['contact-2', 'contact-1']);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer admin-token-for-test');
});

test('ride-guidance admin client preserves 409, 400, and 401 without reporting success', async () => {
  for (const [status, code] of [[409, 'RIDE_GUIDANCE_CONFLICT'], [400, 'RIDE_GUIDANCE_INVALID'], [401, 'AUTH_TOKEN_MISMATCH']]) {
    await assert.rejects(
      () => saveAdminRideGuidancePickup({ env, pickup: { pickupLabel: '', pickupAddress: '', version: 1 }, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: { code } }) }) }),
      (error) => error.status === status && error.code === code,
    );
  }
});
