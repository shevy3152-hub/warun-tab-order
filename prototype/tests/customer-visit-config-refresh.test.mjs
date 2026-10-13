import test from "node:test";
import assert from "node:assert/strict";
import { createCustomerVisitConfigRefresher } from "../src/customer-visit-config-refresh.js";
import { createCustomerOrderStartNoticeScopeKey } from "../src/customer-order-start-notice.js";
import { createCustomerOrderClient, createMemoryOutbox } from "../src/order-outbox.js";

const config = { role: "customer", tableId: 1, visitContextId: "v1_" + "a".repeat(64) };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    setTimeoutImpl(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= now);
        if (!due) break;
        timers.delete(due[0]); due[1].fn(); await flush();
      }
      await flush();
    },
    pending() { return timers.size; },
  };
}

test("initial visit fetch fills a missing cached visit scope without an SSE reconnect", async () => {
  const timers = clock();
  let resolve, calls = 0;
  let scope = createCustomerOrderStartNoticeScopeKey({ deviceId: "fixture-device", tableId: 1 });
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: () => { calls++; return new Promise(r => { resolve = r; }); },
    onConfig: fresh => { scope = createCustomerOrderStartNoticeScopeKey({ ...fresh, deviceId: "fixture-device" }); },
  });
  assert.equal(calls, 1);
  assert.equal(scope, null);
  const pending = reader.refresh();
  assert.equal(calls, 1);
  resolve(config); await pending;
  assert.ok(scope);
  assert.equal(timers.pending(), 0);
  reader.stop();
});

test("transient failure retries after 3 seconds independently of SSE", async () => {
  const timers = clock();
  let calls = 0, applied = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: async () => ++calls === 1 ? null : config, onConfig: () => applied++,
  });
  await reader.refresh();
  await timers.advance(2999);
  assert.equal(calls, 1); assert.equal(applied, 0);
  await timers.advance(1);
  assert.equal(calls, 2); assert.equal(applied, 1);
  reader.stop();
});

test("hanging GET aborts after 10 seconds and retries 3 seconds later without enabling early", async () => {
  const timers = clock();
  let calls = 0, firstSignal, applied = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers,
    getConfig: ({ signal }) => {
      calls++;
      if (calls === 1) { firstSignal = signal; return new Promise(() => {}); }
      return Promise.resolve(config);
    },
    onConfig: () => applied++,
  });
  await timers.advance(9999);
  assert.equal(firstSignal.aborted, false); assert.equal(applied, 0);
  await timers.advance(1);
  assert.equal(firstSignal.aborted, true); assert.equal(applied, 0);
  await timers.advance(2999);
  assert.equal(calls, 1);
  await timers.advance(1);
  assert.equal(calls, 2); assert.equal(applied, 1);
  reader.stop();
});

test("unauthorized response keeps visit unavailable and does not retry authentication", async () => {
  const timers = clock();
  let calls = 0, applied = 0, unauthorized = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: async () => { calls++; return { status: "unauthorized", errorCode: "HTTP_401" }; },
    onConfig: () => applied++, onAuthorizationFailure: () => unauthorized++,
  });
  await reader.refresh(); await timers.advance(303000); await reader.refresh();
  assert.equal(calls, 1); assert.equal(applied, 0); assert.equal(unauthorized, 1);
  assert.equal(timers.pending(), 0);
  reader.stop();
});

test("stop cancels timers and ignores a late successful config", async () => {
  const timers = clock();
  let resolve, signal, applied = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: input => { signal = input.signal; return new Promise(r => { resolve = r; }); },
    onConfig: () => applied++,
  });
  const pending = reader.refresh();
  reader.stop(); resolve(config); await pending;
  assert.equal(signal.aborted, true); assert.equal(applied, 0); assert.equal(timers.pending(), 0);
});

test("thrown authentication failure is blocked rather than retried", async () => {
  const timers = clock();
  let unauthorized = 0, calls = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: async () => { calls++; throw { status: 401 }; },
    onConfig: () => assert.fail("Must not enable on authentication failure"),
    onAuthorizationFailure: () => unauthorized++,
  });
  await reader.refresh(); await timers.advance(3000);
  assert.equal(calls, 1); assert.equal(unauthorized, 1); assert.equal(timers.pending(), 0);
  reader.stop();
});

test("invalid visit response never provides a ready scope", async () => {
  const timers = clock();
  let applied = 0;
  const reader = createCustomerVisitConfigRefresher({
    ...timers, getConfig: async () => ({ role: "customer", tableId: 1, visitContextId: null }),
    onConfig: () => applied++,
  });
  await reader.refresh();
  assert.equal(applied, 0);
  reader.stop(); assert.equal(timers.pending(), 0);
});

test("device config GET forwards the abort signal and preserves validation", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const client = createCustomerOrderClient({
    global: { WARUN_ORDER_MODE: "api", WARUN_API_BASE: "http://fixture.invalid/v1", WARUN_API_TOKEN: "fixture-token", navigator: { onLine: true } },
    store: createMemoryOutbox(),
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://fixture.invalid/v1/device/config");
      receivedSignal = options.signal;
      return { ok: true, json: async () => config };
    },
  });
  assert.deepEqual(await client.getDeviceConfig({ signal: controller.signal }), config);
  assert.equal(receivedSignal, controller.signal);
  await client.stop();
});
