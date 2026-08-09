import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HTTP_ERROR_CODES,
  createHttpError,
} from '../src/http/http-errors.mjs';
import {
  createErrorResponse,
  createEventHistoryUnavailableResponse,
  mapEventReplayResponse,
  mapOrderReceiptResponse,
  mapSnapshotResponse,
} from '../src/http/http-response.mjs';
import { parseSseCursorHeaders } from '../src/http/http-server.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const EVENT_EPOCH = uuid(100);
const REQUEST_ID = uuid(900);

test('SSE cursor headers require one canonical event ID and epoch pair', () => {
  assert.equal(parseSseCursorHeaders([]), null);
  assert.deepEqual(
    parseSseCursorHeaders([
      'Last-Event-ID', '42',
      'X-Event-Epoch', EVENT_EPOCH,
    ]),
    { eventEpoch: EVENT_EPOCH, afterEventId: 42 },
  );

  for (const rawHeaders of [
    ['Last-Event-ID', '42'],
    ['X-Event-Epoch', EVENT_EPOCH],
    ['Last-Event-ID', '42', 'last-event-id', '43', 'X-Event-Epoch', EVENT_EPOCH],
    ['Last-Event-ID', '42,43', 'X-Event-Epoch', EVENT_EPOCH],
    ['Last-Event-ID', '01', 'X-Event-Epoch', EVENT_EPOCH],
    ['Last-Event-ID', '9007199254740992', 'X-Event-Epoch', EVENT_EPOCH],
    ['Last-Event-ID', '42', 'X-Event-Epoch', 'A0000000-0000-4000-8000-000000000100'],
  ]) {
    assert.throws(
      () => parseSseCursorHeaders(rawHeaders),
      (error) => error.code === HTTP_ERROR_CODES.BAD_REQUEST,
    );
  }
});

function customerDevice(overrides = {}) {
  return {
    deviceId: uuid(1),
    role: 'customer',
    deviceLabel: 'Table tablet',
    status: 'active',
    configVersion: 1,
    eventEpoch: EVENT_EPOCH,
    lastEventId: 8,
    tableId: 1,
    tableLabel: 'Table 1',
    tableIsActive: true,
    tokenHash: 'must-not-leak',
    ...overrides,
  };
}

function staffDevice(role, overrides = {}) {
  return {
    deviceId: role === 'kitchen' ? uuid(2) : uuid(3),
    role,
    deviceLabel: `${role} tablet`,
    status: 'active',
    configVersion: 1,
    eventEpoch: EVENT_EPOCH,
    lastEventId: 8,
    token: 'must-not-leak',
    ...overrides,
  };
}

function menuFor(audience, overrides = {}) {
  const base = {
    audience,
    eventEpoch: EVENT_EPOCH,
    lastEventId: 8,
    categories: [{
      categoryId: 'food',
      name: 'Food',
      sortOrder: 1,
      ...(audience === 'admin' ? { isVisible: true, version: 1, updatedAtMs: 1000 } : {}),
      tokenHash: 'must-not-leak',
    }],
    items: [{
      menuItemId: 'edamame',
      categoryId: 'food',
      formalName: 'Edamame',
      isSoldOut: false,
      sortOrder: 1,
      version: 1,
      ...(audience === 'customer' ? { description: 'Salted beans' } : {}),
      ...(audience !== 'customer' ? { kitchenAlias: 'Beans' } : {}),
      ...(audience === 'admin' ? {
        description: 'Salted beans',
        priceYen: 380,
        isActive: true,
        updatedAtMs: 1000,
      } : {}),
      requestFingerprint: 'must-not-leak',
    }],
    ...overrides,
  };
  return base;
}

function staffOrder(overrides = {}) {
  return {
    orderId: uuid(10),
    clientOrderId: uuid(11),
    tableId: 1,
    tableNumberSnapshot: 1,
    status: 'new',
    totalAmountYen: 760,
    acceptedAtMs: 2000,
    version: 1,
    customerDeviceId: uuid(1),
    requestFingerprint: 'must-not-leak',
    canonicalRequestJson: '{"secret":true}',
    items: [{
      orderItemId: 1,
      menuItemId: 'edamame',
      formalNameSnapshot: 'Edamame',
      kitchenAliasSnapshot: 'Beans',
      unitPriceYenSnapshot: 380,
      quantity: 2,
      lineTotalYen: 760,
      isServed: false,
      token: 'must-not-leak',
    }],
    ...overrides,
  };
}

function staffCall(overrides = {}) {
  return {
    staffCallId: uuid(20),
    clientCallId: uuid(21),
    tableId: 1,
    tableNumberSnapshot: 1,
    callType: 'staff',
    status: 'open',
    createdAtMs: 2100,
    version: 1,
    customerDeviceId: uuid(1),
    tokenHash: 'must-not-leak',
    ...overrides,
  };
}

function projectedEvent(audience, overrides = {}) {
  return {
    audience,
    eventEpoch: EVENT_EPOCH,
    eventId: 7,
    type: 'order.created',
    aggregateId: uuid(10),
    occurredAtMs: 2000,
    payload: {
      resource: 'orders',
      refreshRequired: true,
      priceYen: 380,
      rawPayloadJson: '{"secret":true}',
      tokenHash: 'must-not-leak',
    },
    actorDeviceId: uuid(1),
    ...overrides,
  };
}

function snapshotFor(audience, overrides = {}) {
  return {
    audience,
    eventEpoch: EVENT_EPOCH,
    lastEventId: 8,
    device: audience === 'customer' ? customerDevice() : staffDevice(audience),
    menu: menuFor(audience),
    activeOrders: audience === 'customer' ? [] : [staffOrder()],
    openStaffCalls: audience === 'customer' ? [] : [staffCall()],
    rawPayloadJson: '{"secret":true}',
    ...overrides,
  };
}

function assertInternalError(callback) {
  assert.throws(callback, (error) => (
    error.code === HTTP_ERROR_CODES.INTERNAL_ERROR && error.statusCode === 500
  ));
}

function assertNoForbidden(value, pattern = /token|hash|pairing|fingerprint|canonical|rawPayload|customerDevice/i) {
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoForbidden(entry, pattern));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(pattern.test(key), false, `forbidden key ${key}`);
      assertNoForbidden(nested, pattern);
    }
  }
}

test('new HTTP error codes have stable status and public messages', () => {
  const expected = [
    ['INVALID_ORDER_REQUEST', 400, 'Invalid order request.'],
    ['PAYLOAD_TOO_LARGE', 413, 'Request body is too large.'],
    ['UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type.'],
    ['ORDER_CONFLICT', 409, 'Order conflicts with an existing request.'],
    ['MENU_ITEM_NOT_FOUND', 422, 'A requested menu item is unavailable.'],
    ['MENU_ITEM_SOLD_OUT', 422, 'A requested menu item is sold out.'],
    ['EVENT_HISTORY_UNAVAILABLE', 410, 'Event history is unavailable.'],
  ];
  for (const [code, statusCode, message] of expected) {
    const error = createHttpError(HTTP_ERROR_CODES[code]);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.publicMessage, message);
  }
});

test('createErrorResponse remains backward compatible for old and new errors', () => {
  assert.deepEqual(createErrorResponse(createHttpError(HTTP_ERROR_CODES.BAD_REQUEST), REQUEST_ID), {
    error: { code: 'BAD_REQUEST', message: 'Bad request.' },
    requestId: REQUEST_ID,
  });
  assert.deepEqual(
    createErrorResponse(createHttpError(HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE), REQUEST_ID),
    {
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
      requestId: REQUEST_ID,
    },
  );
});

test('order receipt is an exact customer-safe allow-list', () => {
  const receipt = mapOrderReceiptResponse({
    idempotencyResult: 'created',
    event: { eventId: 1, payloadJson: '{"secret":true}' },
    order: {
      ...staffOrder(),
      acceptedAtMs: 2000,
      requestFingerprint: 'must-not-leak',
      totalAmountYen: 760,
    },
  });
  assert.deepEqual(receipt, {
    orderId: uuid(10),
    clientOrderId: uuid(11),
    status: 'new',
    acceptedAtMs: 2000,
    idempotencyResult: 'created',
  });
  assertNoForbidden(receipt);
  assert.equal(Object.hasOwn(receipt, 'totalAmountYen'), false);
  assert.equal(Object.hasOwn(receipt, 'tableId'), false);
});

test('order receipt accepts replayed and rejects malformed repository results', () => {
  assert.equal(mapOrderReceiptResponse({
    idempotencyResult: 'replayed',
    order: staffOrder(),
  }).idempotencyResult, 'replayed');
  for (const invalid of [
    null,
    { idempotencyResult: 'unknown', order: staffOrder() },
    { idempotencyResult: 'created', order: { ...staffOrder(), orderId: 'bad' } },
    { idempotencyResult: 'created', order: { ...staffOrder(), acceptedAtMs: -1 } },
  ]) assertInternalError(() => mapOrderReceiptResponse(invalid));
});

test('role-scoped replay emits the exact safe event envelope', () => {
  for (const audience of ['customer', 'kitchen', 'admin']) {
    const response = mapEventReplayResponse({
      audience,
      eventEpoch: EVENT_EPOCH,
      events: [projectedEvent(audience)],
      lastEventId: 8,
      hasMore: false,
      tokenHash: 'must-not-leak',
    });
    assert.deepEqual(Object.keys(response).sort(), [
      'audience', 'eventEpoch', 'events', 'hasMore', 'lastEventId',
    ].sort());
    assert.deepEqual(response.events[0], {
      audience,
      eventEpoch: EVENT_EPOCH,
      eventId: 7,
      type: 'order.created',
      aggregateId: uuid(10),
      occurredAtMs: 2000,
      payload: { resource: 'orders', refreshRequired: true },
    });
    assertNoForbidden(response);
    assert.equal(JSON.stringify(response).includes('priceYen'), false);
  }
});

test('role-specific event types cannot cross the mapper boundary', () => {
  assertInternalError(() => mapEventReplayResponse({
    audience: 'customer',
    eventEpoch: EVENT_EPOCH,
    events: [projectedEvent('customer', {
      type: 'device.paired',
      aggregateId: 'device-config',
      payload: { resource: 'deviceConfig', refreshRequired: true },
    })],
    lastEventId: 8,
    hasMore: false,
  }));
  assertInternalError(() => mapEventReplayResponse({
    audience: 'kitchen',
    eventEpoch: EVENT_EPOCH,
    events: [projectedEvent('kitchen', {
      type: 'device.revoked',
      aggregateId: 'device-config',
      payload: { resource: 'deviceConfig', refreshRequired: true },
    })],
    lastEventId: 8,
    hasMore: false,
  }));
  assert.equal(mapEventReplayResponse({
    audience: 'admin',
    eventEpoch: EVENT_EPOCH,
    events: [projectedEvent('admin', {
      type: 'device.paired',
      aggregateId: 'device-config',
      payload: { resource: 'deviceConfig', refreshRequired: true },
    })],
    lastEventId: 8,
    hasMore: false,
  }).events[0].type, 'device.paired');
});

test('event replay rejects mismatched audience, epoch, order, range, or payload', () => {
  const invalidEvents = [
    projectedEvent('admin'),
    projectedEvent('customer', { eventEpoch: uuid(101) }),
    projectedEvent('customer', { eventId: 9 }),
    projectedEvent('customer', { payload: { resource: 'menu', refreshRequired: true } }),
    projectedEvent('customer', { payload: { resource: 'orders', refreshRequired: false } }),
  ];
  for (const event of invalidEvents) {
    assertInternalError(() => mapEventReplayResponse({
      audience: 'customer',
      eventEpoch: EVENT_EPOCH,
      events: [event],
      lastEventId: 8,
      hasMore: false,
    }));
  }
  assertInternalError(() => mapEventReplayResponse({
    audience: 'customer',
    eventEpoch: EVENT_EPOCH,
    events: [projectedEvent('customer', { eventId: 7 }), projectedEvent('customer', { eventId: 6 })],
    lastEventId: 8,
    hasMore: false,
  }));
});

test('empty replay cursor remains valid without fabricating events', () => {
  assert.deepEqual(mapEventReplayResponse({
    audience: 'customer',
    eventEpoch: EVENT_EPOCH,
    events: [],
    lastEventId: 0,
    hasMore: false,
  }), {
    audience: 'customer',
    eventEpoch: EVENT_EPOCH,
    events: [],
    lastEventId: 0,
    hasMore: false,
  });
});

test('customer snapshot has exactly audience, root cursor, device, and menu', () => {
  const response = mapSnapshotResponse(snapshotFor('customer', {
    activeOrders: [staffOrder()],
    openStaffCalls: [staffCall()],
    priceYen: 999,
  }));
  assert.deepEqual(
    Object.keys(response).sort(),
    ['audience', 'eventEpoch', 'lastEventId', 'device', 'menu'].sort(),
  );
  assert.equal(response.eventEpoch, EVENT_EPOCH);
  assert.equal(response.lastEventId, 8);
  assert.equal(response.device.role, 'customer');
  assert.equal(response.menu.audience, 'customer');
  assert.equal(Object.hasOwn(response, 'activeOrders'), false);
  assert.equal(Object.hasOwn(response, 'openStaffCalls'), false);
  assert.equal(JSON.stringify(response).includes('priceYen'), false);
  assertNoForbidden(response);
});

test('kitchen and admin snapshots map staff data through exact allow-lists', () => {
  for (const audience of ['kitchen', 'admin']) {
    const response = mapSnapshotResponse(snapshotFor(audience));
    assert.deepEqual(Object.keys(response).sort(), [
      'activeOrders', 'audience', 'eventEpoch', 'lastEventId', 'device', 'menu', 'openStaffCalls',
    ].sort());
    assert.deepEqual(Object.keys(response.activeOrders[0]).sort(), [
      'acceptedAtMs', 'clientOrderId', 'items', 'orderId', 'status', 'tableId',
      'tableNumberSnapshot', 'totalAmountYen', 'version',
    ].sort());
    assert.deepEqual(Object.keys(response.activeOrders[0].items[0]).sort(), [
      'formalNameSnapshot', 'isServed', 'kitchenAliasSnapshot', 'lineTotalYen',
      'menuItemId', 'orderItemId', 'quantity', 'unitPriceYenSnapshot',
    ].sort());
    assert.deepEqual(Object.keys(response.openStaffCalls[0]).sort(), [
      'callType', 'clientCallId', 'createdAtMs', 'staffCallId', 'status', 'tableId',
      'tableNumberSnapshot', 'version',
    ].sort());
    assertNoForbidden(response);
  }
});

test('snapshot mapper preserves only documented optional completion fields', () => {
  const response = mapSnapshotResponse(snapshotFor('admin', {
    activeOrders: [staffOrder({
      status: 'completed',
      completedAtMs: 3000,
      items: [{ ...staffOrder().items[0], isServed: true, servedAtMs: 2900 }],
    })],
    openStaffCalls: [staffCall({ status: 'resolved', resolvedAtMs: 3000 })],
  }));
  assert.equal(response.activeOrders[0].completedAtMs, 3000);
  assert.equal(response.activeOrders[0].items[0].servedAtMs, 2900);
  assert.equal(response.openStaffCalls[0].resolvedAtMs, 3000);
});

test('snapshot rejects audience or logical cursor inconsistency', () => {
  for (const snapshot of [
    snapshotFor('customer', { device: customerDevice({ role: 'admin' }) }),
    snapshotFor('customer', { menu: menuFor('kitchen') }),
    snapshotFor('customer', { device: customerDevice({ lastEventId: 7 }) }),
    snapshotFor('customer', { menu: menuFor('customer', { eventEpoch: uuid(101) }) }),
    snapshotFor('unknown'),
  ]) assertInternalError(() => mapSnapshotResponse(snapshot));
});

test('snapshot rejects malformed staff order and staff-call DTOs', () => {
  assertInternalError(() => mapSnapshotResponse(snapshotFor('kitchen', {
    activeOrders: [staffOrder({ items: [] })],
  })));
  assertInternalError(() => mapSnapshotResponse(snapshotFor('admin', {
    openStaffCalls: [staffCall({ callType: 'taxi' })],
  })));
});

test('history unavailable response is a fixed safe recovery contract', () => {
  const error = createHttpError(HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE, {
    cause: new Error('SELECT token_hash FROM devices'),
  });
  error.rawPayloadJson = '{"token":"secret"}';
  const response = createEventHistoryUnavailableResponse(error, REQUEST_ID, {
    eventEpoch: EVENT_EPOCH,
    lastEventId: 8,
    tokenHash: 'must-not-leak',
  });
  assert.deepEqual(response, {
    error: {
      code: 'EVENT_HISTORY_UNAVAILABLE',
      message: 'Event history is unavailable.',
    },
    requestId: REQUEST_ID,
    recovery: {
      strategy: 'snapshot',
      snapshotUrl: '/v1/snapshot',
      currentEventEpoch: EVENT_EPOCH,
      lastEventId: 8,
    },
  });
  assertNoForbidden(response);
  assert.equal(JSON.stringify(response).includes('SELECT'), false);
});

test('history unavailable response rejects the wrong error or invalid cursor', () => {
  assertInternalError(() => createEventHistoryUnavailableResponse(
    createHttpError(HTTP_ERROR_CODES.BAD_REQUEST),
    REQUEST_ID,
    { eventEpoch: EVENT_EPOCH, lastEventId: 8 },
  ));
  assertInternalError(() => createEventHistoryUnavailableResponse(
    createHttpError(HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE),
    REQUEST_ID,
    { eventEpoch: EVENT_EPOCH, lastEventId: -1 },
  ));
});
