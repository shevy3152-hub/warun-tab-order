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
  test("flush handoff P2: review-blocked recovery preserves B's targeted " + (failB ? "failure and retry" : "delivery"), async (t) => {
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
    }, "the review-blocked global pass must neither consume B nor return R's result to B");
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
      assert.equal((await service.get(b.clientOrderId)).state, "pending");
      assert.equal(calls.length, 2, "finding 4 still holds the timer's global retry behind R");
      const retried = await service.flush({ clientOrderId: b.clientOrderId });
      assert.equal(retried.clientOrderId, b.clientOrderId);
      assert.equal(retried.state, "synced");
      assert.deepEqual(calls[2], calls[1], "the due targeted retry keeps B's ID and payload");
      assert.equal(calls.length, 3);
      assert.equal((await service.get(b.clientOrderId)).attemptCount, 2);
      assert.equal(timers.active.size, 0);
    } else {
      assert.equal(bResult.idempotencyResult, "replayed");
      assert.equal(timers.active.size, 0);
    }
    const globalResult = await service.flush({ force: true, connectivityRestored: true });
    assert.equal(globalResult.clientOrderId, r.clientOrderId);
    assert.equal(globalResult.state, "review_required", "finding 4's global guard is preserved");
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
        async update(id, patch) {
          if (failHold && failureAt === "update" && id === uuid(1) && patch.state === "review_required") throw failure;
          return base.update(id, patch);
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
