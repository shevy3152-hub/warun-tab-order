import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createKitchenRefresher, KITCHEN_REFRESH_TIMEOUT_MS } from "../src/kitchen-refresh.js";
import { KitchenApiError, fetchKitchenCheckoutRequests } from "../src/kitchen-api.js";
import { createKitchenOrderSound } from "../src/kitchen-order-sound.js";

const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function clock() {
  let now = 0, next = 0;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++next; jobs.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn, ms) { const id = ++next; jobs.set(id, { at: now + ms, fn, ms }); return id; },
    clearInterval(id) { jobs.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const job = [...jobs].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!job) break;
        now = job[1].at;
        jobs.delete(job[0]);
        if (job[1].ms) jobs.set(job[0], { ...job[1], at: now + job[1].ms });
        job[1].fn(); await flush();
      }
      now = end; await flush();
    },
    size: () => jobs.size,
  };
}
async function appFixture({ bindings = {} } = {}) {
  const timers = clock(), requests = [], apiStates = [], checkoutStates = [];
  let events, cleanup, stateIndex = 0;
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const begin = source.indexOf("export function App() {");
  const end = source.indexOf("  useEffect(() => {\n    let cancelled = false;\n    const bootstrap", begin);
  assert.ok(begin >= 0 && end > begin, "Exercise the real App kitchen setup and refresh callbacks");
  const body = source.slice(begin, end).replace("export function", "function");
  const fetchPart = (kind, { signal } = {}) => {
    const item = { kind, signal, at: timers.now(), ...deferred() }; requests.push(item); return item.promise;
  };
  const scope = {
    window: { ...timers, location: { search: "" } }, URLSearchParams,
    localStorage: { getItem: () => null }, STORAGE_KEY: "fixture", defaultState: {},
    createKitchenRefresher, KitchenApiError,
    useRoute: () => "/kitchen",
    useState(initial) {
      const index = stateIndex++;
      let state = typeof initial === "function" ? initial() : initial;
      return [state, update => { state = typeof update === "function" ? update(state) : update; if (index === 2) apiStates.push(state); if (index === 3) checkoutStates.push(state); }];
    },
    useRef: value => ({ current: value }),
    useEffect: fn => { cleanup = fn(); },
    kitchenApiConfigured: () => true,
    fetchKitchenSnapshot: options => fetchPart("snapshot", options),
    fetchKitchenCheckoutRequests: options => fetchPart("checkouts", options),
    subscribeKitchenInvalidations: options => { events = options; return () => {}; },
    ...bindings,
  };
  const app = vm.runInNewContext(body + "\n return { refreshKitchenCheckouts, serveKitchenItem, saveKitchenItemPrice, adjustKitchenItemQuantity, changeKitchenOrderItemCancellation, saveCheckout, readyCheckout, cancelCheckout, payCheckout };\n}\nApp();", scope);
  await flush();
  return { timers, requests, apiStates, checkoutStates, app, events: () => events, stop: () => cleanup?.(),
    async complete(index, id) {
      const snapshot = requests.filter(x => x.kind === "snapshot")[index];
      const checkouts = requests.filter(x => x.kind === "checkouts")[index];
      snapshot.resolve({ orders: [{ id }], staffCalls: [], sessions: [], notificationRequestStartedAt: snapshot.at });
      checkouts.resolve([]); await flush();
    },
  };
}
test("slow kitchen responses remain visible across repeated two-second poll ticks", async () => {
  const f = await appFixture();
  try {
    for (let index = 0; index < 3; index++) {
      await f.timers.advance(2500);
      await f.complete(index, "fixture-order-" + index);
      assert.equal(f.apiStates.at(-1)?.orders?.[0]?.id, "fixture-order-" + index,
        "A normal response after 2.5 seconds must be adopted despite intervening poll requests");
    }
  } finally { f.stop(); }
});

function readerFixture({ onData } = {}) {
  const timers = clock(), requests = [], applied = [], errors = [];
  const reader = createKitchenRefresher({
    load({ signal }) { const request = { signal, at: timers.now(), ...deferred() }; requests.push(request); return request.promise; },
    onData(data, options) { applied.push({ data, ...options }); onData?.(data, options); },
    onError: error => errors.push(error),
    setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout,
  });
  return { reader, timers, requests, applied, errors };
}
test("poll, SSE and manual requests share exactly one trailing read and receive its result", async () => {
  const f = readerFixture(), first = f.reader.refresh();
  await flush();
  const manual = f.reader.refresh(), sse = f.reader.refresh(), poll = f.reader.refresh();
  assert.equal(manual, sse); assert.equal(sse, poll); assert.equal(f.requests.length, 1);
  f.requests[0].resolve("older"); assert.equal(await first, "older"); await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.applied[0].data, "older");
  f.requests[1].resolve("newer"); assert.equal(await manual, "newer"); await flush();
  assert.deepEqual(f.applied.map(x => x.data), ["older", "newer"]);
  assert.equal(f.requests.length, 2); assert.equal(f.timers.size(), 0); f.reader.stop();
});
test("a request reentered from result application is retained across lock release", async () => {
  let trailing;
  const f = readerFixture({ onData(data) { if (data === "first") trailing = f.reader.refresh(); } });
  const first = f.reader.refresh(); await flush();
  f.requests[0].resolve("first"); await first; await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve("trailing"); assert.equal(await trailing, "trailing"); await flush();
  assert.equal(f.requests.length, 2); f.reader.stop();
});
test("a caller requesting immediately after completion starts one new read", async () => {
  const f = readerFixture(), first = f.reader.refresh(); await flush();
  f.requests[0].resolve(1); await first;
  const second = f.reader.refresh(); await flush(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(2); assert.equal(await second, 2); f.reader.stop();
});
test("a transient failure rejects its callers but preserves an already queued refresh", async () => {
  const f = readerFixture(), first = f.reader.refresh(), failed = assert.rejects(first, /fixture failure/);
  await flush(); const next = f.reader.refresh();
  f.requests[0].reject(new Error("fixture failure")); await failed; await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.errors.length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[1].resolve("recovered"); assert.equal(await next, "recovered");
  assert.equal(f.applied[0].suppressStaffCalls, true); f.reader.stop();
});
test("timeout releases the read, aborts it and ignores its late success after newer data", async () => {
  const f = readerFixture(), first = f.reader.refresh();
  const timeout = assert.rejects(first, { code: "TIMEOUT" });
  await flush(); const trailing = f.reader.refresh();
  await f.timers.advance(KITCHEN_REFRESH_TIMEOUT_MS);
  await timeout; assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.requests.length, 2);
  f.requests[1].resolve("new"); assert.equal(await trailing, "new");
  f.requests[0].resolve("obsolete"); await flush();
  assert.deepEqual(f.applied.map(x => x.data), ["new"]); assert.equal(f.timers.size(), 0); f.reader.stop();
});
test("failure and timeout do not schedule a private immediate retry loop", async () => {
  const f = readerFixture(), first = f.reader.refresh(), failure = assert.rejects(first);
  await flush(); f.requests[0].reject(new Error("fixture")); await failure;
  await f.timers.advance(60000); assert.equal(f.requests.length, 1);
  const second = f.reader.refresh(), timeout = assert.rejects(second, { code: "TIMEOUT" });
  await f.timers.advance(KITCHEN_REFRESH_TIMEOUT_MS); await timeout;
  await f.timers.advance(60000); assert.equal(f.requests.length, 2); f.reader.stop();
});
for (const status of [401, 403]) test("HTTP " + status + " rejects active/trailing callers and blocks late data and further reads", async () => {
  const f = readerFixture(), first = f.reader.refresh();
  const error = Object.assign(new Error("fixture authorization"), { status });
  const failed = assert.rejects(first, error); await flush();
  const queued = assert.rejects(f.reader.refresh(), error);
  f.requests[0].reject(error); await failed; await queued;
  await assert.rejects(f.reader.refresh(), error); await f.timers.advance(60000);
  assert.equal(f.requests.length, 1); assert.equal(f.applied.length, 0); assert.equal(f.errors.length, 1); f.reader.stop();
});
test("stop rejects active and trailing waiters even when the transport ignores abort", async () => {
  const f = readerFixture(), active = assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
  await flush(); const trailing = assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
  f.reader.stop(); await active; await trailing; await flush();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.timers.size(), 0);
  f.requests[0].resolve("late"); await flush(); assert.equal(f.applied.length, 0);
  await assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
});
test("a synchronous loader throw follows the same error and later recovery path", async () => {
  let fail = true; const errors = [], values = [];
  const reader = createKitchenRefresher({
    load() { if (fail) throw new Error("sync fixture"); return 7; },
    onError: x => errors.push(x), onData: x => values.push(x),
  });
  await assert.rejects(reader.refresh(), /sync fixture/); fail = false;
  assert.equal(await reader.refresh(), 7); assert.equal(errors.length, 1); assert.deepEqual(values, [7]); reader.stop();
});
test("reconnect during a read suppresses calls through the post-reconnect baseline only", async () => {
  const f = readerFixture(), first = f.reader.refresh(); await flush();
  const baseline = f.reader.refresh({ suppressStaffCalls: true });
  f.requests[0].resolve(1); await first; await flush();
  f.requests[1].resolve(2); await baseline;
  const next = f.reader.refresh(); await flush(); f.requests[2].resolve(3); await next;
  assert.deepEqual(f.applied.map(x => x.suppressStaffCalls), [true, true, false]); f.reader.stop();
});
test("App manual and SSE refreshes use the trailing pair rather than overlapping or rolling back state", async () => {
  const f = await appFixture();
  try {
    const manual = f.app.refreshKitchenCheckouts(); let done = false; void manual.then(() => { done = true; });
    f.events().onEvent({ resource: "checkout" }); f.events().onEvent({ type: "staff_call.created" });
    assert.equal(f.requests.length, 2);
    await f.complete(0, "old"); assert.equal(done, false);
    assert.equal(f.requests.length, 4);
    await f.complete(1, "new"); assert.deepEqual(JSON.parse(JSON.stringify(await manual)), []);
    assert.equal(f.apiStates.at(-1).orders[0].id, "new"); assert.equal(f.requests.length, 4);
  } finally { f.stop(); }
});
test("App route departure aborts both GETs and a later kitchen instance ignores old responses", async () => {
  const old = await appFixture(); old.stop(); await flush();
  assert.ok(old.requests.every(x => x.signal.aborted));
  const count = old.apiStates.length, next = await appFixture();
  try {
    await next.complete(0, "current"); await old.complete(0, "old-route");
    assert.equal(old.apiStates.length, count); assert.equal(next.apiStates.at(-1).orders[0].id, "current");
  } finally { next.stop(); }
});
test("App pairs errors atomically, rejects a manual refresh and recovers on the next poll", async () => {
  const f = await appFixture();
  try {
    await f.complete(0, "baseline");
    const failure = assert.rejects(f.app.refreshKitchenCheckouts(), /fixture read failure/); await flush();
    f.requests[2].reject(new Error("fixture read failure")); await failure; await flush();
    assert.equal(f.apiStates.at(-1).error, true); assert.equal(f.requests[3].signal.aborted, true);
    await f.timers.advance(2000); await f.complete(2, "recovered");
    f.requests[3].resolve([{ checkoutRequestId: "late" }]); await flush();
    assert.equal(f.apiStates.at(-1).orders[0].id, "recovered");
    assert.equal(f.checkoutStates.at(-1).checkouts.length, 0);
  } finally { f.stop(); }
});
test("App authorization failure on one GET never applies its late sibling or retries on poll/SSE", async () => {
  const f = await appFixture();
  try {
    f.events().onEvent({ resource: "checkout" });
    f.requests[0].reject(Object.assign(new Error("fixture auth"), { status: 401 })); await flush();
    f.requests[1].resolve([{ checkoutRequestId: "unauthorized-late" }]); await flush();
    f.events().onReconnect(); await f.timers.advance(20000);
    assert.equal(f.requests.length, 2); assert.equal(f.apiStates.at(-1).error, true);
    assert.equal(f.checkoutStates.at(-1).checkouts.length, 0);
  } finally { f.stop(); }
});
for (const [name, binding, args] of [
  ["serveKitchenItem", "markKitchenItemServed", ["o", "i"]],
  ["saveKitchenItemPrice", "adjustKitchenItemUnitPrice", ["o", "i", 500]],
  ["adjustKitchenItemQuantity", "adjustKitchenItemQuantityRequest", [{ direction: "decrease" }]],
  ["changeKitchenOrderItemCancellation", "cancelKitchenOrderItem", [{ orderId: "o", orderItemId: "i", action: "cancel" }]],
  ["saveCheckout", "saveKitchenCheckoutAdjustments", [{ checkoutRequestId: "c", version: 1 }, []]],
  ["readyCheckout", "readyKitchenCheckout", [{ checkoutRequestId: "c", version: 1 }]],
  ["cancelCheckout", "cancelKitchenCheckout", [{ checkoutRequestId: "c", version: 1 }]],
  ["payCheckout", "payKitchenCheckout", [{ checkoutRequestId: "c", version: 1 }, "cash"]],
]) test("App " + name + " waits for a post-mutation read without creating a parallel pair", async () => {
  const f = await appFixture({ bindings: { [binding]: async () => ({ acknowledged: true }) } });
  try {
    const action = f.app[name](...args); let done = false; void action.then(() => { done = true; });
    await flush(); assert.equal(f.requests.length, 2);
    await f.complete(0, "before-mutation"); assert.equal(done, false); assert.equal(f.requests.length, 4);
    await f.complete(1, "after-mutation"); await action;
    assert.equal(f.apiStates.at(-1).orders[0].id, "after-mutation"); assert.equal(f.requests.length, 4);
  } finally { f.stop(); }
});
test("acknowledged quantity increase remains successful if the queued display refresh fails", async () => {
  const result = { acknowledged: true };
  const f = await appFixture({ bindings: { adjustKitchenItemQuantityRequest: async () => result } });
  try {
    assert.equal(await f.app.adjustKitchenItemQuantity({ direction: "increase" }), result);
    await f.complete(0, "initial");
    f.requests[2].reject(new Error("fixture display refresh")); await flush();
    assert.equal(f.apiStates.at(-1).error, true);
  } finally { f.stop(); }
});
test("a mutation finishing after route departure cannot refresh a different kitchen lifetime", async () => {
  const mutation = deferred();
  const old = await appFixture({ bindings: { adjustKitchenItemUnitPrice: () => mutation.promise } });
  const action = assert.rejects(old.app.saveKitchenItemPrice("o", "i", 500), { code: "CANCELLED" });
  old.stop(); const next = await appFixture();
  try {
    mutation.resolve({}); await action; await flush();
    assert.equal(old.requests.length, 2); assert.equal(next.requests.length, 2);
    await next.complete(0, "new-screen");
  } finally { next.stop(); }
});
test("checkout GET forwards cancellation while retaining its ordinary no-signal contract", async () => {
  const controller = new AbortController(), received = [];
  const env = { location: { origin: "http://fixture.invalid" }, WARUN_KITCHEN_API_TOKEN: "fixture-only-dummy",
    fetch: async (_url, options) => { received.push(options); return { ok: true, json: async () => ({ checkouts: [] }) }; } };
  assert.deepEqual(await fetchKitchenCheckoutRequests({ env, signal: controller.signal }), []);
  assert.equal(received[0].signal, controller.signal);
  await fetchKitchenCheckoutRequests({ env }); assert.equal("signal" in received[1], false);
});
test("slow adopted snapshots reach the real sound observer once; the refresher does not play audio itself", async () => {
  let now = 10; const sounds = [];
  const sound = createKitchenOrderSound({
    storage: { getItem: () => null, setItem() {} }, storageKey: "fixture-only",
    engine: { activate: async () => {}, play: kind => sounds.push(kind), stop() {}, dispose() {} },
    loadBaseline: async () => ({ orders: [], staffCalls: [], checkoutRequests: [] }), now: () => now,
  });
  sound.observe([]); await sound.enable(); now = 20;
  const f = readerFixture({ onData(data) { sound.observe(data.orders, { requestStartedAt: data.started }); } });
  try {
    const first = f.reader.refresh(); await flush(); const trailing = f.reader.refresh();
    await f.timers.advance(2500);
    f.requests[0].resolve({ orders: [{ id: "fixture-new", status: "new", version: 1 }], started: 20 }); await first; await flush();
    f.requests[1].resolve({ orders: [{ id: "fixture-new", status: "new", version: 1 }], started: 30 }); await trailing;
    assert.deepEqual(sounds, ["order"]);
  } finally { f.reader.stop(); sound.dispose(); }
});

test("App reconnect suppression reaches both the in-flight display and post-reconnect baseline", async () => {
  const f = await appFixture();
  try {
    f.events().onReconnect(); await f.complete(0, "pre-reconnect");
    assert.equal(f.apiStates.at(-1).suppressStaffCalls, true);
    await f.complete(1, "baseline"); assert.equal(f.apiStates.at(-1).suppressStaffCalls, true);
    await f.timers.advance(2000); await f.complete(2, "live");
    assert.equal(f.apiStates.at(-1).suppressStaffCalls, false);
  } finally { f.stop(); }
});
test("a burst of invalidations remains one shared trailing request with no self-sustaining loop", async () => {
  const f = readerFixture(), first = f.reader.refresh(); await flush();
  const requests = Array.from({ length: 1000 }, () => f.reader.refresh());
  assert.ok(requests.every(p => p === requests[0])); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(1); await first; await flush(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(2); await Promise.all(requests); await f.timers.advance(60000);
  assert.equal(f.requests.length, 2); assert.equal(f.timers.size(), 0); f.reader.stop();
});
test("stopping before loader entry never starts a transport", async () => {
  const f = readerFixture(), waiting = assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
  f.reader.stop(); await waiting; await flush();
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size(), 0); assert.equal(f.errors.length, 0);
});

function notificationBoundaryFixture() {
  const epoch = 1_800_000_000_000, values = new Map(), plays = [], observations = [];
  let sound, baseline = { orders: [], staffCalls: [], checkoutRequests: [] };
  const f = readerFixture({ onData(data, options) {
    observations.push(data);
    sound.observe(data.orders, { staffCalls: data.staffCalls ?? [], checkoutRequests: data.checkoutRequests ?? [],
      suppressStaffCalls: options.suppressStaffCalls, requestStartedAt: data.started });
  } });
  sound = createKitchenOrderSound({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, storageKey: "boundary-fixture",
    engine: { activate: async () => {}, play: kind => plays.push(kind), stop() {}, dispose() {} },
    now: f.timers.now, nowEpoch: () => epoch + Math.floor(f.timers.now()),
    setTimer: f.timers.setTimeout, clearTimer: f.timers.clearTimeout,
    loadBaseline: () => typeof baseline === "function" ? baseline() : Promise.resolve(baseline),
  });
  return { ...f, sound, plays, observations, epoch,
    order: (id, at, patch = {}) => ({ id, status: "new", version: 1, createdAt: new Date(epoch + at).toISOString(), ...patch }),
    setBaseline: value => { baseline = value; },
    seen: () => JSON.parse(values.get("boundary-fixture") || "{}").seenIds ?? [],
    async reply(index, orders, extras = {}) { f.requests[index].resolve({ orders, started: f.requests[index].at, ...extras }); await flush(); },
    stop() { sound.dispose(); f.reader.stop(); },
  };
}
test("notification ON boundary: a pre-ON slow read must not consume N before the post-ON read", async (t) => {
  const f = notificationBoundaryFixture();
  const first = f.reader.refresh(); await flush();
  const poll = f.timers.setInterval(() => { void f.reader.refresh().catch(() => {}); }, 2000);
  try {
    const old = f.order("fixture-existing", -100);
    f.setBaseline({ orders: [old] });
    await f.timers.advance(500); await f.sound.enable();
    assert.equal(f.sound.getState().status, "on");
    await f.timers.advance(1000);
    const added = f.order("fixture-after-baseline", f.timers.now());
    await f.timers.advance(1000); // The 2-second poll requests one trailing read.
    const trailing = f.reader.refresh();
    await f.reply(0, [old, added]); await first;
    const seenBeforeTrailing = f.seen().includes(added.id);
    assert.equal(f.plays.length, 0, "An old-start response itself must stay silent");
    await f.timers.advance(500); await f.reply(1, [old, added]); await trailing;
    t.diagnostic(JSON.stringify({ preOnReadStarted: 0, enabledAt: 500, newOrderAt: 1500, replyAt: 2500,
      seenBeforeTrailing, notifications: f.plays, appliedSnapshots: f.observations.length, reads: f.requests.length }));
    assert.deepEqual(f.plays, ["order"], "N must notify once after the fresh trailing read");
    assert.equal(seenBeforeTrailing, false, "The old-start response must not consume the new order ID");
    assert.equal(f.observations.length, 2);
    f.sound.observe([old, added], { requestStartedAt: f.timers.now() });
    assert.deepEqual(f.plays, ["order"], "A repeated N must not notify twice");
  } finally { f.timers.clearInterval(poll); f.stop(); }
});

test("notification ON boundary: pre-ON and invalid-time orders remain silent even outside the baseline", async () => {
  const f = notificationBoundaryFixture();
  try {
    await f.timers.advance(500); await f.sound.enable();
    const rows = [f.order("fixture-before", 100),
      { id: "fixture-unversioned-time", status: "new", version: 1 },
      f.order("fixture-bad-time", 0, { createdAt: "not-a-date" })];
    f.sound.observe(rows, { requestStartedAt: 0 });
    f.sound.observe(rows, { requestStartedAt: 1000 });
    assert.deepEqual(f.plays, []); assert.equal(f.seen().length, rows.length);
  } finally { f.stop(); }
});
test("notification ON boundary: baseline IDs stay known even when they were created during activation", async () => {
  const f = notificationBoundaryFixture(), baseline = deferred();
  try {
    f.setBaseline(() => baseline.promise);
    await f.timers.advance(500); const enabling = f.sound.enable(); await flush();
    await f.timers.advance(1000);
    const existing = f.order("fixture-in-baseline", 1000);
    baseline.resolve({ orders: [existing] }); await enabling;
    assert.equal(f.sound.getState().status, "on");
    f.sound.observe([existing], { requestStartedAt: 0 });
    f.sound.observe([existing], { requestStartedAt: 2000 });
    assert.deepEqual(f.plays, []); assert.ok(f.seen().includes(existing.id));
  } finally { f.stop(); }
});
test("notification ON boundary: a deferred new ID observed while OFF stays silent after re-enabling", async () => {
  const f = notificationBoundaryFixture(), first = f.reader.refresh(); await flush();
  try {
    await f.timers.advance(500); await f.sound.enable(); await f.timers.advance(1000);
    const added = f.order("fixture-off-before-trailing", 1500), trailing = f.reader.refresh();
    await f.timers.advance(1000); await f.reply(0, [added]); await first;
    assert.equal(f.seen().includes(added.id), false);
    f.sound.disable();
    await f.timers.advance(500); await f.reply(1, [added]); await trailing;
    assert.ok(f.seen().includes(added.id)); assert.deepEqual(f.plays, []);
    f.setBaseline({ orders: [added] }); await f.sound.enable();
    f.sound.observe([added], { requestStartedAt: f.timers.now() });
    assert.deepEqual(f.plays, []);
  } finally { f.stop(); }
});
test("notification ON boundary: OFF-to-ON uses the new activation boundary for a still-pending old read", async (t) => {
  const f = notificationBoundaryFixture();
  try {
    await f.timers.advance(100); await f.sound.enable();
    await f.timers.advance(50); const first = f.reader.refresh(); await flush();
    await f.timers.advance(50); const fromFirstOn = f.order("fixture-first-on", 200);
    await f.timers.advance(100); f.sound.disable();
    await f.timers.advance(100); f.setBaseline({ orders: [fromFirstOn] }); await f.sound.enable();
    await f.timers.advance(100); const fromSecondOn = f.order("fixture-second-on", 500);
    const trailing = f.reader.refresh();
    await f.timers.advance(2000); await f.reply(0, [fromFirstOn, fromSecondOn]); await first;
    assert.ok(f.seen().includes(fromFirstOn.id)); assert.equal(f.seen().includes(fromSecondOn.id), false);
    assert.deepEqual(f.plays, []);
    await f.reply(1, [fromFirstOn, fromSecondOn]); await trailing;
    f.sound.observe([fromFirstOn, fromSecondOn], { requestStartedAt: 3000 });
    assert.deepEqual(f.plays, ["order"]);
    t.diagnostic(JSON.stringify({ firstGenerationOrder: fromFirstOn.id, secondGenerationOrder: fromSecondOn.id, notifications: f.plays }));
  } finally { f.stop(); }
});
test("notification ON boundary: departure cancels pending reads and delayed data never notifies", async () => {
  const f = notificationBoundaryFixture(), first = assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
  await flush(); await f.timers.advance(500); await f.sound.enable();
  const trailing = assert.rejects(f.reader.refresh(), { code: "CANCELLED" });
  f.stop(); await first; await trailing;
  await f.reply(0, [f.order("fixture-after-departure", 1500)]);
  f.sound.observe([f.order("fixture-direct-after-dispose", 1500)], { requestStartedAt: 2000 });
  assert.deepEqual(f.plays, []); assert.equal(f.observations.length, 0); assert.equal(f.timers.size(), 0);
});
test("notification ON boundary: a failed baseline does not enable sound or replay its observed IDs on retry", async () => {
  const f = notificationBoundaryFixture(), baseline = deferred(), first = f.reader.refresh(); await flush();
  try {
    f.setBaseline(() => baseline.promise);
    await f.timers.advance(500); const enabling = f.sound.enable(); await flush();
    baseline.reject(new Error("fixture baseline failure")); await enabling;
    assert.equal(f.sound.getState().status, "blocked");
    await f.timers.advance(1000);
    const added = f.order("fixture-while-blocked", 1500);
    await f.reply(0, [added]); await first; assert.deepEqual(f.plays, []);
    f.setBaseline({ orders: [added] }); await f.sound.enable();
    f.sound.observe([added], { requestStartedAt: 2000 });
    assert.deepEqual(f.plays, []);
  } finally { f.stop(); }
});
test("notification ON boundary: OFF cancels an unfinished baseline and ignores its late completion", async () => {
  const f = notificationBoundaryFixture(), baseline = deferred(), first = f.reader.refresh(); await flush();
  try {
    f.setBaseline(() => baseline.promise);
    await f.timers.advance(500); const enabling = f.sound.enable(); await flush();
    await f.timers.advance(100); f.sound.disable(); await enabling;
    const whileOff = f.order("fixture-while-off", 650);
    await f.timers.advance(100); await f.reply(0, [whileOff]); await first;
    baseline.resolve({ orders: [] }); await flush(); assert.equal(f.sound.getState().status, "off");
    f.setBaseline({ orders: [] }); await f.sound.enable();
    f.sound.observe([whileOff], { requestStartedAt: 1000 });
    assert.deepEqual(f.plays, []);
  } finally { f.stop(); }
});
test("notification ON boundary: post-ON staff-call IDs in an old-start read wait for a fresh read once", async (t) => {
  const f = notificationBoundaryFixture(), first = f.reader.refresh(); await flush();
  try {
    const existing = { id: "fixture-existing-call", status: "open", createdAtMs: f.epoch - 100 };
    f.setBaseline({ orders: [], staffCalls: [existing] });
    await f.timers.advance(500); await f.sound.enable(); await f.timers.advance(1000);
    const added = { id: "fixture-after-on-call", status: "open", createdAtMs: f.epoch + 1500 };
    const trailing = f.reader.refresh();
    await f.timers.advance(1000); await f.reply(0, [], { staffCalls: [existing, added] }); await first;
    assert.deepEqual(f.plays, []);
    await f.reply(1, [], { staffCalls: [existing, added] }); await trailing;
    f.sound.observe([], { staffCalls: [existing, added], requestStartedAt: 3000 });
    assert.deepEqual(f.plays, ["staffCall"]);
    t.diagnostic(JSON.stringify({ callNotifications: f.plays }));
  } finally { f.stop(); }
});
test("notification ON boundary: a suppressed reconnect baseline still consumes call IDs silently", async () => {
  const f = notificationBoundaryFixture(), first = f.reader.refresh(); await flush();
  try {
    await f.timers.advance(500); await f.sound.enable();
    const baseline = f.reader.refresh({ suppressStaffCalls: true });
    const duringReconnect = { id: "fixture-reconnect-call", status: "open", createdAtMs: f.epoch + 1500 };
    await f.timers.advance(2000); await f.reply(0, [], { staffCalls: [duringReconnect] }); await first;
    await f.reply(1, [], { staffCalls: [duringReconnect] }); await baseline;
    const next = f.reader.refresh(); await flush(); await f.reply(2, [], { staffCalls: [duringReconnect] }); await next;
    assert.deepEqual(f.plays, []);
    const newCall = { id: "fixture-live-call", status: "open", createdAtMs: f.epoch + 3000 };
    const live = f.reader.refresh(); await flush(); await f.reply(3, [], { staffCalls: [duringReconnect, newCall] }); await live;
    assert.deepEqual(f.plays, ["staffCall"]);
  } finally { f.stop(); }
});

test("notification ON boundary: millisecond ties keep baseline IDs silent and defer a newly created ID", async () => {
  const f = notificationBoundaryFixture(), first = f.reader.refresh(); await flush();
  try {
    const baselineOrder = f.order("fixture-baseline-same-ms", 500);
    f.setBaseline({ orders: [baselineOrder] });
    await f.timers.advance(500.1); await f.sound.enable();
    await f.timers.advance(0.4);
    const added = f.order("fixture-new-same-ms", f.timers.now()); // Date serialization truncates sub-millisecond time.
    assert.equal(Date.parse(added.createdAt), f.epoch + 500);
    const trailing = f.reader.refresh();
    await f.timers.advance(2500); await f.reply(0, [baselineOrder, added]); await first;
    assert.ok(f.seen().includes(baselineOrder.id)); assert.equal(f.seen().includes(added.id), false);
    assert.deepEqual(f.plays, []);
    await f.reply(1, [baselineOrder, added]); await trailing;
    f.sound.observe([baselineOrder, added], { requestStartedAt: 4000 });
    assert.deepEqual(f.plays, ["order"]);
  } finally { f.stop(); }
});

test("notification ON boundary: a muted old-start observation stays known after volume is restored", async () => {
  const f = notificationBoundaryFixture(), first = f.reader.refresh(); await flush();
  try {
    await f.timers.advance(500); await f.sound.enable(); f.sound.setVolume(0);
    const added = f.order("fixture-muted-old-read", 1500), trailing = f.reader.refresh();
    await f.timers.advance(2000); await f.reply(0, [added]); await first;
    assert.ok(f.seen().includes(added.id), "Muted observations must retain their existing deduplication behavior");
    f.sound.setVolume(50);
    await f.reply(1, [added]); await trailing;
    assert.deepEqual(f.plays, []);
  } finally { f.stop(); }
});
