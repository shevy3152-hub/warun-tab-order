import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fetchKitchenSnapshot } from "../src/kitchen-api.js";
import { createKitchenOrderSound, createKitchenSoundEngine, initialKitchenOrderSoundState, kitchenSoundStorageKey, KITCHEN_NOTIFICATION_GAIN } from "../src/kitchen-order-sound.js";
const order = (id, status = "new") => ({ id, status, version: 1 });
function fixture({ storage, activate, loadBaseline, ...options } = {}) {
  const values = new Map();
  const store = storage || { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  let plays = 0, stops = 0, clock = 10;
  const playKinds = [];
  const changes = [];
  const engine = { activate: activate || (async () => {}), play: kind => { plays++; playKinds.push(kind ?? "order"); }, stop: () => { stops++; }, dispose: () => { stops++; } };
  const controller = createKitchenOrderSound({ storage: store, storageKey: "test", engine, loadBaseline, now: () => clock, onChange: state => changes.push(state), ...options });
  return { controller, engine, store, plays: () => plays, playKinds, stops: () => stops, advance: value => { clock = value; }, changes };
}
test("unset sound preference defaults ON but waits for explicit audio activation", async () => {
  const f = fixture();
  assert.equal(f.controller.getState().requestedOn, true);
  assert.equal(f.controller.getState().status, "needs-activation");
  assert.match(f.controller.getState().message, /音を有効にする/);
  f.controller.observe([order("old")]);
  assert.equal(f.plays(), 0);
  await f.controller.enable();
  assert.equal(f.controller.getState().status, "on");
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("old")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 0);
  const early = fixture({ loadBaseline: async () => [order("existing")] });
  early.controller.observe([], { ready: false });
  await early.controller.enable();
  early.controller.observe([order("existing")], { requestStartedAt: 20 });
  assert.equal(early.plays(), 0);
});
test("unavailable storage keeps the ON default and reports that preferences cannot persist", () => {
  const state = initialKitchenOrderSoundState(undefined, "test");
  assert.equal(state.requestedOn, true);
  assert.equal(state.status, "needs-activation");
  assert.equal(state.storageAvailable, false);
});
test("one sound per new order, with duplicates, served updates and reconnects silent", async () => {
  const f = fixture();
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("a"), order("b")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 2);
  f.controller.observe([order("a", "active"), order("b", "completed")], { requestStartedAt: 30 });
  f.controller.observe([], { ready: false });
  f.controller.observe([order("a"), order("b")], { requestStartedAt: 40 });
  assert.equal(f.plays(), 2);
  f.controller.observe([order("c", "completed")], { requestStartedAt: 50 });
  assert.equal(f.plays(), 2);
});
test("new staff calls use their own sound, suppress baseline and reconnect calls, and deduplicate IDs", async () => {
  const f = fixture({ loadBaseline: async () => ({ orders: [], staffCalls: [{ staffCallId: "call-old", status: "open", createdAtMs: 1 }] }) });
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { staffCalls: [{ staffCallId: "call-old", status: "open", createdAtMs: 1 }], requestStartedAt: 20 });
  assert.equal(f.plays(), 0);
  const nextCall = { id: "call-new", status: "open", createdAtMs: 21 };
  f.controller.observe([], { staffCalls: [nextCall], requestStartedAt: 30 });
  f.controller.observe([], { staffCalls: [nextCall], requestStartedAt: 40 });
  assert.deepEqual(f.playKinds, ["staffCall"]);
  assert.deepEqual(JSON.parse(f.store.getItem("test")).seenCallIds, ["call-old", "call-new"]);
  const reconnectedCall = { id: "call-during-reconnect", status: "open", createdAtMs: 31 };
  f.controller.observe([], { staffCalls: [reconnectedCall], suppressStaffCalls: true, requestStartedAt: 50 });
  f.controller.observe([], { staffCalls: [reconnectedCall], requestStartedAt: 60 });
  assert.deepEqual(f.playKinds, ["staffCall"]);
});
test("new checkout requests sound once; baseline, refetches, reconnects and ready updates stay silent", async () => {
  const existing = { checkoutRequestId: "checkout-existing", status: "requested" };
  const f = fixture({ loadBaseline: async () => ({ orders: [], staffCalls: [], checkoutRequests: [existing] }) });
  f.controller.observe([], { checkoutRequests: [existing] });
  await f.controller.enable();
  f.controller.observe([], { checkoutRequests: [existing], requestStartedAt: 20 });
  assert.deepEqual(f.playKinds, []);
  const next = { checkoutRequestId: "checkout-new", status: "requested" };
  f.controller.observe([], { checkoutRequests: [existing, next], requestStartedAt: 30 });
  assert.deepEqual(f.playKinds, ["checkout"]);
  f.controller.observe([], { checkoutRequests: [existing, next], requestStartedAt: 40 });
  f.controller.observe([], { checkoutRequests: [existing, { ...next, status: "ready" }], requestStartedAt: 50 });
  f.controller.observe([], { ready: false, checkoutRequests: [] });
  f.controller.observe([], { checkoutRequests: [existing, { ...next, status: "ready" }], requestStartedAt: 60 });
  assert.deepEqual(f.playKinds, ["checkout"]);
  assert.deepEqual(JSON.parse(f.store.getItem("test")).seenCheckoutIds, ["checkout-existing", "checkout-new"]);
});
test("checkout IDs received while OFF stay silent after enabling", async () => {
  const f = fixture();
  const checkout = { checkoutRequestId: "checkout-while-off", status: "requested" };
  f.controller.disable();
  f.controller.observe([], { checkoutRequests: [checkout], requestStartedAt: 11 });
  await f.controller.enable();
  f.controller.observe([], { checkoutRequests: [checkout], requestStartedAt: 20 });
  assert.deepEqual(f.playKinds, []);
});test("staff calls received while notifications are OFF stay silent after enabling", async () => {
  const f = fixture();
  f.controller.observe([]);
  const call = { id: "call-off", status: "open", createdAtMs: 10 };
  f.controller.observe([], { staffCalls: [call], requestStartedAt: 11 });
  assert.equal(f.plays(), 0);
  await f.controller.enable();
  f.controller.observe([], { staffCalls: [call], requestStartedAt: 20 });
  assert.equal(f.plays(), 0);
});
test("an order and staff call arriving together are queued in sequence", async () => {
  const f = fixture();
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("simultaneous-order")], { staffCalls: [{ id: "simultaneous-call", status: "open", createdAtMs: 20 }], requestStartedAt: 20 });
  assert.deepEqual(f.playKinds, ["order", "staffCall"]);
});
test("OFF observations and requests started before ON are not played later", async () => {
  const f = fixture();
  f.controller.observe([order("before")]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("before"), order("in-flight")], { requestStartedAt: 5 });
  assert.equal(f.plays(), 0);
  f.controller.observe([order("in-flight"), order("new")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 1);
  f.controller.disable();
  f.controller.observe([order("off")], { requestStartedAt: 30 });
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("off")], { requestStartedAt: 40 });
  assert.equal(f.plays(), 1);
  assert.ok(f.stops() >= 1);
});
test("reload preserves known IDs but requires a new activation click", async () => {
  const f = fixture();
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  const knownCall = { id: "call-before-reload", status: "open", createdAtMs: 20 };
  const knownCheckout = { checkoutRequestId: "checkout-before-reload", status: "requested" };
  f.controller.observe([order("notified")], { staffCalls: [knownCall], checkoutRequests: [knownCheckout], requestStartedAt: 20 });
  assert.deepEqual(f.playKinds, ["order", "staffCall", "checkout"]);
  f.controller.dispose();
  const reloaded = fixture({ storage: f.store });
  assert.equal(reloaded.controller.getState().status, "needs-activation");
  assert.equal(reloaded.controller.getState().requestedOn, true);
  assert.match(reloaded.controller.getState().message, /音を有効にする/);
  reloaded.controller.observe([]);
  await reloaded.controller.enable();
  reloaded.controller.observe([], { requestStartedAt: 10 });
  reloaded.controller.observe([order("notified"), order("next")], { staffCalls: [knownCall], checkoutRequests: [knownCheckout, { checkoutRequestId: "checkout-after-reload", status: "requested" }], requestStartedAt: 20 });
  assert.equal(reloaded.plays(), 2);
});
test("OFF cancels a late activation or test without scheduling a sound", async () => {
  let release;
  const f = fixture({ activate: () => new Promise(resolve => { release = resolve; }) });
  const enabling = f.controller.enable();
  f.controller.disable();
  release();
  await enabling;
  assert.equal(f.controller.getState().status, "off");
  const testing = f.controller.test();
  f.controller.disable();
  release();
  await testing;
  assert.equal(f.plays(), 0);
});
test("activation and playback failures stop audio and do not retry on incoming orders", async () => {
  let attempts = 0;
  const f = fixture({ activate: async () => { attempts++; throw new Error("blocked"); } });
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("a")], { requestStartedAt: 20 });
  f.controller.observe([order("b")], { requestStartedAt: 30 });
  assert.equal(f.controller.getState().status, "blocked");
  assert.equal(attempts, 1);
  assert.equal(f.plays(), 0);
  const playback = fixture();
  playback.controller.observe([]);
  await playback.controller.enable();
  playback.controller.observe([], { requestStartedAt: 10 });
  playback.engine.play = () => { throw new Error("suspended"); };
  playback.controller.observe([order("a")], { requestStartedAt: 20 });
  assert.equal(playback.controller.getState().status, "blocked");
  assert.match(playback.controller.getState().message, /注文・スタッフ呼出・会計依頼の画面表示は続きます/);
});
test("test while OFF does not enable new-order sounds; audio suspension shows a blocked state", async () => {
  const f = fixture();
  f.controller.disable();
  await f.controller.test();
  assert.equal(f.plays(), 1);
  assert.equal(f.controller.getState().status, "off");
  assert.equal(f.controller.getState().requestedOn, false);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.audioStateChanged("suspended");
  assert.equal(f.controller.getState().status, "blocked");
});
test("unavailable storage is reported and deduplication continues in memory", async () => {
  const f = fixture({ storage: { getItem: () => { throw Error("unavailable"); } } });
  f.controller.observe([]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("a")], { requestStartedAt: 20 });
  f.controller.observe([order("a")], { requestStartedAt: 30 });
  assert.equal(f.plays(), 1);
  assert.equal(f.controller.getState().storageAvailable, false);
});
test("storage scope uses the existing API location, without credentials or query secrets", () => {
  const key = kitchenSoundStorageKey({ location: { origin: "https://qa.example.test" }, WARUN_API_BASE: "https://ignored:secret@qa.example.test/v1?token=secret" });
  assert.equal(key, "warun:kitchen-order-sound:v1:https://qa.example.test/v1:api");
});
test("sound engine stops every scheduled oscillator on OFF", async () => {
  const oscillators = [];
  let context;
  class Context {
    constructor() { context = this; this.state = "suspended"; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
    createOscillator() { const node = { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start(value) { this.startTime = value; }, stop(value) { this.stopTime = value; this.stopCalls = (this.stopCalls || 0) + 1; } }; oscillators.push(node); return node; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  await engine.activate();
  engine.play(); engine.play();
  assert.equal(oscillators.length, 6);
  assert.equal(oscillators[3].startTime, 1.5);
  engine.stop();
  assert.ok(oscillators.every(node => node.stopCalls === 2));
  engine.dispose();
  assert.equal(context.state, "closed");
  await assert.rejects(createKitchenSoundEngine({ env: {} }).activate());
});
test("staff-call three-pair tone is distinct and queued without overlapping the order tone", async () => {
  const oscillators = [];
  class Context {
    constructor() { this.state = "suspended"; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = "running"; }
    async close() {}
    createOscillator() { const node = { frequency: { setValueAtTime(value, at) { node.frequencyValues.push([value, at]); } }, frequencyValues: [], connect() {}, disconnect() {}, start(at) { this.startTime = at; }, stop(at) { this.stopTime = at; } }; oscillators.push(node); return node; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  await engine.activate();
  engine.play("order");
  engine.play("staffCall");
  engine.play("order");
  assert.deepEqual(oscillators.map((node) => Number(node.startTime.toFixed(2))), [0, 0.5, 1, 2, 2.27, 2.85, 3.12, 3.7, 3.97, 4.2, 4.7, 5.2]);
  assert.deepEqual(oscillators.map((node) => node.frequencyValues[0][0]), [880, 880, 880, 523, 659, 523, 659, 523, 659, 880, 880, 880]);
  for (let index = 1; index < oscillators.length; index++) assert.ok(oscillators[index].startTime >= oscillators[index - 1].stopTime);
  engine.dispose();
});
test("staff-call lead-in and reservation are based on AudioContext time after resume", async () => {
  const oscillators = [];
  class Context {
    constructor() { this.state = "suspended"; this.currentTime = 0; this.destination = {}; }
    async resume() { await Promise.resolve(); this.currentTime = 7; this.state = "running"; }
    async close() {}
    createOscillator() { const node = { frequency: { setValueAtTime(value, at) { node.frequencyValues.push([value, at]); } }, frequencyValues: [], connect() {}, disconnect() {}, start(at) { this.startTime = at; }, stop(at) { this.stopTime = at; } }; oscillators.push(node); return node; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  await engine.activate();
  engine.play("staffCall");
  engine.play("order");
  assert.deepEqual(oscillators.map((node) => Number(node.startTime.toFixed(2))), [7.5, 7.77, 8.35, 8.62, 9.2, 9.47, 9.7, 10.2, 10.7]);
  assert.deepEqual(oscillators.slice(0, 6).map((node) => node.frequencyValues[0][0]), [523, 659, 523, 659, 523, 659]);
  for (let index = 1; index < oscillators.length; index++) assert.ok(oscillators[index].startTime >= oscillators[index - 1].stopTime);
  engine.dispose();
});
test("sound controls belong only to kitchen and use snapshot request timing", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const kitchen = app.slice(app.indexOf("function KitchenScreen"));
  assert.match(kitchen, /<KitchenOrderSound orders=\{activeOrders\}/);
  assert.match(kitchen, /staffCalls=\{activeCalls\}/);
  assert.match(kitchen, /checkoutRequests=\{activeCheckouts\}/);
  assert.match(app, /onReconnect: \(\) => load\(\{ suppressStaffCalls: true \}\)/);
  assert.equal((app.match(/<KitchenOrderSound /g) || []).length, 1);
  assert.match(app, /notificationRequestStartedAt: snapshot.notificationRequestStartedAt/);
  assert.match(app, /playCheckoutBell\(checkoutAudioRef\)/);
  const component = await readFile(new URL("../src/KitchenOrderSound.jsx", import.meta.url), "utf8");
  assert.match(component, /音を試す/);
  assert.ok(component.includes("{demoMode ? <><button"));
  assert.ok(component.includes('test("staffCall")}>呼出音を試す（隔離）'));
  assert.match(component, /音を有効にする/);
  assert.match(component, /ON（音声未有効）/);
  assert.match(component, /role="switch"/);
  assert.match(component, /aria-checked={enabled}/);
});

test("snapshot request start is captured before the asynchronous response", async () => {
  let clock = 5;
  const env = { location: { origin: "https://qa.example.test" }, WARUN_KITCHEN_API_TOKEN: "fixture-only-token", performance: { now: () => clock } };
  const snapshot = await fetchKitchenSnapshot({ env, fetchImpl: async () => { clock = 50; return { ok: true, json: async () => ({ activeOrders: [] }) }; } });
  assert.equal(snapshot.notificationRequestStartedAt, 5);
});

test("ON completes after its baseline; the first post-ON read notifies a newly arrived order", async () => {
  let resolveBaseline;
  const f = fixture({ loadBaseline: () => new Promise(resolve => { resolveBaseline = resolve; }) });
  f.controller.observe([]);
  const enabling = f.controller.enable();
  assert.equal(f.controller.getState().status, "enabling");
  resolveBaseline([order("old-unseen")]);
  await enabling;
  assert.equal(f.controller.getState().status, "on");
  f.controller.observe([order("old-unseen"), order("arrived-after-on")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 1);
  f.controller.observe([order("arrived-after-on"), { ...order("restored"), version: 2 }], { requestStartedAt: 30 });
  assert.equal(f.plays(), 1);
});

test("reconnect suppresses known orders while still notifying a new order", async () => {
  const f = fixture({ loadBaseline: async () => [order("existing")] });
  await f.controller.enable();
  f.controller.observe([order("first-new")], { requestStartedAt: 20 });
  f.controller.observe([], { ready: false });
  f.controller.observe([order("existing"), order("first-new"), order("during-disconnect")], { requestStartedAt: 30 });
  assert.equal(f.plays(), 2);
});

test("baseline rejection cannot enable notifications or retry automatically", async () => {
  let attempts = 0;
  const f = fixture({ loadBaseline: async () => { attempts++; throw new Error("unauthorized"); } });
  await f.controller.enable();
  assert.equal(f.controller.getState().status, "blocked");
  f.controller.observe([order("new")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 0);
  assert.equal(attempts, 1);
});

test("OFF cancels a pending baseline and prevents a late ON", async () => {
  let resolveBaseline;
  const f = fixture({ loadBaseline: () => new Promise(resolve => { resolveBaseline = resolve; }) });
  const enabling = f.controller.enable();
  f.controller.disable();
  resolveBaseline([]);
  await enabling;
  assert.equal(f.controller.getState().status, "off");
  assert.equal(f.plays(), 0);
});


test("activation progress distinguishes audio waiting from baseline waiting", async () => {
  let audioReady, baselineReady;
  const f = fixture({ activate: () => new Promise(resolve => { audioReady = resolve; }), loadBaseline: () => new Promise(resolve => { baselineReady = resolve; }) });
  const enabling = f.controller.enable();
  assert.equal(f.controller.getState().audioStatus, "pending");
  audioReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getState().status, "enabling");
  assert.equal(f.controller.getState().audioStatus, "ready");
  assert.equal(f.controller.getState().baselineStatus, "pending");
  assert.match(f.controller.getState().message, /厨房の新着一覧取得を待って/);
  baselineReady([]);
  await enabling;
  assert.equal(f.controller.getState().status, "on");
  f.controller.disable();
  assert.equal(f.controller.getState().status, "off");
});

test("audio and API failures preserve the ON preference without claiming audio is ready", async () => {
  const audio = fixture({ activate: async () => { throw Object.assign(new Error("private detail"), { name: "NotAllowedError" }); } });
  await audio.controller.enable();
  assert.equal(audio.controller.getState().audioStatus, "failed");
  assert.equal(audio.controller.getState().requestedOn, true);
  assert.equal(audio.controller.getState().status, "blocked");
  assert.match(audio.controller.getState().message, /ブラウザーが音声の有効化を拒否/);
  assert.match(audio.controller.getState().message, /音声は再生できる状態ではありません/);
  assert.match(audio.controller.getState().message, /音を有効にする/);
  assert.doesNotMatch(audio.controller.getState().message, /private detail/);
  const api = fixture({ loadBaseline: async () => { throw Object.assign(new Error("private detail"), { status: 401 }); } });
  await api.controller.enable();
  assert.equal(api.controller.getState().baselineStatus, "failed");
  assert.match(api.controller.getState().message, /HTTP 401/);
  assert.equal(api.controller.getState().status, "blocked");
  assert.match(api.controller.getState().message, /音を有効にする/);
});

test("pending activation times out once, aborts baseline and ignores late completion", async () => {
  const timers = new Map(); let next = 0, signal, release;
  const f = fixture({ loadBaseline: options => { signal = options.signal; return new Promise(resolve => { release = resolve; }); }, setTimer: fn => { timers.set(++next, fn); return next; }, clearTimer: id => timers.delete(id) });
  const enabling = f.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await enabling;
  assert.equal(f.controller.getState().status, "blocked");
  assert.match(f.controller.getState().message, /厨房の新着一覧取得が8秒/);
  assert.equal(signal.aborted, true);
  assert.equal(timers.size, 0);
  release([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getState().status, "blocked");
});

test("OFF aborts pending reads and removes activation deadlines", async () => {
  const timers = new Map(); let next = 0, signal;
  const f = fixture({ activate: () => new Promise(() => {}), loadBaseline: options => { signal = options.signal; return new Promise(() => {}); }, setTimer: fn => { timers.set(++next, fn); return next; }, clearTimer: id => timers.delete(id) });
  const enabling = f.controller.enable();
  f.controller.disable();
  await enabling;
  assert.equal(signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(f.controller.getState().status, "off");
  assert.equal(f.plays(), 0);
});

test("kitchen test and notification use the same bounded louder envelope", async () => {
  const envelopes = [];
  class Context {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    async resume() {} async close() {}
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
    createGain() { const values = []; envelopes.push(values); return { gain: { setValueAtTime: (value, time) => values.push([value, time]), linearRampToValueAtTime: (value, time) => values.push([value, time]), exponentialRampToValueAtTime: (value, time) => values.push([value, time]) }, connect() {}, disconnect() {} }; }
  }
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  const f = fixture();
  const controller = createKitchenOrderSound({ storage: f.store, storageKey: "envelope", engine });
  await controller.test();
  await controller.enable();
  controller.observe([order("new")], { requestStartedAt: performance.now() });
  assert.equal(envelopes.length, 6);
  for (const envelope of envelopes) {
    assert.equal(envelope[1][0], KITCHEN_NOTIFICATION_GAIN);
    assert.equal(envelope[2][0], KITCHEN_NOTIFICATION_GAIN);
    assert.ok(Math.abs(envelope[2][1] - envelope[0][1] - 0.20) < 1e-10);
    assert.ok(Math.max(...envelope.map(([value]) => value)) < 1);
  }
  controller.dispose();
});

test("baseline fetch preserves HTTP reason and supports cancellation", async () => {
  const env = { location: { origin: "https://qa.example.test" }, WARUN_KITCHEN_API_TOKEN: "fixture-only-token" };
  const signal = new AbortController().signal;
  await assert.rejects(fetchKitchenSnapshot({ env, signal, fetchImpl: async (_, options) => {
    assert.equal(options.signal, signal);
    return { ok: false, status: 403, json: async () => ({}) };
  } }), error => error.status === 403);
});


test("audio activation deadline reports audio waiting and allows an explicit retry", async () => {
  const timers = new Map(); let next = 0, attempts = 0;
  const f = fixture({ activate: () => ++attempts === 1 ? new Promise(() => {}) : Promise.resolve(), setTimer: fn => { timers.set(++next, fn); return next; }, clearTimer: id => timers.delete(id) });
  const enabling = f.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getState().baselineStatus, "ready");
  assert.match(f.controller.getState().message, /音声の有効化を待って/);
  [...timers.values()][0]();
  await enabling;
  assert.equal(f.controller.getState().status, "blocked");
  assert.match(f.controller.getState().message, /音声有効化が8秒/);
  await f.controller.enable();
  assert.equal(f.controller.getState().status, "on");
  assert.equal(timers.size, 0);
});


test("volume persists locally and an ON preference remains ON after reload pending activation", async () => {
  const f = fixture();
  assert.equal(f.controller.getState().volume, 50);
  assert.equal(f.controller.getState().requestedOn, true);
  assert.equal(f.controller.getState().status, "needs-activation");
  const volumes = []; f.engine.setVolume = value => volumes.push(value);
  f.controller.setVolume(80);
  assert.equal(f.controller.getState().status, "needs-activation");
  assert.deepEqual(volumes, [80]);
  await f.controller.setEnabled(true);
  assert.equal(f.controller.getState().status, "on");
  f.controller.setVolume(100);
  assert.equal(f.controller.getState().status, "on");
  f.controller.observe([order("new")], { requestStartedAt: 20 });
  assert.equal(f.controller.getState().status, "on");
  const reloaded = fixture({ storage: f.store });
  assert.equal(reloaded.controller.getState().volume, 100);
  assert.equal(reloaded.controller.getState().status, "needs-activation");
  assert.equal(reloaded.controller.getState().requestedOn, true);
  assert.match(reloaded.controller.getState().message, /音を有効にする/);
  f.controller.setEnabled(false);
  assert.equal(f.controller.getState().status, "off");
  assert.equal(f.controller.getState().requestedOn, false);
  const explicitlyOff = fixture({ storage: f.store });
  assert.equal(explicitlyOff.controller.getState().requestedOn, false);
  assert.equal(explicitlyOff.controller.getState().status, "off");
});

test("test leaves switch state unchanged both ON and OFF; muted observations remain deduplicated", async () => {
  const f = fixture();
  f.controller.disable();
  await f.controller.test();
  assert.equal(f.controller.getState().status, "off");
  assert.equal(f.controller.getState().requestedOn, false);
  await f.controller.setEnabled(true);
  await f.controller.test();
  assert.equal(f.controller.getState().status, "on");
  f.controller.setVolume(0);
  const count = f.plays();
  await f.controller.test();
  f.controller.observe([order("muted")], { requestStartedAt: 20 });
  assert.equal(f.plays(), count);
  assert.equal(f.controller.getState().status, "on");
  assert.match(f.controller.getState().message, /消音/);
  f.controller.setVolume(80);
  f.controller.observe([order("muted"),order("audible")], { requestStartedAt: 30 });
  assert.equal(f.plays(), count + 1);
  assert.equal(f.controller.getState().status, "on");
});

test("volume is clamped and failed test does not turn the switch ON", async () => {
  const f = fixture({ activate: async () => { throw new Error("blocked"); } });
  f.controller.disable();
  f.controller.setVolume(150); assert.equal(f.controller.getState().volume, 100);
  f.controller.setVolume(-1); assert.equal(f.controller.getState().volume, 0);
  f.controller.setVolume(NaN); assert.equal(f.controller.getState().volume, 50);
  await f.controller.test();
  assert.equal(f.controller.getState().status, "off");
  assert.match(f.controller.getState().message, /試聴できません/);
});

test("maximum kitchen gain remains below one and zero volume schedules no audio", async () => {
  const peaks=[];let nodes=0;
  class Context {
    constructor() { this.state="running";this.currentTime=0;this.destination={}; }
    async resume() {} async close() {}
    createOscillator() { nodes++;return {frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){},stop(){}}; }
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime:v=>peaks.push(v),exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const engine=createKitchenSoundEngine({env:{AudioContext:Context}});
  await engine.activate();engine.setVolume(100);engine.play();
  assert.equal(peaks[0],0.7);
  let mutedStops=0;const stop=engine.stop.bind(engine);engine.stop=()=>{mutedStops++;stop();};
  engine.setVolume(0);engine.play();assert.equal(nodes,3);assert.equal(mutedStops,1);
  engine.dispose();
});


test("a context suspended while loading the baseline cannot confirm ON", async () => {
  let resolveBaseline;
  const f = fixture({ loadBaseline: () => new Promise(resolve => { resolveBaseline = resolve; }) });
  f.engine.isRunning = () => false;
  const enabling = f.controller.enable();
  resolveBaseline([]); await enabling;
  assert.equal(f.controller.getState().status, "blocked");
  assert.equal(f.controller.getState().audioStatus, "failed");
});

test("rendered switch invokes activation, never test; ON survives order and volume rerenders", async () => {
  // Execute the real JSX handlers with a small hook harness. This is not a browser/audio test.
  const { transformWithEsbuild } = await import("vite");
  let source = await readFile(new URL("../src/KitchenOrderSound.jsx", import.meta.url), "utf8");
  source = source.replace(/import { useEffect, useRef, useState } from "react";/, "const { useEffect, useRef, useState } = globalThis.__kitchenSoundHooks;");
  source = source.replace('"./kitchen-api.js"', JSON.stringify(new URL("../src/kitchen-api.js", import.meta.url).href));
  source = source.replace('"./kitchen-order-sound.js"', JSON.stringify(new URL("../src/kitchen-order-sound.js", import.meta.url).href));
  const transformed = await transformWithEsbuild(source, "KitchenOrderSound.jsx", { jsx: "transform", jsxFactory: "globalThis.__kitchenSoundHooks.element", jsxFragment: "globalThis.__kitchenSoundHooks.fragment" });
  let index = 0, component, props, tree; const slots = [], effects = [];
  const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const hooks = {
    fragment: Symbol.for("test.fragment"),
    element: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    useRef: value => { const i=index++; return slots[i] || (slots[i]={current:value}); },
    useState: value => { const i=index++; if (!slots[i]) slots[i]={value:typeof value==='function'?value():value}; return [slots[i].value, v => { slots[i].value=typeof v==='function'?v(slots[i].value):v; }]; },
    useEffect: (run, deps) => { const i=index++; if (!same(slots[i]?.deps,deps)) { effects.push(() => { slots[i]?.cleanup?.(); slots[i]={deps,cleanup:run()}; }); } },
  };
  const render = () => { index=0;tree=component(props);while(effects.length)effects.shift()();index=0;tree=component(props);return tree; };
  const walk = node => !node || typeof node !== 'object' ? [] : [node,...(node.props?.children || []).flat(Infinity).flatMap(walk)];
  const find = predicate => walk(tree).find(predicate);
  const textOf = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? "" : (node.props?.children || []).flat(Infinity).map(textOf).join("");
  const priorWindow = globalThis.window; globalThis.__kitchenSoundHooks=hooks;
  let plays=0,reads=0;let clock=10;
  class Context {
    constructor(){this.state='running';this.currentTime=0;this.destination={};}
    async resume(){} async close(){}
    createOscillator(){return {frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){plays++;},stop(){}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const values=new Map();
  globalThis.window={location:{origin:'https://qa.example.test',search:''},performance:{now:()=>clock},AudioContext:Context,WARUN_KITCHEN_API_TOKEN:'fixture-only-token',localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},fetch:async(url)=>{reads++;return {ok:true,json:async()=>String(url).includes("checkout-requests")?{checkouts:[]}:{activeOrders:[]}};}};
  try {
    component=(await import('data:text/javascript;base64,'+Buffer.from(transformed.code).toString('base64'))).KitchenOrderSound;
    props={orders:[],ready:true,requestStartedAt:10,demoMode:false};render();
    const toggle=()=>find(n=>n.props?.role==='switch');
    assert.equal(toggle().props['aria-checked'],true);
    assert.match(textOf(toggle()), /音声未有効/);
    const activate=find(n=>n.type==='button'&&n.props.children.includes('音を有効にする'));
    assert.ok(activate);
    activate.props.onClick();render();
    assert.equal(toggle().props['aria-busy'],true);
    await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(reads,2);assert.equal(plays,0);
    assert.equal(toggle().props['aria-checked'],true);
    clock=20;props={...props,orders:[order('new')],requestStartedAt:20};render();
    assert.equal(toggle().props['aria-checked'],true);assert.equal(plays,3);
    find(n=>n.type==='input').props.onChange({target:{value:'80'}});render();
    assert.equal(toggle().props['aria-checked'],true);
    const trial=find(n=>n.type==='button'&&n.props.children.includes('音を試す'));
    await trial.props.onClick();await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(toggle().props['aria-checked'],true);assert.equal(plays,6);
    toggle().props.onClick();render();assert.equal(toggle().props['aria-checked'],false);
    await find(n=>n.type==='button'&&n.props.children.includes('音を試す')).props.onClick();await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(toggle().props['aria-checked'],false);assert.equal(plays,9);
    assert.equal(find(n=>n.type==='button'&&n.props.children.includes('呼出音を試す（隔離）')),undefined);
    props={...props,demoMode:true};render();
    const staffTrial=find(n=>n.type==='button'&&n.props.children.includes('呼出音を試す（隔離）'));
    assert.ok(staffTrial);
    await staffTrial.props.onClick();await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(plays,15);assert.equal(reads,2);
  } finally {
    for(const slot of slots)slot?.cleanup?.();globalThis.window=priorWindow;delete globalThis.__kitchenSoundHooks;
  }
});

test("checkout isolation preview invokes the audio-only controller test in demo mode", async () => {
  const source = await readFile(new URL("../src/KitchenOrderSound.jsx", import.meta.url), "utf8");
  const sound = await readFile(new URL("../src/kitchen-order-sound.js", import.meta.url), "utf8");
  assert.ok(source.includes('{demoMode ? <><button type="button" className="button button--quiet" disabled={enabling} onClick={() => void controller.current?.test("staffCall")}>呼出音を試す（隔離）</button><button type="button" className="button button--quiet" disabled={enabling} onClick={() => void controller.current?.test("checkout")}>お会計依頼音を試す（隔離）</button></> : null}'));
  const audioTrial = sound.slice(sound.indexOf('async test(kind = "order")'), sound.indexOf("observe(orders"));
  assert.match(audioTrial, /engine\.activate\(\)[\s\S]*engine\.play\(kind\)/);
  assert.doesNotMatch(audioTrial, /fetch|requestCheckout|POST/);
});

test("checkout notification and preview each schedule one three-tone group, with duplicate IDs silent", async () => {
  const oscillators = [];
  class Context {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    async resume() {} async close() {}
    createOscillator() {
      const node = { frequencyValues: [], frequency: { setValueAtTime(value, at) { node.frequencyValues.push([value, at]); } }, connect() {}, disconnect() {}, start(at) { this.startTime = at; }, stop(at) { this.stopTime = at; this.stopCalls = (this.stopCalls ?? 0) + 1; } };
      oscillators.push(node); return node;
    }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  const values = new Map();
  let baselineReads = 0;
  const controller = createKitchenOrderSound({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, storageKey: "triple-checkout", engine, now: () => 10, loadBaseline: async () => { baselineReads++; return { orders: [], staffCalls: [], checkoutRequests: [] }; } });
  try {
    controller.observe([]);
    await controller.enable();
    const checkout = { checkoutRequestId: "fixture-triple-checkout", status: "requested" };
    controller.observe([], { checkoutRequests: [checkout], requestStartedAt: 20 });
    assert.equal(oscillators.length, 3);
    controller.observe([], { checkoutRequests: [checkout], requestStartedAt: 30 });
    controller.observe([], { ready: false, checkoutRequests: [] });
    controller.observe([], { checkoutRequests: [checkout], requestStartedAt: 40 });
    controller.observe([], { checkoutRequests: [{ ...checkout, status: "ready" }], requestStartedAt: 50 });
    assert.equal(oscillators.length, 3);
    await controller.test("checkout");
    assert.equal(baselineReads, 1);
    assert.deepEqual(oscillators.map(node => node.startTime), [0, 0.5, 1, 1.5, 2, 2.5]);
    for (const node of oscillators) {
      assert.deepEqual(node.frequencyValues, [[880, node.startTime], [1174, node.startTime + 0.14]]);
      assert.ok(Math.abs(node.stopTime - node.startTime - 0.34) < 1e-10);
    }
    controller.disable();
    assert.ok(oscillators.every(node => node.stopCalls === 2));
  } finally { controller.dispose(); }
});

test("a requested checkout observed while sound activation is pending plays once after baseline", async () => {
  let resolveBaseline;
  const f = fixture({
    nowEpoch: () => 1000,
    loadBaseline: () => new Promise(resolve => { resolveBaseline = resolve; }),
  });
  f.controller.observe([]);
  const enabling = f.controller.enable();
  const arrivedDuringActivation = { checkoutRequestId: "checkout-during-enable", status: "requested", requestedAtMs: 1001 };
  f.advance(20);
  f.controller.observe([], { checkoutRequests: [arrivedDuringActivation], requestStartedAt: 15 });
  assert.deepEqual(f.playKinds, []);
  resolveBaseline({ orders: [], staffCalls: [], checkoutRequests: [] });
  await enabling;
  assert.deepEqual(f.playKinds, ["checkout"]);
  f.controller.observe([], { checkoutRequests: [arrivedDuringActivation], requestStartedAt: 30 });
  assert.deepEqual(f.playKinds, ["checkout"]);
});

test("existing baseline checkout observed while enabling stays silent", async () => {
  let resolveBaseline;
  const existing = { checkoutRequestId: "checkout-before-enable", status: "requested", requestedAtMs: 999 };
  const f = fixture({
    nowEpoch: () => 1000,
    loadBaseline: () => new Promise(resolve => { resolveBaseline = resolve; }),
  });
  f.controller.observe([]);
  const enabling = f.controller.enable();
  f.controller.observe([], { checkoutRequests: [existing], requestStartedAt: 15 });
  resolveBaseline({ orders: [], staffCalls: [], checkoutRequests: [existing] });
  await enabling;
  assert.deepEqual(f.playKinds, []);
  assert.deepEqual(JSON.parse(f.store.getItem("test")).seenCheckoutIds, [existing.checkoutRequestId]);
});

test("new checkout created after activation is not lost to a pre-activation snapshot", async () => {
  const f = fixture({ nowEpoch: () => 1000 });
  f.controller.observe([]);
  await f.controller.enable();
  const arrivedAfterActivation = { checkoutRequestId: "checkout-after-enable", status: "requested", requestedAtMs: 1001 };
  f.controller.observe([], { checkoutRequests: [arrivedAfterActivation], requestStartedAt: 9 });
  assert.deepEqual(f.playKinds, ["checkout"]);
  f.controller.observe([], { checkoutRequests: [arrivedAfterActivation], requestStartedAt: 30 });
  assert.deepEqual(f.playKinds, ["checkout"]);
});


// The counts below are oscillator notes in a complete set, not play() calls.
function originToneFixture({ baseline = [], epoch = 1800000000000, values = new Map() } = {}) {
  const notes = [], envelopes = [];
  let clock = 10;
  class Context {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    async resume() {} async close() { this.state = "closed"; }
    createOscillator() {
      const note = { frequencies: [], frequency: { setValueAtTime(value, at) { note.frequencies.push([value, at]); } },
        connect() {}, disconnect() {}, start(at) { this.startTime = at; },
        stop(at) { this.stopTime ??= at; this.stopCalls = (this.stopCalls ?? 0) + 1; } };
      notes.push(note); return note;
    }
    createGain() {
      const values = []; envelopes.push(values);
      return { gain: { setValueAtTime: (v, t) => values.push([v, t]),
        linearRampToValueAtTime: (v, t) => values.push([v, t]),
        exponentialRampToValueAtTime: (v, t) => values.push([v, t]) }, connect() {}, disconnect() {} };
    }
  }
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const engine = createKitchenSoundEngine({ env: { AudioContext: Context } });
  const controller = createKitchenOrderSound({ storage, storageKey: "origin-tones-fixture", engine,
    now: () => clock, nowEpoch: () => epoch, loadBaseline: async () => baseline });
  return { controller, engine, notes, envelopes, values, epoch, clock: value => { clock = value; } };
}
function assertToneNotes(notes, starts, frequency = 880, duration = 0.34) {
  assert.equal(notes.length, starts.length);
  for (const [i, note] of notes.entries()) {
    assert.ok(Math.abs(note.startTime - starts[i]) < 1e-10);
    assert.ok(Math.abs(note.stopTime - note.startTime - duration) < 1e-10);
    const expected = frequency === 880 ? [[880, note.startTime], [1174, note.startTime + 0.14]] : [[frequency, note.startTime]];
    assert.deepEqual(note.frequencies, expected);
  }
}

test("origin tones: snapshot origins select A90 three notes and both kitchen additions one note", async () => {
  const raw = [
    { orderId: "fixture-a90", orderOrigin: "customer" },
    { orderId: "fixture-kitchen-menu", orderOrigin: "kitchen_addition" },
    { orderId: "fixture-kitchen-quantity", orderOrigin: "kitchen_addition" },
  ].map(row => ({ ...row, tableId: 1, sessionId: "fixture-session", acceptedAtMs: 1800000000001,
    status: "new", version: 1, totalAmountYen: 100, items: [] }));
  const env = { location: { origin: "http://fixture.invalid" }, WARUN_KITCHEN_API_TOKEN: "fixture-only-dummy",
    fetch: async () => ({ ok: true, json: async () => ({ activeOrders: raw }) }) };
  const snapshot = await fetchKitchenSnapshot({ env });
  assert.deepEqual(snapshot.orders.map(row => [row.id, row.orderOrigin]), raw.map(row => [row.orderId, row.orderOrigin]));
  const f = originToneFixture();
  try {
    await f.controller.enable();
    f.controller.observe(snapshot.orders, { requestStartedAt: 20 });
    assertToneNotes(f.notes, [0, 0.5, 1, 1.5, 1.92]);
    f.controller.observe(snapshot.orders, { requestStartedAt: 30 });
    assert.equal(f.notes.length, 5, "The same three server IDs must not schedule again");
  } finally { f.controller.dispose(); }
});

test("origin tones: preview and A90 notification each schedule the full same three-note envelope", async () => {
  const f = originToneFixture();
  try {
    await f.controller.test();
    assertToneNotes(f.notes, [0, 0.5, 1]);
    assert.equal(f.controller.getState().status, "needs-activation", "Preview must not enable notifications");
    await f.controller.enable();
    f.controller.observe([{ ...order("fixture-customer"), orderOrigin: "customer" }], { requestStartedAt: 20 });
    assertToneNotes(f.notes, [0, 0.5, 1, 1.5, 2, 2.5]);
    for (const envelope of f.envelopes) {
      assert.equal(envelope[1][0], KITCHEN_NOTIFICATION_GAIN);
      assert.equal(envelope[2][0], KITCHEN_NOTIFICATION_GAIN);
      assert.ok(Math.abs(envelope[2][1] - envelope[0][1] - 0.20) < 1e-10);
    }
  } finally { f.controller.dispose(); }
});

test("origin tones: simultaneous customer, staff and checkout keep existing dispatch order without overlapping sets", async () => {
  const f = originToneFixture();
  try {
    await f.controller.enable();
    f.controller.observe([{ ...order("fixture-customer"), orderOrigin: "customer" }], {
      requestStartedAt: 20,
      staffCalls: [{ id: "fixture-call", status: "open", createdAtMs: f.epoch + 1 }],
      checkoutRequests: [{ checkoutRequestId: "fixture-checkout", status: "requested", requestedAtMs: f.epoch + 1 }],
    });
    assertToneNotes(f.notes.slice(0, 3), [0, 0.5, 1]);
    const staffStarts = [2, 2.27, 2.85, 3.12, 3.7, 3.97];
    for (let i = 0; i < 6; i++) assertToneNotes([f.notes[i + 3]], [staffStarts[i]], i % 2 ? 659 : 523, 0.18);
    assertToneNotes(f.notes.slice(9), [4.2, 4.7, 5.2]);
    for (let i = 1; i < f.notes.length; i++) assert.ok(f.notes[i].startTime >= f.notes[i - 1].stopTime);
  } finally { f.controller.dispose(); }
});

for (const action of ["OFF", "mute", "dispose"]) {
  test("origin tones: " + action + " stops every already scheduled note including second and third", async () => {
    const f = originToneFixture();
    try {
      await f.controller.test();
      assertToneNotes(f.notes, [0, 0.5, 1]);
      if (action === "OFF") f.controller.disable();
      else if (action === "mute") f.controller.setVolume(0);
      else f.controller.dispose();
      assert.ok(f.notes.every(note => note.stopCalls === 2));
    } finally { f.controller.dispose(); }
  });
}

test("origin tones: baseline, known IDs and OFF observations remain silent for both origins", async () => {
  const old = [{ ...order("fixture-old-customer"), orderOrigin: "customer" },
    { ...order("fixture-old-kitchen"), orderOrigin: "kitchen_addition" }];
  const f = originToneFixture({ baseline: old });
  try {
    await f.controller.enable();
    f.controller.observe(old, { requestStartedAt: 20 });
    assert.equal(f.notes.length, 0);
    const next = [{ ...order("fixture-new-customer"), orderOrigin: "customer" },
      { ...order("fixture-new-kitchen"), orderOrigin: "kitchen_addition" }];
    f.controller.observe(next, { requestStartedAt: 30 });
    assertToneNotes(f.notes, [0, 0.5, 1, 1.5]);
    f.controller.observe(next, { requestStartedAt: 40 });
    assert.equal(f.notes.length, 4);
    f.controller.disable();
    const off = [{ ...order("fixture-off"), orderOrigin: "customer" }];
    f.controller.observe(off, { requestStartedAt: 50 });
    await f.controller.enable();
    f.controller.observe(off, { requestStartedAt: 60 });
    assert.equal(f.notes.length, 4);
  } finally { f.controller.dispose(); }
});

test("origin tones: slow pre-ON result leaves new customer ID for one trailing three-note set", async () => {
  const { createKitchenRefresher } = await import("../src/kitchen-refresh.js");
  const f = originToneFixture(), requests = [], timers = new Set();
  const reader = createKitchenRefresher({
    load: () => new Promise(resolve => requests.push(resolve)),
    onData: data => f.controller.observe(data.orders, { requestStartedAt: data.startedAt }),
    onError: error => { throw error; },
    setTimeoutImpl: callback => { const token = { callback }; timers.add(token); return token; },
    clearTimeoutImpl: token => timers.delete(token),
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    const first = reader.refresh(); await flush();
    await f.controller.enable(); f.clock(20);
    const trailing = reader.refresh();
    const n = { ...order("fixture-after-on"), orderOrigin: "customer", createdAt: new Date(f.epoch + 1).toISOString() };
    requests[0]({ orders: [n], startedAt: 5 }); await first; await flush();
    assert.equal(f.notes.length, 0);
    assert.ok(!JSON.parse(f.values.get("origin-tones-fixture")).seenIds.includes(n.id));
    requests[1]({ orders: [n], startedAt: 20 }); await trailing;
    assertToneNotes(f.notes, [0, 0.5, 1]);
    const later = reader.refresh(); await flush();
    requests[2]({ orders: [n], startedAt: 30 }); await later;
    assert.equal(f.notes.length, 3);
    assert.equal(requests.length, 3); assert.equal(timers.size, 0);
  } finally { reader.stop(); f.controller.dispose(); }
});
