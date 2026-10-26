import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryOutbox, createOrderOutbox } from "../src/order-outbox.js";

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const items = [{ menuItemId: "fictional-regression-item", quantity: 1 }];
const success = (idempotencyResult = "created") => ({ kind: "success", idempotencyResult });

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

// Only promise jobs advance here; no real clock, HTTP, or browser is involved.
async function settlePromiseJobs() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

function makeService(send, options = {}) {
  let nextId = 0;
  return createOrderOutbox({
    store: createMemoryOutbox(),
    transport: { enabled: true, canAttempt: () => true, send },
    idFactory: () => uuid(++nextId),
    eventTarget: null,
    autoRetry: false,
    ...options,
  });
}

function fakeTimers() {
  const active = new Set();
  const scheduled = [];
  return {
    active, scheduled,
    set(callback, delay) { const timer = { callback, delay }; active.add(timer); scheduled.push(timer); return timer; },
    clear(timer) { active.delete(timer); },
    fire() {
      assert.equal(active.size, 1, "one retry loop owns the timer");
      const timer = [...active][0];
      active.delete(timer);
      timer.callback();
      return timer.delay;
    },
  };
}

test("flush handoff: saving B while A sends delivers B without a second flush", async (t) => {
  const started = deferred();
  const response = deferred();
  const calls = [];
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    if (payload.clientOrderId === uuid(1)) { started.resolve(); await response.promise; }
    return success();
  });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const flight = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  assert.deepEqual(calls, [a.clientOrderId]);
  response.resolve();
  await flight;
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal((await service.get(b.clientOrderId)).state, "synced");
  assert.equal((await service.list()).length, 2);
});

test("flush handoff: overlapping targeted calls retain each result and send each ID once", async (t) => {
  const started = deferred();
  const response = deferred();
  const calls = [];
  let sending = 0;
  let maximumSending = 0;
  const service = makeService(async (payload) => {
    sending += 1;
    maximumSending = Math.max(maximumSending, sending);
    calls.push(payload.clientOrderId);
    try {
      if (payload.clientOrderId === uuid(1)) { started.resolve(); await response.promise; }
      return success(payload.clientOrderId === uuid(1) ? "created" : "replayed");
    } finally { sending -= 1; }
  });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  const second = service.flush({ clientOrderId: b.clientOrderId });
  const duplicate = service.flush({ clientOrderId: b.clientOrderId, force: true });
  const same = service.flush({ clientOrderId: a.clientOrderId, force: true });
  response.resolve();
  const [aResult, bResult, duplicateResult, sameResult] = await Promise.all([first, second, duplicate, same]);
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal(maximumSending, 1);
  assert.equal(aResult.clientOrderId, a.clientOrderId);
  assert.equal(aResult.idempotencyResult, "created");
  assert.equal(sameResult.clientOrderId, a.clientOrderId);
  assert.equal(bResult.clientOrderId, b.clientOrderId);
  assert.equal(bResult.idempotencyResult, "replayed");
  assert.deepEqual(duplicateResult, bResult);
});

test("flush handoff: B committed after A unlocks still starts without another action", async (t) => {
  const base = createMemoryOutbox();
  const started = deferred();
  const response = deferred();
  const savingB = deferred();
  const commitB = deferred();
  const calls = [];
  const store = {
    ...base,
    async put(record) {
      if (record.clientOrderId === uuid(2)) { savingB.resolve(); await commitB.promise; }
      return base.put(record);
    },
  };
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    if (payload.clientOrderId === uuid(1)) { started.resolve(); await response.promise; }
    return success();
  }, { store });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const saving = service.enqueue({ items });
  await savingB.promise;
  response.resolve();
  await first;
  assert.deepEqual(calls, [a.clientOrderId]);
  commitB.resolve();
  const b = await saving;
  await settlePromiseJobs();
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal((await service.get(b.clientOrderId)).state, "synced");
});

test("flush handoff: a saved order at A's completion notification is not lost", async (t) => {
  const calls = [];
  const service = makeService(async (payload) => { calls.push(payload.clientOrderId); return success(); });
  t.after(() => service.stop());
  let savingB;
  service.subscribe((event) => {
    if (event.clientOrderId === uuid(1) && event.state === "synced") savingB = service.enqueue({ items });
  });
  const a = await service.enqueue({ items });
  await service.flush({ clientOrderId: a.clientOrderId });
  const b = await savingB;
  await settlePromiseJobs();
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal((await service.get(b.clientOrderId)).state, "synced");
});

test("flush handoff: failed A retains its ID and backoff while B is delivered once", async (t) => {
  const started = deferred();
  const response = deferred();
  const timers = fakeTimers();
  const calls = [];
  let time = 10_000;
  let aAttempts = 0;
  const service = makeService(async (payload) => {
    calls.push(structuredClone(payload));
    if (payload.clientOrderId === uuid(1) && ++aAttempts === 1) {
      started.resolve();
      await response.promise;
      return { kind: "retry", errorCode: "NETWORK_ERROR" };
    }
    return success("replayed");
  }, { autoRetry: true, now: () => time, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  response.resolve();
  const result = await first;
  assert.equal(result.clientOrderId, a.clientOrderId);
  assert.equal(result.state, "pending");
  assert.deepEqual(calls.map((payload) => payload.clientOrderId), [a.clientOrderId, b.clientOrderId]);
  assert.equal((await service.get(a.clientOrderId)).state, "pending");
  assert.equal((await service.get(b.clientOrderId)).state, "synced");
  assert.equal(timers.active.size, 1);
  time += 1_000;
  assert.equal(timers.fire(), 1_000);
  await settlePromiseJobs();
  assert.deepEqual(calls.map((payload) => payload.clientOrderId), [a.clientOrderId, b.clientOrderId, a.clientOrderId]);
  assert.deepEqual(calls[0], calls[2]);
  assert.equal((await service.get(a.clientOrderId)).state, "synced");
  assert.equal((await service.get(a.clientOrderId)).attemptCount, 2);
  assert.equal((await service.get(b.clientOrderId)).attemptCount, 1);
  assert.equal((await service.list()).length, 2);
  assert.equal(timers.active.size, 0);
});

test("flush handoff: repeated failures keep one bounded retry timer and both saved orders", async (t) => {
  const started = deferred();
  const response = deferred();
  const timers = fakeTimers();
  const calls = [];
  let time = 10_000;
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    if (calls.length === 1) { started.resolve(); await response.promise; }
    return { kind: "retry", errorCode: "HTTP_503" };
  }, { autoRetry: true, now: () => time, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  response.resolve();
  await first;
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal(timers.scheduled.length, 1);
  time += 1_000;
  assert.equal(timers.fire(), 1_000);
  await settlePromiseJobs();
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId, a.clientOrderId, b.clientOrderId]);
  assert.equal(timers.active.size, 1);
  assert.equal(timers.scheduled.at(-1).delay, 2_000);
  for (const record of await service.list()) {
    assert.equal(record.state, "pending");
    assert.equal(record.attemptCount, 2);
    assert.deepEqual(record.payload.items, items);
  }
});

test("flush handoff: stop preserves queued B without delivering it", async () => {
  const started = deferred();
  const response = deferred();
  const calls = [];
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    started.resolve();
    await response.promise;
    return success();
  });
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  await service.stop();
  response.resolve();
  await first;
  assert.deepEqual(calls, [a.clientOrderId]);
  assert.equal((await service.get(b.clientOrderId)).state, "pending");
});

test("flush handoff: a global snapshot coalesces queued IDs and returns each targeted result", async (t) => {
  const base = createMemoryOutbox();
  const listing = deferred();
  const releaseList = deferred();
  const calls = [];
  let firstList = true;
  const store = {
    ...base,
    async list() {
      if (firstList) { firstList = false; listing.resolve(); await releaseList.promise; }
      return base.list();
    },
  };
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    return success(payload.clientOrderId === uuid(2) ? "replayed" : "created");
  }, { store });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const globalFlush = service.flush();
  await listing.promise;
  const b = await service.enqueue({ items });
  const c = await service.enqueue({ items });
  const targeted = service.flush({ clientOrderId: b.clientOrderId });
  releaseList.resolve();
  const [, result] = await Promise.all([globalFlush, targeted]);
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId, c.clientOrderId]);
  assert.equal(result.clientOrderId, b.clientOrderId);
  assert.equal(result.idempotencyResult, "replayed");
});

test("flush handoff: queued connectivity recovery keeps A's result and does not resend B", async (t) => {
  const started = deferred();
  const response = deferred();
  const calls = [];
  let firstA = true;
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    if (payload.clientOrderId === uuid(1) && firstA) {
      firstA = false;
      started.resolve();
      await response.promise;
      return { kind: "retry", errorCode: "NETWORK_ERROR" };
    }
    return success("replayed");
  });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  const b = await service.enqueue({ items });
  const targeted = service.flush({ clientOrderId: b.clientOrderId });
  const recovery = service.flush({ force: true, connectivityRestored: true });
  response.resolve();
  const [aResult, bResult] = await Promise.all([first, targeted, recovery]);
  assert.deepEqual(calls, [a.clientOrderId, a.clientOrderId, b.clientOrderId]);
  assert.equal(aResult.clientOrderId, a.clientOrderId);
  assert.equal(aResult.state, "synced");
  assert.equal(bResult.clientOrderId, b.clientOrderId);
  assert.equal(bResult.state, "synced");
});

test("flush handoff: a retry timer expiring during slow B is handed off after B", async (t) => {
  const aStarted = deferred();
  const aResponse = deferred();
  const bStarted = deferred();
  const bResponse = deferred();
  const timers = fakeTimers();
  const calls = [];
  let time = 10_000;
  let aAttempts = 0;
  let sending = 0;
  let maximumSending = 0;
  const service = makeService(async (payload) => {
    sending += 1;
    maximumSending = Math.max(maximumSending, sending);
    calls.push(payload.clientOrderId);
    try {
      if (payload.clientOrderId === uuid(1) && ++aAttempts === 1) {
        aStarted.resolve();
        await aResponse.promise;
        return { kind: "retry", errorCode: "NETWORK_ERROR" };
      }
      if (payload.clientOrderId === uuid(2)) { bStarted.resolve(); await bResponse.promise; }
      return success("replayed");
    } finally { sending -= 1; }
  }, { autoRetry: true, now: () => time, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await aStarted.promise;
  const b = await service.enqueue({ items });
  aResponse.resolve();
  await bStarted.promise;
  time += 1_000;
  assert.equal(timers.fire(), 1_000);
  await settlePromiseJobs();
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  bResponse.resolve();
  const result = await first;
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId, a.clientOrderId]);
  assert.equal(result.clientOrderId, a.clientOrderId);
  assert.equal(result.state, "synced");
  assert.equal(maximumSending, 1);
  assert.equal(timers.active.size, 0);
});

for (const failB of [false, true]) {
  test("flush handoff P2: historical review recovery preserves B's targeted " + (failB ? "failure and retry" : "delivery"), async (t) => {
    const base = createMemoryOutbox();
    const started = deferred();
    const response = deferred();
    const timers = fakeTimers();
    const calls = [];
    let time = 10_000;
    let listings = 0;
    let sending = 0;
    let maximumSending = 0;
    let bAttempts = 0;
    const service = makeService(async (payload) => {
      sending += 1;
      maximumSending = Math.max(maximumSending, sending);
      calls.push(structuredClone(payload));
      try {
        if (payload.clientOrderId === uuid(2)) { started.resolve(); await response.promise; }
        if (payload.clientOrderId === uuid(3) && ++bAttempts === 1 && failB) {
          return { kind: "retry", errorCode: "NETWORK_ERROR" };
        }
        return success(payload.clientOrderId === uuid(3) ? "replayed" : "created");
      } finally { sending -= 1; }
    }, {
      store: { ...base, async list() { listings += 1; return base.list(); } },
      autoRetry: true, now: () => time, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
    });
    t.after(() => service.stop());
    const r = await service.enqueue({ items, holdForReview: true });
    const a = await service.enqueue({ items });
    const first = service.flush({ clientOrderId: a.clientOrderId });
    await started.promise;
    const b = await service.enqueue({ items });
    const targeted = service.flush({ clientOrderId: b.clientOrderId });
    const duplicate = service.flush({ clientOrderId: b.clientOrderId, force: true });
    const recovery = service.flush({ force: true, connectivityRestored: true });
    response.resolve();
    const [aResult, bResult, duplicateResult] = await Promise.all([first, targeted, duplicate, recovery]);
    assert.deepEqual({
      sentIds: calls.map((payload) => payload.clientOrderId),
      resultId: bResult.clientOrderId,
      resultState: bResult.state,
    }, {
      sentIds: [a.clientOrderId, b.clientOrderId],
      resultId: b.clientOrderId,
      resultState: failB ? "pending" : "synced",
    }, "the global pass must deliver B once and keep each caller's own result");
    assert.equal(listings, 1, "the queued recovery ran before B's targeted handoff");
    assert.equal(maximumSending, 1);
    assert.equal(aResult.clientOrderId, a.clientOrderId);
    assert.equal(aResult.state, "synced");
    assert.deepEqual(duplicateResult, bResult);
    assert.deepEqual(await service.get(r.clientOrderId), r, "historical review order is unchanged");
    const retainedB = await service.get(b.clientOrderId);
    assert.deepEqual(retainedB.payload, b.payload);
    assert.equal(retainedB.attemptCount, 1);
    if (failB) {
      assert.equal(bResult.errorCode, "NETWORK_ERROR");
      assert.equal(timers.active.size, 1);
      assert.equal(timers.scheduled.length, 1);
      assert.equal(timers.scheduled[0].delay, 1_000);
      const beforeDue = await service.flush({ clientOrderId: b.clientOrderId });
      assert.equal(beforeDue.clientOrderId, b.clientOrderId);
      assert.equal(beforeDue.state, "pending");
      assert.deepEqual(calls.map((payload) => payload.clientOrderId), [a.clientOrderId, b.clientOrderId]);
      time += 1_000;
      assert.equal(timers.fire(), 1_000);
      await settlePromiseJobs();
      assert.equal((await service.get(b.clientOrderId)).state, "synced");
      assert.equal(calls.length, 3, "historical R must not block the due global retry");
      const retried = await service.flush({ clientOrderId: b.clientOrderId });
      assert.equal(retried.clientOrderId, b.clientOrderId);
      assert.equal(retried.state, "synced");
      assert.deepEqual(calls[2], calls[1], "the due automatic retry keeps B's ID and payload");
      assert.equal(calls.length, 3, "the later targeted check must not duplicate the completed retry");
      assert.equal((await service.get(b.clientOrderId)).attemptCount, 2);
      assert.equal(timers.active.size, 0);
    } else {
      assert.equal(bResult.idempotencyResult, "replayed");
      assert.equal(timers.active.size, 0);
    }
    const globalResult = await service.flush({ force: true, connectivityRestored: true });
    assert.equal(globalResult.clientOrderId, r.clientOrderId);
    assert.equal(globalResult.state, "review_required", "R remains held when no pending order is left");
    assert.equal(calls.length, failB ? 3 : 2);
    assert.equal((await service.list()).length, 3);
  });
}

test("flush handoff P2: a target skipped for backoff returns its own pending state", async (t) => {
  const store = createMemoryOutbox();
  const started = deferred();
  const response = deferred();
  const calls = [];
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    started.resolve();
    await response.promise;
    return success();
  }, { store, now: () => 10_000 });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const b = await service.enqueue({ items });
  await store.update(b.clientOrderId, { attemptCount: 1, lastAttemptAt: 10_000, lastErrorCode: "NETWORK_ERROR" });
  const globalFlush = service.flush();
  await started.promise;
  const targeted = service.flush({ clientOrderId: b.clientOrderId });
  response.resolve();
  const [, bResult] = await Promise.all([globalFlush, targeted]);
  assert.deepEqual(calls, [a.clientOrderId], "B must not be retried before its backoff expires");
  assert.deepEqual(bResult, { clientOrderId: b.clientOrderId, state: "pending", errorCode: "NETWORK_ERROR" });
  assert.equal((await service.get(b.clientOrderId)).attemptCount, 1);
  assert.deepEqual((await service.get(b.clientOrderId)).payload, b.payload);
});

for (const savedTarget of [true, false]) {
  test("flush handoff P2: stop returns " + (savedTarget ? "stopped for queued B" : "stopped for a missing target"), async (t) => {
    const started = deferred();
    const response = deferred();
    const calls = [];
    const base = createMemoryOutbox();
    let closed = false;
    const store = {
      ...base,
      async get(id) { assert.equal(closed, false, "result lookup must not read a closed store"); return base.get(id); },
      async close() { closed = true; },
    };
    const service = makeService(async (payload) => {
      calls.push(payload.clientOrderId);
      started.resolve();
      await response.promise;
      return success();
    }, { store });
    t.after(() => service.stop());
    const a = await service.enqueue({ items });
    const first = service.flush({ clientOrderId: a.clientOrderId });
    await started.promise;
    const targetId = savedTarget ? (await service.enqueue({ items })).clientOrderId : uuid(99);
    const targeted = service.flush({ clientOrderId: targetId });
    await service.stop();
    response.resolve();
    const [aResult, targetResult] = await Promise.all([first, targeted]);
    assert.equal(aResult.state, "synced");
    assert.deepEqual(calls, [a.clientOrderId]);
    assert.deepEqual(targetResult, { state: "stopped", clientOrderId: targetId });
    if (savedTarget) {
      const retained = await base.get(targetId);
      assert.equal(retained.state, "pending");
      assert.equal(retained.attemptCount, 0);
    }
  });
}

test("flush result lifetime: empty recovery after B preserves both confirmed successes", async (t) => {
  const base = createMemoryOutbox();
  const aStarted = deferred();
  const aResponse = deferred();
  const bStarted = deferred();
  const bResponse = deferred();
  const calls = [];
  const snapshots = [];
  let sending = 0;
  let maximumSending = 0;
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    sending += 1;
    maximumSending = Math.max(maximumSending, sending);
    try {
      if (payload.clientOrderId === uuid(1)) { aStarted.resolve(); await aResponse.promise; }
      else { bStarted.resolve(); await bResponse.promise; }
      return success(payload.clientOrderId === uuid(1) ? "created" : "replayed");
    } finally { sending -= 1; }
  }, {
    store: {
      ...base,
      async list() {
        const records = await base.list();
        snapshots.push(records.map(({ clientOrderId, state }) => ({ clientOrderId, state })));
        return records;
      },
    },
  });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const first = service.flush({ clientOrderId: a.clientOrderId });
  await aStarted.promise;
  const b = await service.enqueue({ items });
  const targeted = service.flush({ clientOrderId: b.clientOrderId });
  aResponse.resolve();
  await bStarted.promise;
  const recovery = service.flush({ force: true, connectivityRestored: true });
  const sameA = service.flush({ clientOrderId: a.clientOrderId });
  const sameB = service.flush({ clientOrderId: b.clientOrderId, force: true });
  bResponse.resolve();
  const [aResult, bResult, , sameAResult, sameBResult] = await Promise.all([first, targeted, recovery, sameA, sameB]);
  t.diagnostic("result-lifetime-observation " + JSON.stringify({ calls, aResult, bResult, sameAResult, sameBResult, maximumSending }));
  assert.deepEqual(snapshots, [[
    { clientOrderId: a.clientOrderId, state: "synced" },
    { clientOrderId: b.clientOrderId, state: "synced" },
  ]], "the final recovery really ran with A first and no pending records");
  assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
  assert.equal(maximumSending, 1);
  assert.deepEqual(aResult, { state: "synced", clientOrderId: a.clientOrderId, idempotencyResult: "created" });
  assert.deepEqual(bResult, { state: "synced", clientOrderId: b.clientOrderId, idempotencyResult: "replayed" });
  assert.deepEqual(sameAResult, aResult);
  assert.deepEqual(sameBResult, bResult);
  assert.equal((await service.get(a.clientOrderId)).attemptCount, 1);
  assert.equal((await service.get(b.clientOrderId)).attemptCount, 1);
});

for (const state of ["synced", "rejected"]) {
  test("flush result lifetime: a later targeted no-op reads stored " + state + " state", async (t) => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return state === "synced" ? success() : { kind: "rejected", errorCode: "ITEM_SOLD_OUT" };
    });
    t.after(() => service.stop());
    const record = await service.enqueue({ items });
    const first = await service.flush({ clientOrderId: record.clientOrderId });
    assert.equal(first.state, state);
    const later = await service.flush({ clientOrderId: record.clientOrderId });
    assert.deepEqual(later, {
      state, clientOrderId: record.clientOrderId,
      ...(state === "rejected" ? { errorCode: "ITEM_SOLD_OUT" } : {}),
    }, "a new drain reads the stored state without retaining an old attempt result");
    assert.equal(calls, 1);
    assert.equal((await service.get(record.clientOrderId)).attemptCount, 1);
  });
}

test("flush result lifetime: an explicit offline deferral keeps its own transient error", async (t) => {
  const timers = fakeTimers();
  let calls = 0;
  const send = async () => { calls += 1; return success(); };
  const service = makeService(send, {
    transport: { enabled: true, canAttempt: () => false, send },
    autoRetry: true, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
  });
  t.after(() => service.stop());
  const record = await service.enqueue({ items });
  const result = await service.flush({ clientOrderId: record.clientOrderId });
  assert.deepEqual(result, { state: "pending", clientOrderId: record.clientOrderId, errorCode: "OFFLINE" });
  assert.equal((await service.get(record.clientOrderId)).lastErrorCode, null, "the error belongs to this request, not the stored record");
  assert.equal(calls, 0);
  assert.equal(timers.active.size, 1);
  assert.equal(timers.scheduled[0].delay, 1_000);
});

test("flush result lifetime: a later offline pass cannot turn stored success into pending", async (t) => {
  let online = true;
  let calls = 0;
  const send = async () => { calls += 1; return success(); };
  const service = makeService(send, { transport: { enabled: true, canAttempt: () => online, send } });
  t.after(() => service.stop());
  const record = await service.enqueue({ items });
  assert.equal((await service.flush({ clientOrderId: record.clientOrderId })).state, "synced");
  online = false;
  const later = await service.flush({ clientOrderId: record.clientOrderId });
  assert.deepEqual(later, { state: "synced", clientOrderId: record.clientOrderId });
  assert.equal(calls, 1);
  assert.equal((await service.get(record.clientOrderId)).attemptCount, 1);
});

for (const scenario of [
  { name: "failed A is held before B fails", aSucceeds: false, bSucceeds: false },
  { name: "held A stays held when B later succeeds", aSucceeds: false, bSucceeds: true },
  { name: "confirmed A stays synced while B is held", aSucceeds: true, bSucceeds: false },
]) {
  test("flush auth hold: " + scenario.name, async (t) => {
    const base = createMemoryOutbox();
    const aStarted = deferred();
    const aResponse = deferred();
    const bStarted = deferred();
    const bResponse = deferred();
    const timers = fakeTimers();
    const calls = [];
    let resultLookupsForbidden = false;
    let sending = 0;
    let maximumSending = 0;
    const service = makeService(async (payload) => {
      calls.push(payload.clientOrderId);
      sending += 1;
      maximumSending = Math.max(maximumSending, sending);
      try {
        const isA = payload.clientOrderId === uuid(1);
        if (isA) { aStarted.resolve(); await aResponse.promise; }
        else { bStarted.resolve(); await bResponse.promise; }
        return (isA ? scenario.aSucceeds : scenario.bSucceeds)
          ? success(isA ? "created" : "replayed")
          : { kind: "retry", errorCode: "NETWORK_ERROR" };
      } finally { sending -= 1; }
    }, {
      store: {
        ...base,
        async get(id) {
          assert.equal(resultLookupsForbidden, false, "committed results must not require another store read");
          return base.get(id);
        },
      },
      autoRetry: true, now: () => 10_000, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
    });
    t.after(() => service.stop());
    const a = await service.enqueue({ items });
    const first = service.flush({ clientOrderId: a.clientOrderId });
    await aStarted.promise;
    const b = await service.enqueue({ items });
    const targeted = service.flush({ clientOrderId: b.clientOrderId });
    const duplicateA = service.flush({ clientOrderId: a.clientOrderId });
    const duplicateB = service.flush({ clientOrderId: b.clientOrderId });
    aResponse.resolve();
    await bStarted.promise;
    assert.equal((await base.get(a.clientOrderId)).state, scenario.aSucceeds ? "synced" : "pending");
    const heldCount = await service.holdPendingForReview("HTTP_401");
    const heldA = await base.get(a.clientOrderId);
    const heldB = await base.get(b.clientOrderId);
    assert.equal(heldCount, scenario.aSucceeds ? 1 : 2);
    assert.equal(heldA.state, scenario.aSucceeds ? "synced" : "review_required");
    assert.equal(heldB.state, "review_required");
    resultLookupsForbidden = true;
    bResponse.resolve();
    const [aResult, bResult, duplicateAResult, duplicateBResult] = await Promise.all([first, targeted, duplicateA, duplicateB]);
    const storedA = await base.get(a.clientOrderId);
    const storedB = await base.get(b.clientOrderId);
    t.diagnostic("auth-hold-observation " + JSON.stringify({
      scenario: scenario.name, calls, heldCount, aResult, bResult,
      storedA: { clientOrderId: storedA.clientOrderId, state: storedA.state, errorCode: storedA.lastErrorCode },
      storedB: { clientOrderId: storedB.clientOrderId, state: storedB.state, errorCode: storedB.lastErrorCode },
      maximumSending, activeRetryTimers: timers.active.size,
    }));
    assert.deepEqual(aResult, scenario.aSucceeds
      ? { clientOrderId: a.clientOrderId, state: "synced", idempotencyResult: "created" }
      : { clientOrderId: a.clientOrderId, state: "review_required", errorCode: "HTTP_401" });
    assert.deepEqual(bResult, scenario.bSucceeds
      ? { clientOrderId: b.clientOrderId, state: "synced", idempotencyResult: "replayed" }
      : { clientOrderId: b.clientOrderId, state: "review_required", errorCode: "HTTP_401" });
    assert.deepEqual(duplicateAResult, aResult);
    assert.deepEqual(duplicateBResult, bResult);
    assert.equal(storedA.state, aResult.state);
    assert.equal(storedB.state, bResult.state);
    assert.deepEqual(storedA.payload, a.payload);
    assert.deepEqual(storedB.payload, b.payload);
    assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
    assert.equal(maximumSending, 1);
    assert.equal(timers.active.size, 0);
    assert.equal(timers.scheduled.length, scenario.aSucceeds ? 0 : 1);
  });
}

test("flush auth hold: a required result lookup failure rejects without inventing success", async (t) => {
  const base = createMemoryOutbox();
  const started = deferred();
  const response = deferred();
  const readFailure = new Error("FICTIONAL_OUTBOX_READ_FAILURE");
  let failResultRead = false;
  let bId;
  const calls = [];
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    started.resolve();
    await response.promise;
    return success();
  }, {
    store: {
      ...base,
      async get(id) { if (failResultRead && id === bId) throw readFailure; return base.get(id); },
    },
  });
  t.after(() => service.stop());
  const a = await service.enqueue({ items });
  const b = await service.enqueue({ items });
  bId = b.clientOrderId;
  const priorB = await base.update(bId, { state: "synced" });
  const flight = service.flush();
  await started.promise;
  const targeted = service.flush({ clientOrderId: bId });
  const rejected = assert.rejects(targeted, (error) => error === readFailure);
  failResultRead = true;
  response.resolve();
  await Promise.all([flight, rejected]);
  assert.deepEqual(calls, [a.clientOrderId]);
  assert.deepEqual(await base.get(bId), priorB);
});

for (const failureAt of ["list", "update"]) {
  test("flush auth hold: " + failureAt + " failure does not claim an uncommitted hold", async (t) => {
    const base = createMemoryOutbox();
    const aStarted = deferred();
    const aResponse = deferred();
    const bStarted = deferred();
    const bResponse = deferred();
    const timers = fakeTimers();
    const failure = new Error("FICTIONAL_OUTBOX_HOLD_" + failureAt.toUpperCase() + "_FAILURE");
    let failHold = false;
    const calls = [];
    const service = makeService(async (payload) => {
      calls.push(payload.clientOrderId);
      if (payload.clientOrderId === uuid(1)) { aStarted.resolve(); await aResponse.promise; }
      else { bStarted.resolve(); await bResponse.promise; }
      return { kind: "retry", errorCode: "NETWORK_ERROR" };
    }, {
      store: {
        ...base,
        async list() { if (failHold && failureAt === "list") throw failure; return base.list(); },
        async update(id, patch, options) {
          if (failHold && failureAt === "update" && id === uuid(1) && patch.state === "review_required") throw failure;
          return base.update(id, patch, options);
        },
      },
      autoRetry: true, now: () => 10_000, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
    });
    t.after(() => service.stop());
    const a = await service.enqueue({ items });
    const first = service.flush({ clientOrderId: a.clientOrderId });
    await aStarted.promise;
    const b = await service.enqueue({ items });
    const targeted = service.flush({ clientOrderId: b.clientOrderId });
    aResponse.resolve();
    await bStarted.promise;
    failHold = true;
    await assert.rejects(service.holdPendingForReview("HTTP_401"), (error) => error === failure);
    assert.equal((await base.get(a.clientOrderId)).state, "pending", "A's hold was not committed");
    bResponse.resolve();
    const [aResult, bResult] = await Promise.all([first, targeted]);
    assert.equal(aResult.clientOrderId, a.clientOrderId);
    assert.equal(aResult.state, (await base.get(a.clientOrderId)).state);
    assert.equal(bResult.clientOrderId, b.clientOrderId);
    assert.equal(bResult.state, "review_required", "revoked authorization still stops automatic retry");
    assert.deepEqual((await base.get(a.clientOrderId)).payload, a.payload);
    assert.deepEqual(calls, [a.clientOrderId, b.clientOrderId]);
    assert.equal(timers.active.size, 0);
  });
}

for (const keepMapAlive of [false, true]) {
  test("atomic auth hold: a stale snapshot cannot replace success" + (keepMapAlive ? " while callers wait" : " after the caller returns"), async (t) => {
    const base = createMemoryOutbox();
    const aStarted = deferred();
    const aResponse = deferred();
    const savingP = deferred();
    const releaseP = deferred();
    const bLookup = deferred();
    const releaseBLookup = deferred();
    const calls = [];
    let pId;
    let bId;
    const store = {
      ...base,
      async get(id) {
        if (keepMapAlive && id === bId) { bLookup.resolve(); await releaseBLookup.promise; }
        return base.get(id);
      },
      async update(id, patch, options) {
        if (id === pId && patch.state === "review_required") { savingP.resolve(); await releaseP.promise; }
        return base.update(id, patch, options);
      },
    };
    const service = makeService(async (payload) => {
      calls.push(payload.clientOrderId);
      aStarted.resolve();
      await aResponse.promise;
      return success();
    }, { store });
    t.after(() => { releaseP.resolve(); releaseBLookup.resolve(); return service.stop(); });
    const p = await service.enqueue({ items });
    pId = p.clientOrderId;
    const a = await service.enqueue({ items });
    const flight = service.flush({ clientOrderId: a.clientOrderId });
    await aStarted.promise;
    const b = keepMapAlive ? await service.enqueue({ items }) : null;
    bId = b?.clientOrderId;
    const bFlight = b ? service.flush({ clientOrderId: bId }) : null;
    const holding = service.holdPendingForReview("HTTP_401");
    await savingP.promise;
    aResponse.resolve();
    let aResult;
    if (b) await bLookup.promise;
    else aResult = await flight;
    assert.equal((await base.get(a.clientOrderId)).state, "synced", "A's success is committed before P is released");
    releaseP.resolve();
    const heldCount = await holding;
    releaseBLookup.resolve();
    aResult ??= await flight;
    const bResult = b ? await bFlight : null;
    const storedA = await base.get(a.clientOrderId);
    t.diagnostic("atomic-hold-observation " + JSON.stringify({
      keepMapAlive, heldCount, calls, aResult, bResult,
      storedA: { clientOrderId: storedA.clientOrderId, state: storedA.state, errorCode: storedA.lastErrorCode },
    }));
    assert.equal(storedA.state, "synced");
    assert.equal(storedA.lastErrorCode, null);
    assert.deepEqual(aResult, { state: "synced", clientOrderId: a.clientOrderId, idempotencyResult: "created" });
    assert.deepEqual(storedA.payload, a.payload);
    assert.equal(storedA.attemptCount, 1);
    assert.equal((await base.get(pId)).state, "review_required");
    assert.equal(heldCount, b ? 2 : 1, "only records still eligible at write time count as held");
    assert.deepEqual(calls, [a.clientOrderId]);
    if (b) {
      assert.deepEqual(bResult, { state: "review_required", clientOrderId: bId, errorCode: "HTTP_401" });
      assert.equal((await base.get(bId)).state, "review_required");
      assert.deepEqual((await base.get(bId)).payload, b.payload);
    }
  });
}

test("atomic auth hold: success arriving after the hold remains authoritative", async (t) => {
  const base = createMemoryOutbox();
  const started = deferred();
  const response = deferred();
  const calls = [];
  const service = makeService(async (payload) => {
    calls.push(payload.clientOrderId);
    started.resolve();
    await response.promise;
    return success("replayed");
  }, { store: base });
  t.after(() => service.stop());
  const p = await service.enqueue({ items });
  const a = await service.enqueue({ items });
  const flight = service.flush({ clientOrderId: a.clientOrderId });
  await started.promise;
  assert.equal(await service.holdPendingForReview("HTTP_401"), 2);
  assert.equal((await base.get(a.clientOrderId)).state, "review_required");
  response.resolve();
  const result = await flight;
  assert.deepEqual(result, { state: "synced", clientOrderId: a.clientOrderId, idempotencyResult: "replayed" });
  assert.equal((await base.get(a.clientOrderId)).state, "synced");
  assert.equal((await base.get(p.clientOrderId)).state, "review_required");
  assert.deepEqual(calls, [a.clientOrderId]);
});

test("atomic auth hold: conditional store update checks the current state", async (t) => {
  const base = createMemoryOutbox();
  const service = makeService(async () => success(), { store: base });
  t.after(() => service.stop());
  for (const state of ["pending", "sending", "synced", "rejected", "review_required"]) {
    const saved = await service.enqueue({ items });
    const current = await base.update(saved.clientOrderId, { state });
    const held = await base.update(saved.clientOrderId, { state: "review_required", lastErrorCode: "HTTP_401" }, {
      onlyStates: ["pending", "sending"],
    });
    if (["pending", "sending"].includes(state)) {
      assert.equal(held.state, "review_required");
      assert.equal((await base.get(saved.clientOrderId)).lastErrorCode, "HTTP_401");
    } else {
      assert.equal(held, null, "an ineligible state must not be written");
      assert.deepEqual(await base.get(saved.clientOrderId), current);
    }
  }
  assert.equal(await base.update(uuid(999), { state: "review_required" }, { onlyStates: ["pending"] }), null);
});

const currentReviewContext = "v1_" + "b".repeat(64);
const historicalReviewContext = "v1_" + "a".repeat(64);

for (const rFirst of [true, false]) {
  for (const errorCode of ["VISIT_CONTEXT_STALE", "HTTP_401", "VISIT_CONTEXT_UNAVAILABLE"]) {
    for (const recovery of [false, true]) {
      test("review isolation: " + (rFirst ? "R before B, " : "B before R, ") + errorCode + (recovery ? ", recovery" : ", ordinary"), async (t) => {
        const base = createMemoryOutbox();
        const calls = [];
        const checks = [];
        const service = makeService(async (payload) => { calls.push(structuredClone(payload)); return success(); }, {
          store: base,
          transport: {
            canAttempt: () => true,
            async checkVisitContext(id) { checks.push(id); return { status: id === currentReviewContext ? "match" : "stale" }; },
            async send(payload) { calls.push(structuredClone(payload)); return success(); },
          },
        });
        t.after(() => service.stop());
        const saveR = async () => {
          const saved = await service.enqueue({ items, visitContextId: historicalReviewContext, holdForReview: true });
          return base.update(saved.clientOrderId, { lastErrorCode: errorCode });
        };
        const saveB = () => service.enqueue({ items, visitContextId: currentReviewContext });
        let r, b;
        if (rFirst) { r = await saveR(); b = await saveB(); }
        else { b = await saveB(); r = await saveR(); }
        const aggregate = await service.flush(recovery ? { force: true, connectivityRestored: true } : {});
        const expected = { state: "synced", clientOrderId: b.clientOrderId, idempotencyResult: "created" };
        assert.deepEqual(calls, [b.payload], "only the currently valid B is sent once");
        assert.deepEqual(aggregate, expected);
        const own = await service.flush({ clientOrderId: b.clientOrderId });
        assert.deepEqual(own, { state: "synced", clientOrderId: b.clientOrderId });
        assert.deepEqual(checks, [currentReviewContext], "R is neither checked nor reactivated");
        assert.deepEqual(await base.get(r.clientOrderId), r);
        const savedB = await base.get(b.clientOrderId);
        assert.equal(savedB.state, "synced");
        assert.equal(savedB.attemptCount, 1);
        assert.deepEqual(savedB.payload, b.payload);
        assert.equal((await service.flush({ clientOrderId: r.clientOrderId, force: true })).state, "review_required");
        assert.deepEqual(calls, [b.payload], "even forced targeted flush does not resend R");
        t.diagnostic("review-isolation-observation " + JSON.stringify({
          rFirst, historicalReason: errorCode, recovery,
          sentIds: calls.map(p => p.clientOrderId), aggregate, own,
          rState: (await base.get(r.clientOrderId)).state, bState: savedB.state,
        }));
      });
    }
  }
}

for (const contextResult of [
  { status: "stale", errorCode: "VISIT_CONTEXT_STALE" },
  { status: "unauthorized", errorCode: "HTTP_401" },
  { status: "unauthorized", errorCode: "HTTP_403" },
  { status: "unavailable", errorCode: "NETWORK_ERROR" },
]) {
  test("review isolation: current " + contextResult.errorCode + " still prevents B's first send", async (t) => {
    const base = createMemoryOutbox();
    const calls = [];
    const checks = [];
    const service = makeService(async () => { throw new Error("must not send"); }, {
      store: base,
      transport: {
        canAttempt: () => true,
        async checkVisitContext(id) { checks.push(id); return contextResult; },
        async send(payload) { calls.push(payload); return success(); },
      },
    });
    t.after(() => service.stop());
    const r = await service.enqueue({ items, visitContextId: historicalReviewContext, holdForReview: true });
    const b = await service.enqueue({ items, visitContextId: currentReviewContext });
    const global = service.flush({ force: true, connectivityRestored: true });
    const targeted = service.flush({ clientOrderId: b.clientOrderId });
    const [, result] = await Promise.all([global, targeted]);
    const saved = await base.get(b.clientOrderId);
    assert.deepEqual(calls, []);
    assert.deepEqual(checks, [currentReviewContext]);
    assert.equal(result.clientOrderId, b.clientOrderId);
    assert.equal(result.state, contextResult.status === "unavailable" ? "pending" : "review_required");
    assert.equal(result.errorCode, contextResult.errorCode);
    assert.equal(saved.state, result.state);
    assert.equal(saved.attemptCount, 0);
    assert.deepEqual(saved.payload, b.payload);
    assert.deepEqual(await base.get(r.clientOrderId), r);
  });
}

test("review isolation: active authorization revocation blocks new pending B even on recovery", async (t) => {
  const base = createMemoryOutbox();
  const calls = [];
  const timers = fakeTimers();
  const service = makeService(async (payload) => { calls.push(payload); return success(); }, {
    store: base, autoRetry: true, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
  });
  t.after(() => service.stop());
  const r = await service.enqueue({ items, holdForReview: true });
  await service.holdPendingForReview("HTTP_401");
  const b = await service.enqueue({ items, visitContextId: currentReviewContext });
  const global = service.flush({ force: true, connectivityRestored: true });
  const targeted = service.flush({ clientOrderId: b.clientOrderId, force: true });
  const [, result] = await Promise.all([global, targeted]);
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { state: "review_required", clientOrderId: b.clientOrderId, errorCode: "HTTP_401" });
  assert.deepEqual(await base.get(b.clientOrderId), b, "the authorization gate must not send or discard B");
  assert.deepEqual(await base.get(r.clientOrderId), r);
  assert.equal(timers.active.size, 0);
});

test("review isolation: R does not block B's timer and ordinary flush still respects exponential backoff", async (t) => {
  const base = createMemoryOutbox();
  const timers = fakeTimers();
  const calls = [];
  let time = 10_000;
  const service = makeService(async (payload) => {
    calls.push(structuredClone(payload));
    return calls.length < 3 ? { kind: "retry", errorCode: "NETWORK_ERROR" } : success("replayed");
  }, { store: base, now: () => time, autoRetry: true, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
  t.after(() => service.stop());
  const r = await service.enqueue({ items, holdForReview: true });
  const b = await service.enqueue({ items, visitContextId: currentReviewContext });
  const first = await service.flush();
  assert.deepEqual(first, { state: "pending", clientOrderId: b.clientOrderId, errorCode: "NETWORK_ERROR" });
  assert.deepEqual(calls, [b.payload]);
  time += 999;
  await service.flush();
  assert.equal(calls.length, 1, "an ordinary global pass must not defeat backoff");
  time += 1;
  assert.equal(timers.fire(), 1_000);
  await settlePromiseJobs();
  assert.equal(calls.length, 2);
  assert.equal((await base.get(b.clientOrderId)).state, "pending");
  assert.equal(timers.scheduled.length, 2);
  assert.equal(timers.scheduled[1].delay, 2_000);
  time += 1_999;
  await service.flush();
  assert.equal(calls.length, 2);
  time += 1;
  assert.equal(timers.fire(), 2_000);
  await settlePromiseJobs();
  assert.deepEqual(calls, [b.payload, b.payload, b.payload]);
  assert.equal((await base.get(b.clientOrderId)).state, "synced");
  assert.equal((await base.get(b.clientOrderId)).attemptCount, 3);
  assert.deepEqual(await base.get(r.clientOrderId), r);
  assert.equal(timers.active.size, 0);
  assert.deepEqual(await service.flush({ clientOrderId: b.clientOrderId }), { state: "synced", clientOrderId: b.clientOrderId });
});

test("review isolation: offline deferral concerns B and recovery never reactivates R", async (t) => {
  const base = createMemoryOutbox();
  const timers = fakeTimers();
  const calls = [];
  const events = [];
  let available = false;
  const service = makeService(async () => { throw new Error("use the explicit transport"); }, {
    store: base, autoRetry: true, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear,
    transport: {
      canAttempt: () => available, unavailableCode: "OFFLINE",
      async send(payload) { calls.push(payload); return success(); },
    },
  });
  t.after(() => service.stop());
  const r = await service.enqueue({ items, holdForReview: true });
  const b = await service.enqueue({ items, visitContextId: currentReviewContext });
  service.subscribe(event => events.push(event));
  assert.deepEqual(await service.flush(), { state: "pending", clientOrderId: b.clientOrderId, errorCode: "OFFLINE" });
  assert.deepEqual(calls, []);
  assert.deepEqual(events.map(event => [event.clientOrderId, event.state]), [[b.clientOrderId, "pending"]]);
  assert.equal(timers.active.size, 1);
  assert.equal(timers.scheduled[0].delay, 1_000);
  available = true;
  assert.deepEqual(await service.flush({ force: true, connectivityRestored: true }), {
    state: "synced", clientOrderId: b.clientOrderId, idempotencyResult: "created",
  });
  assert.deepEqual(calls, [b.payload]);
  assert.equal(timers.active.size, 0);
  assert.deepEqual(await base.get(r.clientOrderId), r);
  assert.equal((await base.get(b.clientOrderId)).state, "synced");
});

test("review isolation: an already-attempted B retains the existing replay-first visit policy beside R", async (t) => {
  const base = createMemoryOutbox();
  const calls = [];
  const checks = [];
  const service = makeService(async () => { throw new Error("use the explicit transport"); }, {
    store: base, now: () => 10_000,
    transport: {
      canAttempt: () => true,
      async checkVisitContext(id) { checks.push(id); return { status: "stale" }; },
      async send(payload) { calls.push(payload); return success("replayed"); },
    },
  });
  t.after(() => service.stop());
  const r = await service.enqueue({ items, holdForReview: true });
  const b = await service.enqueue({ items, visitContextId: historicalReviewContext });
  await base.update(b.clientOrderId, { attemptCount: 1, lastAttemptAt: 1, lastErrorCode: "NETWORK_ERROR" });
  const result = await service.flush();
  assert.deepEqual(result, { state: "synced", clientOrderId: b.clientOrderId, idempotencyResult: "replayed" });
  assert.deepEqual(checks, [historicalReviewContext]);
  assert.deepEqual(calls, [b.payload], "the existing ID/context reach the replay-first server contract");
  assert.deepEqual(await base.get(r.clientOrderId), r);
  assert.equal((await base.get(b.clientOrderId)).state, "synced");
  assert.equal((await base.get(b.clientOrderId)).attemptCount, 2);
});

async function claimAuthFixture(t, { failureAt = null } = {}) {
  const base = createMemoryOutbox();
  const claimStarted = deferred(), releaseClaim = deferred();
  const holdListed = deferred(), releaseHoldList = deferred();
  const calls = [], events = [];
  const failure = new Error("FICTIONAL_CLAIM_AUTH_" + (failureAt || "CONTROL").toUpperCase());
  let listings = 0, failedSave = false, bId, holding;
  const store = {
    ...base,
    async list() {
      if (++listings === 2) { holdListed.resolve(); await releaseHoldList.promise; }
      return base.list();
    },
    async claim(id, time) {
      const claimed = failureAt === "claim" ? null : await base.claim(id, time);
      claimStarted.resolve();
      await releaseClaim.promise;
      if (failureAt === "claim") throw failure;
      return claimed;
    },
    async update(id, patch, options) {
      if (id === bId && patch.state === "review_required" && failureAt === "save" && !failedSave) {
        failedSave = true;
        throw failure;
      }
      return base.update(id, patch, options);
    },
    async get(id) {
      if (id === bId && failureAt === "read") throw failure;
      return base.get(id);
    },
  };
  const service = makeService(async (payload) => { calls.push(structuredClone(payload)); return success(); }, { store });
  service.subscribe(event => events.push(event));
  const r = await service.enqueue({ items, holdForReview: true });
  const b = await service.enqueue({ items, visitContextId: currentReviewContext });
  bId = b.clientOrderId;
  const flight = service.flush();
  const targeted = service.flush({ clientOrderId: bId });
  flight.catch(() => {}); targeted.catch(() => {});
  t.after(async () => {
    releaseClaim.resolve(); releaseHoldList.resolve();
    await Promise.allSettled([flight, targeted, holding].filter(Boolean));
    await service.stop();
  });
  const startHold = (code = "HTTP_401") => {
    holding = service.holdPendingForReview(code);
    holding.catch(() => {});
    return holding;
  };
  await claimStarted.promise;
  return { base, service, r, b, flight, targeted, calls, events, failure, releaseClaim, holdListed, releaseHoldList, startHold };
}

for (const code of ["HTTP_401", "HTTP_403"]) {
  test("claim authorization: revocation during claim stops a new send with " + code, async (t) => {
    const f = await claimAuthFixture(t);
    const holding = f.startHold(code);
    await f.holdListed.promise;
    f.releaseClaim.resolve();
    const [aggregate, own] = await Promise.all([f.flight, f.targeted]);
    const saved = await f.base.get(f.b.clientOrderId);
    t.diagnostic("claim-auth-observation " + JSON.stringify({
      code, sendCount: f.calls.length, aggregate, own,
      saved: { clientOrderId: saved.clientOrderId, state: saved.state, errorCode: saved.lastErrorCode, attemptCount: saved.attemptCount },
    }));
    assert.equal(f.calls.length, 0, "authorization was revoked before transport.send began");
    const expected = { state: "review_required", clientOrderId: f.b.clientOrderId, errorCode: code };
    assert.deepEqual(aggregate, expected);
    assert.deepEqual(own, expected);
    assert.equal(saved.state, "review_required");
    assert.equal(saved.lastErrorCode, code);
    assert.equal(saved.attemptCount, 1, "the claim remains accounted for without leaving a sending record");
    assert.deepEqual(saved.payload, f.b.payload);
    assert.equal(f.events.some(e => e.clientOrderId === f.b.clientOrderId && e.displayState === "sending"), false);
    f.releaseHoldList.resolve();
    assert.equal(await holding, 0, "the later snapshot must not rewrite the already committed hold");
    assert.deepEqual(await f.base.get(f.r.clientOrderId), f.r);
  });
}

test("claim authorization: a claim with no revocation still sends B once", async (t) => {
  const f = await claimAuthFixture(t);
  f.releaseClaim.resolve();
  const [aggregate, own] = await Promise.all([f.flight, f.targeted]);
  assert.deepEqual(f.calls, [f.b.payload]);
  assert.deepEqual(aggregate, { state: "synced", clientOrderId: f.b.clientOrderId, idempotencyResult: "created" });
  assert.deepEqual(own, aggregate);
  assert.equal((await f.base.get(f.b.clientOrderId)).state, "synced");
  assert.equal((await f.base.get(f.b.clientOrderId)).attemptCount, 1);
  assert.deepEqual(await f.base.get(f.r.clientOrderId), f.r);
});

test("claim authorization: an already committed hold is not followed by a stale claimed send", async (t) => {
  const f = await claimAuthFixture(t);
  const holding = f.startHold("HTTP_403");
  await f.holdListed.promise;
  f.releaseHoldList.resolve();
  assert.equal(await holding, 1);
  const held = await f.base.get(f.b.clientOrderId);
  assert.equal(held.state, "review_required");
  f.releaseClaim.resolve();
  const [aggregate, own] = await Promise.all([f.flight, f.targeted]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(own, { state: "review_required", clientOrderId: f.b.clientOrderId, errorCode: "HTTP_403" });
  assert.deepEqual(aggregate, own);
  assert.deepEqual(await f.base.get(f.b.clientOrderId), held);
});

for (const state of ["synced", "rejected", "review_required"]) {
  test("claim authorization: the stop preserves a concurrent " + state + " update", async (t) => {
    const f = await claimAuthFixture(t);
    const holding = f.startHold();
    await f.holdListed.promise;
    const lastErrorCode = state === "synced" ? null : state === "rejected" ? "SOLD_OUT" : "VISIT_CONTEXT_STALE";
    const current = await f.base.update(f.b.clientOrderId, { state, lastErrorCode });
    f.releaseClaim.resolve();
    const [aggregate, own] = await Promise.all([f.flight, f.targeted]);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(own, { state, clientOrderId: f.b.clientOrderId, ...(lastErrorCode ? { errorCode: lastErrorCode } : {}) });
    assert.deepEqual(aggregate, own);
    assert.deepEqual(await f.base.get(f.b.clientOrderId), current);
    f.releaseHoldList.resolve();
    assert.equal(await holding, 0);
  });
}

for (const failureAt of ["claim", "save", "read"]) {
  test("claim authorization: " + failureAt + " failure rejects the waiting callers without a send", async (t) => {
    const f = await claimAuthFixture(t, { failureAt });
    const holding = f.startHold();
    await f.holdListed.promise;
    if (failureAt === "read") await f.base.update(f.b.clientOrderId, { state: "synced" });
    const rejected = Promise.all([f.flight, f.targeted].map(p => assert.rejects(p, error => error === f.failure)));
    f.releaseClaim.resolve();
    await rejected;
    assert.deepEqual(f.calls, []);
    const retained = await f.base.get(f.b.clientOrderId);
    assert.equal(retained.state, failureAt === "claim" ? "pending" : failureAt === "save" ? "sending" : "synced");
    assert.deepEqual(retained.payload, f.b.payload);
    assert.equal(f.events.some(e => e.clientOrderId === f.b.clientOrderId && e.displayState === "review_required"), false, "a failed save/read must not publish a fictitious hold");
    f.releaseHoldList.resolve();
    assert.equal(await holding, failureAt === "read" ? 0 : 1);
    assert.equal((await f.base.get(f.b.clientOrderId)).state, failureAt === "read" ? "synced" : "review_required");
  });
}

test("claim authorization: revocation by a sending observer is checked before transport.send", async (t) => {
  const f = await claimAuthFixture(t);
  let holding;
  f.service.subscribe(event => {
    if (event.clientOrderId === f.b.clientOrderId && event.displayState === "sending") holding = f.startHold();
  });
  f.releaseClaim.resolve();
  await f.holdListed.promise;
  const [aggregate, own] = await Promise.all([f.flight, f.targeted]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(own, { state: "review_required", clientOrderId: f.b.clientOrderId, errorCode: "HTTP_401" });
  assert.deepEqual(aggregate, own);
  assert.equal((await f.base.get(f.b.clientOrderId)).state, own.state);
  f.releaseHoldList.resolve();
  await holding;
});
