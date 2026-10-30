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

function pendingConfigRequests() {
  const requests = [];
  return {
    requests,
    getConfig({ signal }) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      requests.push({ resolve, signal });
      return promise;
    },
  };
}
const configB = { ...config, tableId: 2, visitContextId: "v1_" + "b".repeat(64) };
const configC = { ...config, tableId: 3, visitContextId: "v1_" + "c".repeat(64) };

test("post-connection refresh coalesces one serial follow-up and rejects the older shared result", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const ordinary = reader.refresh(), fresh = reader.refresh({ afterCurrent: true });
  assert.equal(reader.refresh(), ordinary);
  assert.equal(reader.refresh({ afterCurrent: true }), fresh);
  assert.equal(transport.requests.length, 1);
  transport.requests[0].resolve(config); assert.equal(await ordinary, null);
  assert.equal(transport.requests.length, 2); assert.deepEqual(applied, []);
  transport.requests[1].resolve(configB); assert.deepEqual(await fresh, configB);
  assert.deepEqual(applied, [configB]); assert.equal(timers.pending(), 0);
  reader.stop();
});

test("a newer connection during the follow-up requires one later GET and cannot accept the earlier response", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const first = reader.refresh({ afterCurrent: true });
  transport.requests[0].resolve(config); await flush();
  assert.equal(transport.requests.length, 2);
  const latest = reader.refresh({ afterCurrent: true });
  assert.equal(reader.refresh({ afterCurrent: true }), latest);
  assert.equal(transport.requests.length, 2);
  transport.requests[1].resolve(configB); assert.equal(await first, null);
  assert.equal(transport.requests.length, 3); assert.deepEqual(applied, []);
  transport.requests[2].resolve(configC); assert.deepEqual(await latest, configC);
  assert.deepEqual(applied, [configC]); assert.equal(timers.pending(), 0); reader.stop();
});

test("fresh refresh while idle starts one new request without an extra follow-up", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const initial = reader.refresh(); transport.requests[0].resolve(config); await initial;
  const fresh = reader.refresh({ afterCurrent: true }); assert.equal(transport.requests.length, 2);
  transport.requests[1].resolve(configB); await fresh; await flush();
  assert.equal(transport.requests.length, 2); assert.deepEqual(applied, [config, configB]); reader.stop();
});

test("a failed follow-up is not a sync success and its existing retry meets the freshness boundary", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const fresh = reader.refresh({ afterCurrent: true }); transport.requests[0].resolve(config); await flush();
  transport.requests[1].resolve(null); assert.equal(await fresh, null); assert.deepEqual(applied, []);
  await timers.advance(2999); assert.equal(transport.requests.length, 2);
  await timers.advance(1); assert.equal(transport.requests.length, 3);
  transport.requests[2].resolve(configB); await flush(); assert.deepEqual(applied, [configB]);
  assert.equal(timers.pending(), 0); reader.stop();
});

test("a stale request timeout releases only one queued follow-up and its late success cannot overwrite it", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const fresh = reader.refresh({ afterCurrent: true }); await timers.advance(10000);
  assert.equal(transport.requests[0].signal.aborted, true); assert.equal(transport.requests.length, 2);
  transport.requests[1].resolve(configB); await fresh; transport.requests[0].resolve(config); await flush();
  assert.deepEqual(applied, [configB]); assert.equal(timers.pending(), 0); reader.stop();
});

test("stop resolves a queued freshness wait without starting another request", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c) });
  const fresh = reader.refresh({ afterCurrent: true }); reader.stop(); assert.equal(await fresh, null);
  transport.requests[0].resolve(config); await flush(); assert.equal(transport.requests.length, 1);
  assert.deepEqual(applied, []); assert.equal(timers.pending(), 0);
});

test("authorization failure still blocks a queued fresh request", async () => {
  const timers = clock(), transport = pendingConfigRequests(), applied = [], failures = [];
  const reader = createCustomerVisitConfigRefresher({ ...timers, ...transport, onConfig: c => applied.push(c), onAuthorizationFailure: code => failures.push(code) });
  const fresh = reader.refresh({ afterCurrent: true });
  transport.requests[0].resolve({ status: "unauthorized", errorCode: "HTTP_401" }); assert.equal(await fresh, null);
  assert.equal(transport.requests.length, 1); assert.deepEqual(applied, []); assert.deepEqual(failures, ["HTTP_401"]);
  assert.equal(timers.pending(), 0); reader.stop();
});
