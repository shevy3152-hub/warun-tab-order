import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeviceAuthenticator } from '../src/auth/device-auth.mjs';
import { createCheckoutRepository } from '../src/checkout/checkout-repository.mjs';
import { initializeDatabase } from '../src/db/database.mjs';
import { createEventRepository } from '../src/events/event-repository.mjs';
import { createSseHub } from '../src/events/sse-hub.mjs';
import { mapEventReplayResponse } from '../src/http/http-response.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROLES = ['customerA', 'customerB', 'kitchen', 'admin'];
const CUSTOMER_TYPES = ['checkout.requested', 'checkout.adjustments_updated', 'checkout.ready', 'checkout.cancelled'];
const STAFF_TYPES = [...CUSTOMER_TYPES, 'checkout.requested', 'checkout.ready', 'table.assignment_updated', 'checkout.paid', 'checkout.voided'];

class Response extends EventEmitter {
  headers = new Map();
  frames = [];
  writableEnded = false;
  destroyed = false;
  setHeader(name, value) { this.headers.set(name, value); }
  write(frame) { this.frames.push(frame); return true; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function envelopes(response) {
  return response.frames.join('').split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '));
    return data ? [JSON.parse(data.slice(6))] : [];
  });
}

async function fixture(t) {
  // These are fresh fictional fixtures. Keep their DBs for review; never read runtime-state or WARUN_DB_PATH.
  const directory = await mkdtemp(join(tmpdir(), 'warun-checkout-delivery-fixture-'));
  t.diagnostic(`Isolated fixture retained: ${directory}`);
  const connection = initializeDatabase({ databasePath: join(directory, 'fixture.sqlite3') });
  const database = connection.database;
  const authenticator = createDeviceAuthenticator({ database });
  const events = createEventRepository({ database });
  let clock = 100;
  const checkout = createCheckoutRepository({ database, now: () => clock++, idFactory: () => uuid(900) });
  const hub = createSseHub({ eventRepository: events, replayBatchSize: 2 });
  t.after(() => { hub.close(); checkout.close(); events.close(); authenticator.close(); connection.close(); });
  const principals = {};
  for (const [index, name] of ROLES.entries()) {
    const role = name.startsWith('customer') ? 'customer' : name;
    const token = Buffer.alloc(32, index + 1).toString('base64url');
    database.prepare(`INSERT INTO devices (device_id, role, display_name, token_hash, status,
      paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)`)
      .run(uuid(index + 1), role, `Fictional fixture ${name}`, createHash('sha256').update(token).digest('hex'));
    if (role === 'customer') {
      const tableId = index + 1;
      database.prepare(`INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active,
        created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, 1, 1)`).run(tableId, `Fictional table ${tableId}`, uuid(index + 1));
      database.prepare(`INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version,
        created_at_ms, updated_at_ms) VALUES (?, ?, 1, 1, 1, 1)`).run(uuid(10 + tableId), tableId);
    }
    principals[name] = authenticator.authenticateDeviceToken(token);
  }
  const cursor = events.getCurrentCursor(principals.admin);
  const replay = (name, afterEventId = 0) => events.replay({ principal: principals[name], eventEpoch: cursor.eventEpoch, afterEventId });
  async function connect(name, afterEventId = 0) {
    const response = new Response();
    const stream = hub.attach({ request: new EventEmitter(), response, principal: principals[name], eventEpoch: cursor.eventEpoch, afterEventId });
    await stream.ready;
    return { stream, response };
  }
  async function notify(result) {
    hub.notifyCommitted(result.event);
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function firstCheckout() {
    const created = checkout.createCheckout({ principal: principals.customerA, checkoutRequestId: uuid(101), receiptRequested: true });
    await notify(created);
    const adjusted = checkout.saveAdjustments({ principal: principals.kitchen, checkoutRequestId: uuid(101), expectedVersion: created.request.version,
      adjustments: [{ kind: 'seat_charge', label: 'Fictional adjustment', amountYen: 100 }] });
    await notify(adjusted);
    const ready = checkout.ready({ principal: principals.kitchen, checkoutRequestId: uuid(101), expectedVersion: adjusted.request.version });
    await notify(ready);
    await notify(checkout.cancel({ principal: principals.kitchen, checkoutRequestId: uuid(101), expectedVersion: ready.request.version }));
  }
  async function payment() {
    const created = checkout.createCheckout({ principal: principals.customerA, checkoutRequestId: uuid(102), receiptRequested: false });
    await notify(created);
    const ready = checkout.ready({ principal: principals.kitchen, checkoutRequestId: uuid(102), expectedVersion: created.request.version });
    await notify(ready);
    const paid = checkout.pay({ principal: principals.kitchen, checkoutRequestId: uuid(102), expectedVersion: ready.request.version, paymentMethod: 'cash' });
    await notify(paid);
    await notify(checkout.voidPayment({ principal: principals.admin, paymentRecordId: paid.payment.paymentRecordId,
      expectedVersion: paid.payment.version, reason: 'Fictional fixture void' }));
  }
  return { database, events, checkout, hub, principals, cursor, replay, connect, notify, firstCheckout, payment };
}

function assertSafe(events) {
  for (const event of events) {
    assert.deepEqual(event.payload, { resource: event.type === 'table.assignment_updated' ? 'deviceConfig' : 'checkout', refreshRequired: true });
    assert.deepEqual(Object.keys(event).sort(), ['aggregateId', 'audience', 'eventEpoch', 'eventId', 'occurredAtMs', 'payload', 'type']);
  }
  assert.doesNotMatch(JSON.stringify(events), /paymentRecordId|confirmedTotalYen|receiptRequested|Fictional adjustment|token|reason/);
}

test('customer checkout state invalidations pass live SSE, reconnect and HTTP replay without financial payloads', async (t) => {
  const f = await fixture(t);
  const live = await f.connect('customerA');
  await f.firstCheckout();
  assert.equal(live.stream.active, true);
  assert.deepEqual(envelopes(live.response).map((e) => e.type), CUSTOMER_TYPES);
  const mapped = mapEventReplayResponse(f.replay('customerA'));
  assert.deepEqual(mapped.events, envelopes(live.response));
  assertSafe(mapped.events);
  live.stream.close();
  const reconnect = await f.connect('customerA', mapped.events[0].eventId);
  assert.deepEqual(envelopes(reconnect.response), mapped.events.slice(1));
});

for (const role of ['kitchen', 'admin']) {
  test(`${role} receives checkout lifecycle and payment invalidations without disconnecting or replaying duplicates`, async (t) => {
    const f = await fixture(t);
    const live = await f.connect(role);
    await f.firstCheckout();
    await f.payment();
    assert.equal(live.stream.active, true);
    const delivered = envelopes(live.response);
    assert.deepEqual(delivered.map((e) => e.type), STAFF_TYPES);
    assert.equal(new Set(delivered.map((e) => e.eventId)).size, delivered.length);
    assert.deepEqual(mapEventReplayResponse(f.replay(role)).events, delivered);
    assertSafe(delivered);
    const cursor = live.stream.lastEventId;
    live.stream.close();
    const replay = await f.connect(role, delivered[0].eventId);
    assert.deepEqual(envelopes(replay.response), delivered.slice(1));
    const tail = await f.connect(role, cursor);
    assert.deepEqual(envelopes(tail.response), []);
  });
}

test('another table receives only cursor advancement in live SSE and HTTP replay', async (t) => {
  const f = await fixture(t);
  const live = await f.connect('customerB');
  await f.firstCheckout();
  await f.payment();
  assert.equal(live.stream.active, true);
  assert.deepEqual(envelopes(live.response), []);
  const replay = mapEventReplayResponse(f.replay('customerB'));
  assert.deepEqual(replay.events, []);
  assert.equal(replay.lastEventId, live.stream.lastEventId);
  assert.ok(replay.lastEventId > 0);
  const reconnected = await f.connect('customerB');
  assert.deepEqual(envelopes(reconnected.response), []);
  await f.notify(f.checkout.createCheckout({ principal: f.principals.customerB, checkoutRequestId: uuid(103), receiptRequested: false }));
  assert.equal(envelopes(live.response).length, 1);
  assert.equal(envelopes(live.response)[0].aggregateId, uuid(103));
});

test('customer payment events are hidden and a new visit cannot replay the previous visit checkout IDs', async (t) => {
  const f = await fixture(t);
  const live = await f.connect('customerA');
  await f.firstCheckout();
  await f.payment();
  assert.equal(live.stream.active, true);
  assert.deepEqual(envelopes(live.response).map((e) => e.type), [...CUSTOMER_TYPES, 'checkout.requested', 'checkout.ready', 'table.assignment_updated']);
  f.database.prepare(`INSERT INTO table_sessions (session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms)
    VALUES (?, 1, 1000, 1, 1000, 1000)`).run(uuid(20));
  const historical = mapEventReplayResponse(f.replay('customerA'));
  assert.deepEqual(historical.events.map((e) => e.type), ['table.assignment_updated']);
  const reconnect = await f.connect('customerA');
  assert.deepEqual(envelopes(reconnect.response), historical.events);
  for (const id of [1, 2, 3, 4, 5, 6, 8, 9]) {
    assert.equal(f.events.readCommittedEventForPrincipal({ principal: f.principals.customerA, eventId: id }).event, null);
  }
});

test('schema rejects unknown checkout events and subsequent permitted events still flow', async (t) => {
  const f = await fixture(t);
  await f.firstCheckout();
  const cursor = f.events.getCurrentCursor(f.principals.admin);
  const live = await f.connect('admin', cursor.lastEventId);
  const insert = f.database.prepare(`INSERT INTO event_log (event_epoch, event_type, aggregate_type, aggregate_id,
    actor_device_id, payload_json, created_at_ms) VALUES (?, 'checkout.fixture_unknown', 'checkout', ?, ?, ?, 500)`);
  assert.throws(() => insert.run(cursor.eventEpoch, uuid(101), f.principals.admin.deviceId,
    JSON.stringify({ forbiddenRawPayload: 'fictional-secret' })), /CHECK constraint failed/);
  assert.equal(live.stream.active, true);
  assert.deepEqual(envelopes(live.response), []);
  assert.equal(live.stream.lastEventId, cursor.lastEventId);
  await f.notify(f.checkout.createCheckout({ principal: f.principals.customerB, checkoutRequestId: uuid(103), receiptRequested: false }));
  assert.deepEqual(envelopes(live.response).map((e) => e.type), ['checkout.requested']);
  for (const role of ROLES) {
    const replay = mapEventReplayResponse(f.replay(role));
    assert.ok(replay.events.every((event) => event.type !== 'checkout.fixture_unknown'));
    assert.doesNotMatch(JSON.stringify(replay), /forbiddenRawPayload|fictional-secret/);
  }
});

test('SSE and replay DTO still reject a customer payment or unknown event supplied by a faulty repository', async (t) => {
  const f = await fixture(t);
  for (const type of ['checkout.paid', 'checkout.voided', 'checkout.fixture_unknown']) {
    const event = { audience: 'customer', eventEpoch: f.cursor.eventEpoch, eventId: 1, type, aggregateId: uuid(101),
      occurredAtMs: 100, payload: { resource: 'checkout', refreshRequired: true } };
    const range = { audience: 'customer', eventEpoch: f.cursor.eventEpoch, lastEventId: 1, events: [event], hasMore: false };
    assert.throws(() => mapEventReplayResponse(range));
    const hub = createSseHub({ eventRepository: { readCommittedForPrincipal: () => range } });
    try {
      const response = new Response();
      const stream = hub.attach({ request: new EventEmitter(), response, principal: f.principals.customerA,
        eventEpoch: f.cursor.eventEpoch, afterEventId: 0 });
      await assert.rejects(stream.ready, /invalid projected event/);
      assert.deepEqual(envelopes(response), []);
    } finally { hub.close(); }
  }
});
