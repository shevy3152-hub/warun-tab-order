import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createSseHub } from '../src/events/sse-hub.mjs';

const EPOCH = '00000000-0000-4000-8000-000000000100';
const OTHER_EPOCH = '00000000-0000-4000-8000-000000000200';

function projectedEvent(eventId, overrides = {}) {
  return {
    audience: 'customer',
    eventEpoch: EPOCH,
    eventId,
    type: 'order.created',
    aggregateId: `order-${eventId}`,
    occurredAtMs: 1_786_280_000_000 + eventId,
    payload: { resource: 'orders', refreshRequired: true },
    ...overrides,
  };
}

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  constructor(writeResult = () => true) {
    super();
    this.headers = new Map();
    this.writes = [];
    this.statusCode = undefined;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.flushCount = 0;
    this.writeResult = writeResult;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {
    this.headersSent = true;
    this.flushCount += 1;
  }

  write(frame) {
    if (this.destroyed) throw new Error('destroyed');
    this.headersSent = true;
    this.writes.push(String(frame));
    return this.writeResult(this.writes.length, String(frame));
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  text() {
    return this.writes.join('');
  }
}

function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const handle = (id) => ({ id, unref() {} });
  return {
    setInterval(callback) {
      const id = nextId++;
      intervals.set(id, callback);
      return handle(id);
    },
    clearInterval(timer) {
      intervals.delete(timer?.id);
    },
    setTimeout(callback) {
      const id = nextId++;
      timeouts.set(id, callback);
      return handle(id);
    },
    clearTimeout(timer) {
      timeouts.delete(timer?.id);
    },
    tickIntervals() {
      for (const callback of [...intervals.values()]) callback();
    },
    runTimeouts() {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      for (const callback of callbacks) callback();
    },
    get intervalCount() {
      return intervals.size;
    },
    get timeoutCount() {
      return timeouts.size;
    },
  };
}

function createRangeRepository({ rows = [], project = (_principal, row) => row } = {}) {
  const state = {
    rows,
    calls: [],
    closed: false,
  };
  return {
    state,
    async readCommittedForPrincipal(principal, request) {
      state.calls.push({ principal, ...request });
      const upperBound = request.throughEventId ?? Number.MAX_SAFE_INTEGER;
      const candidates = state.rows
        .filter((row) => row.eventEpoch === request.eventEpoch)
        .filter((row) => row.eventId > request.afterEventId && row.eventId <= upperBound)
        .sort((left, right) => left.eventId - right.eventId);
      const scanned = candidates.slice(0, request.limit);
      return {
        audience: principal.role,
        eventEpoch: request.eventEpoch,
        lastEventId: scanned.at(-1)?.eventId ?? request.afterEventId,
        events: scanned.map((row) => project(principal, row)).filter(Boolean),
        hasMore: candidates.length > scanned.length,
      };
    },
    close() {
      state.closed = true;
    },
  };
}

function createFixture(options = {}) {
  const timers = options.timers ?? createFakeTimers();
  const repository = options.repository ?? createRangeRepository(options.repositoryOptions);
  const hub = createSseHub({
    eventRepository: repository,
    timers,
    heartbeatIntervalMs: 100,
    maxConnectionMs: 1_000,
    maxQueueBytes: options.maxQueueBytes ?? 4_096,
    maxQueueFrames: options.maxQueueFrames ?? 8,
    replayBatchSize: options.replayBatchSize ?? 2,
  });
  return { hub, repository, timers };
}

function attach(hub, {
  response = new FakeResponse(),
  principal = Object.freeze({ deviceId: 'device-a', role: 'customer' }),
  eventEpoch = EPOCH,
  afterEventId = 0,
} = {}) {
  const request = new FakeRequest();
  const connection = hub.attach({ request, response, principal, eventEpoch, afterEventId });
  return { connection, request, response, principal };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('factory requires the committed-range repository contract', () => {
  assert.throws(() => createSseHub(), /readCommittedForPrincipal/);
  assert.throws(
    () => createSseHub({ eventRepository: { readCommittedForPrincipal() {} }, maxQueueFrames: 0 }),
    /positive safe integer/,
  );
});

test('attach performs committed replay and opens a hardened SSE response', async (t) => {
  const { hub, repository } = createFixture({
    repositoryOptions: { rows: [projectedEvent(1)] },
  });
  t.after(() => hub.close());
  const { connection, response } = attach(hub);

  await connection.ready;

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('connection'), 'keep-alive');
  assert.match(response.text(), /retry: 3000/);
  assert.match(response.text(), /id: 1\nevent: order\.created/);
  assert.equal(connection.lastEventId, 1);
  assert.equal(repository.state.calls[0].afterEventId, 0);
});

test('commit notification is only a cursor wake and payload is reread from repository', async (t) => {
  const { hub, repository } = createFixture();
  t.after(() => hub.close());
  const { connection, response } = attach(hub);
  await connection.ready;
  repository.state.rows.push(projectedEvent(1));

  assert.equal(hub.notifyCommitted({
    eventEpoch: EPOCH,
    eventId: 1,
    payload: { rawToken: 'must-never-be-used' },
  }), 1);
  await settle();

  assert.match(response.text(), /"resource":"orders"/);
  assert.doesNotMatch(response.text(), /must-never-be-used|rawToken/);
});

test('a hidden committed range advances with one id-only cursor frame', async (t) => {
  const repository = createRangeRepository({
    rows: [projectedEvent(1), projectedEvent(2)],
    project: () => null,
  });
  const { hub } = createFixture({ repository });
  t.after(() => hub.close());
  const { connection, response } = attach(hub);

  await connection.ready;

  assert.equal(connection.lastEventId, 2);
  assert.match(response.text(), /id: 2\n: cursor/);
  assert.doesNotMatch(response.text(), /event: order\.created|data:/);
});

test('visible events are ordered, paged, and deduplicated by eventId', async (t) => {
  const { hub } = createFixture({
    replayBatchSize: 1,
    repositoryOptions: { rows: [projectedEvent(1), projectedEvent(2), projectedEvent(3)] },
  });
  t.after(() => hub.close());
  const { connection, response } = attach(hub);
  await connection.ready;

  assert.deepEqual(
    [...response.text().matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
    [1, 2, 3],
  );
  const before = response.writes.length;
  assert.equal(hub.notifyCommitted({ eventEpoch: EPOCH, eventId: 3 }), 0);
  await settle();
  assert.equal(response.writes.length, before);
});

test('write false preserves per-connection FIFO until drain', async (t) => {
  let blockEventOne = true;
  const response = new FakeResponse((_writeNumber, frame) => {
    if (blockEventOne && frame.includes('id: 1\n')) {
      blockEventOne = false;
      return false;
    }
    return true;
  });
  const { hub, repository } = createFixture();
  t.after(() => hub.close());
  const { connection } = attach(hub, { response });
  await connection.ready;
  repository.state.rows.push(projectedEvent(1), projectedEvent(2), projectedEvent(3));

  hub.notifyCommitted({ eventEpoch: EPOCH, eventId: 3 });
  await settle();
  assert.match(response.text(), /id: 1/);
  assert.doesNotMatch(response.text(), /id: 2|id: 3/);

  response.emit('drain');
  assert.deepEqual(
    [...response.text().matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
    [1, 2, 3],
  );
});

test('queue overflow destroys only the slow subscriber and never blocks a fast one', async (t) => {
  const { hub, repository } = createFixture({ maxQueueFrames: 1 });
  t.after(() => hub.close());
  let block = true;
  const slowResponse = new FakeResponse((_number, frame) => {
    if (block && frame.includes('id: 1\n')) {
      block = false;
      return false;
    }
    return true;
  });
  const slow = attach(hub, { response: slowResponse });
  const fast = attach(hub);
  await Promise.all([slow.connection.ready, fast.connection.ready]);
  repository.state.rows.push(projectedEvent(1), projectedEvent(2), projectedEvent(3));

  hub.notifyCommitted({ eventEpoch: EPOCH, eventId: 3 });
  await settle();

  assert.equal(slowResponse.destroyed, true);
  assert.equal(slow.connection.active, false);
  assert.equal(fast.connection.active, true);
  assert.deepEqual(
    [...fast.response.text().matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])),
    [1, 2, 3],
  );
});

test('an oversized projected frame is dropped before any unbounded write', async () => {
  const { hub } = createFixture({
    maxQueueBytes: 128,
    repositoryOptions: {
      rows: [projectedEvent(1)],
    },
  });
  const { connection, response } = attach(hub);
  await connection.ready;

  assert.equal(connection.active, false);
  assert.equal(response.destroyed, true);
  assert.doesNotMatch(response.text(), /x{20}/);
  hub.close();
});

test('heartbeat comments are sent only when the subscriber is writable', async (t) => {
  let blockHeartbeat = false;
  const response = new FakeResponse((_number, frame) => {
    if (blockHeartbeat && frame === ': keepalive\n\n') return false;
    return true;
  });
  const { hub, timers } = createFixture();
  t.after(() => hub.close());
  const { connection } = attach(hub, { response });
  await connection.ready;

  timers.tickIntervals();
  assert.equal(response.writes.filter((frame) => frame === ': keepalive\n\n').length, 1);
  blockHeartbeat = true;
  timers.tickIntervals();
  timers.tickIntervals();
  assert.equal(response.writes.filter((frame) => frame === ': keepalive\n\n').length, 2);
  response.emit('drain');
});

test('maximum lifetime ends a connection and releases its listeners', async (t) => {
  const { hub, timers } = createFixture();
  t.after(() => hub.close());
  const { connection, request, response } = attach(hub);
  await connection.ready;

  timers.runTimeouts();

  assert.equal(connection.active, false);
  assert.equal(response.writableEnded, true);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(hub.size, 0);
});

test('request abort, response close, and response error each detach safely', async (t) => {
  const { hub } = createFixture();
  t.after(() => hub.close());
  const first = attach(hub);
  const second = attach(hub);
  const third = attach(hub);
  await Promise.all([first.connection.ready, second.connection.ready, third.connection.ready]);

  first.request.emit('aborted');
  second.response.emit('close');
  third.response.emit('error', new Error('socket failed'));

  assert.equal(first.connection.active, false);
  assert.equal(second.connection.active, false);
  assert.equal(third.connection.active, false);
  assert.equal(hub.size, 0);
});

test('repository failure rejects initial readiness without opening headers', async () => {
  const repository = {
    async readCommittedForPrincipal() {
      throw new Error('database unavailable');
    },
  };
  const { hub } = createFixture({ repository });
  const { connection, response } = attach(hub);

  await assert.rejects(connection.ready, /database unavailable/);
  assert.equal(response.headersSent, false);
  assert.equal(response.destroyed, false);
  assert.equal(hub.size, 0);
  hub.close();
});

test('invalid projected repository data closes only that subscriber', async () => {
  const { hub } = createFixture({
    repositoryOptions: {
      rows: [projectedEvent(1, { type: 'order.created\nmalicious' })],
    },
  });
  const { connection, response } = attach(hub);

  await assert.rejects(connection.ready, /invalid projected event/);
  assert.equal(response.destroyed, true);
  hub.close();
});

test('customer stream rejects cross-role events and payload fields at the hub boundary', async () => {
  for (const maliciousEvent of [
    projectedEvent(1, { audience: 'admin' }),
    projectedEvent(1, {
      payload: {
        resource: 'orders',
        refreshRequired: true,
        tokenHash: 'must-never-leak',
      },
    }),
    projectedEvent(1, {
      type: 'device.paired',
      payload: { resource: 'deviceConfig', refreshRequired: true },
    }),
  ]) {
    const { hub } = createFixture({
      repositoryOptions: { rows: [maliciousEvent] },
    });
    const { connection, response } = attach(hub);
    await assert.rejects(connection.ready, /invalid projected event/);
    assert.equal(response.destroyed, true);
    assert.doesNotMatch(response.text(), /must-never-leak|tokenHash/);
    hub.close();
  }
});

test('epoch-changing notification closes stale streams for snapshot recovery', async (t) => {
  const { hub } = createFixture();
  t.after(() => hub.close());
  const { connection, response } = attach(hub);
  await connection.ready;

  assert.equal(hub.notifyCommitted({ eventEpoch: OTHER_EPOCH, eventId: 1 }), 0);
  assert.equal(connection.active, false);
  assert.equal(response.writableEnded, true);
});

test('a notification racing initial replay is caught up exactly once', async (t) => {
  let resolveInitial;
  const initial = new Promise((resolve) => {
    resolveInitial = resolve;
  });
  let calls = 0;
  const repository = {
    async readCommittedForPrincipal(_principal, request) {
      calls += 1;
      if (calls === 1) return initial;
      return {
        audience: 'customer',
        eventEpoch: EPOCH,
        lastEventId: 1,
        events: [projectedEvent(1)],
        hasMore: false,
      };
    },
  };
  const { hub } = createFixture({ repository });
  t.after(() => hub.close());
  const { connection, response } = attach(hub);
  hub.notifyCommitted({ eventEpoch: EPOCH, eventId: 1 });
  resolveInitial({
    audience: 'customer',
    eventEpoch: EPOCH,
    lastEventId: 0,
    events: [],
    hasMore: false,
  });

  await connection.ready;
  await settle();

  assert.equal(calls, 2);
  assert.equal((response.text().match(/event: order\.created/g) ?? []).length, 1);
  assert.equal(connection.lastEventId, 1);
});

test('hub close clears timers and destroys streams without owning the repository', async () => {
  const { hub, repository, timers } = createFixture();
  const first = attach(hub);
  const second = attach(hub);
  await Promise.all([first.connection.ready, second.connection.ready]);

  hub.close();
  hub.close();

  assert.equal(timers.intervalCount, 0);
  assert.equal(timers.timeoutCount, 0);
  assert.equal(first.response.destroyed, true);
  assert.equal(second.response.destroyed, true);
  assert.equal(repository.state.closed, false);
  assert.equal(hub.size, 0);
  assert.throws(() => attach(hub), /closed/);
});
