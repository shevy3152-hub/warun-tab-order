import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fetchKitchenSnapshot } from "../src/kitchen-api.js";
import { createKitchenOrderSound, createKitchenSoundEngine, kitchenSoundStorageKey, KITCHEN_NOTIFICATION_GAIN } from "../src/kitchen-order-sound.js";
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
test("initial OFF and first successful snapshot never replay existing orders", async () => {
  const f = fixture();
  assert.equal(f.controller.getState().status, "off");
  f.controller.observe([order("old")]);
  await f.controller.enable();
  f.controller.observe([], { requestStartedAt: 10 });
  f.controller.observe([order("old")], { requestStartedAt: 20 });
  assert.equal(f.plays(), 0);
  const early = fixture({ loadBaseline: async () => [order("existing")] });
  early.controller.observe([], { ready: false });
  await early.controller.enable();
  early.controller.observe([order("existing")], { requestStartedAt: 20 });
  assert.equal(early.plays(), 0);
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
test("staff calls received while notifications are OFF stay silent after enabling", async () => {
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
  f.controller.observe([order("notified")], { staffCalls: [knownCall], requestStartedAt: 20 });
  assert.deepEqual(f.playKinds, ["order", "staffCall"]);
  f.controller.dispose();
  const reloaded = fixture({ storage: f.store });
  assert.equal(reloaded.controller.getState().status, "off");
  assert.match(reloaded.controller.getState().message, /前回はON/);
  reloaded.controller.observe([]);
  await reloaded.controller.enable();
  reloaded.controller.observe([], { requestStartedAt: 10 });
  reloaded.controller.observe([order("notified"), order("next")], { staffCalls: [knownCall], requestStartedAt: 20 });
  assert.equal(reloaded.plays(), 1);
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
  assert.match(playback.controller.getState().message, /注文とスタッフ呼出の画面表示は続きます/);
});
test("test while OFF does not enable new-order sounds; audio suspension shows a blocked state", async () => {
  const f = fixture();
  await f.controller.test();
  assert.equal(f.plays(), 1);
  assert.equal(f.controller.getState().status, "off");
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
  assert.equal(oscillators[1].startTime, 0.42);
  engine.stop();
  assert.equal(oscillators[0].stopCalls, 2);
  assert.equal(oscillators[1].stopCalls, 2);
  engine.dispose();
  assert.equal(context.state, "closed");
  await assert.rejects(createKitchenSoundEngine({ env: {} }).activate());
});
test("staff-call double tone is distinct and queued after the order tone without overlap", async () => {
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
  assert.deepEqual(oscillators.map((node) => node.startTime), [0, 0.42, 0.61]);
  assert.deepEqual(oscillators.map((node) => node.frequencyValues[0][0]), [880, 523, 659]);
  for (let index = 1; index < oscillators.length; index++) assert.ok(oscillators[index].startTime >= oscillators[index - 1].stopTime);
  engine.dispose();
});
test("sound controls belong only to kitchen and use snapshot request timing", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const kitchen = app.slice(app.indexOf("function KitchenScreen"));
  assert.match(kitchen, /<KitchenOrderSound orders=\{liveOrders\}/);
  assert.match(kitchen, /staffCalls=\{activeCalls\}/);
  assert.match(app, /onReconnect: \(\) => \{ suppressStaffCallsUntilSnapshot = true; void load\(\); \}/);
  assert.equal((app.match(/<KitchenOrderSound /g) || []).length, 1);
  assert.match(app, /notificationRequestStartedAt: snapshot.notificationRequestStartedAt/);
  assert.match(app, /playCheckoutBell\(checkoutAudioRef\)/);
  const component = await readFile(new URL("../src/KitchenOrderSound.jsx", import.meta.url), "utf8");
  assert.match(component, /音を試す/);
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

test("audio and API failures have specific safe reasons and never display ON", async () => {
  const audio = fixture({ activate: async () => { throw Object.assign(new Error("private detail"), { name: "NotAllowedError" }); } });
  await audio.controller.enable();
  assert.equal(audio.controller.getState().audioStatus, "failed");
  assert.match(audio.controller.getState().message, /ブラウザーが音声の有効化を拒否/);
  assert.doesNotMatch(audio.controller.getState().message, /private detail/);
  const api = fixture({ loadBaseline: async () => { throw Object.assign(new Error("private detail"), { status: 401 }); } });
  await api.controller.enable();
  assert.equal(api.controller.getState().baselineStatus, "failed");
  assert.match(api.controller.getState().message, /HTTP 401/);
  assert.equal(api.controller.getState().status, "blocked");
  assert.match(api.controller.getState().message, /再度有効化/);
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
  assert.equal(envelopes.length, 2);
  for (const envelope of envelopes) {
    assert.equal(envelope[1][0], KITCHEN_NOTIFICATION_GAIN);
    assert.equal(envelope[2][0], KITCHEN_NOTIFICATION_GAIN);
    assert.equal(envelope[2][1] - envelope[0][1], 0.20);
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


test("volume defaults to the previous gain, persists locally, and reload is always OFF", async () => {
  const f = fixture();
  assert.equal(f.controller.getState().volume, 50);
  const volumes = []; f.engine.setVolume = value => volumes.push(value);
  f.controller.setVolume(80);
  assert.equal(f.controller.getState().status, "off");
  assert.deepEqual(volumes, [80]);
  await f.controller.setEnabled(true);
  assert.equal(f.controller.getState().status, "on");
  f.controller.setVolume(100);
  assert.equal(f.controller.getState().status, "on");
  f.controller.observe([order("new")], { requestStartedAt: 20 });
  assert.equal(f.controller.getState().status, "on");
  const reloaded = fixture({ storage: f.store });
  assert.equal(reloaded.controller.getState().volume, 100);
  assert.equal(reloaded.controller.getState().status, "off");
  f.controller.setEnabled(false);
  assert.equal(f.controller.getState().status, "off");
});

test("test leaves switch state unchanged both ON and OFF; muted observations remain deduplicated", async () => {
  const f = fixture();
  await f.controller.test();
  assert.equal(f.controller.getState().status, "off");
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
  engine.setVolume(0);engine.play();assert.equal(nodes,1);assert.equal(mutedStops,1);
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
  const transformed = await transformWithEsbuild(source, "KitchenOrderSound.jsx", { jsx: "transform", jsxFactory: "globalThis.__kitchenSoundHooks.element" });
  let index = 0, component, props, tree; const slots = [], effects = [];
  const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const hooks = {
    element: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    useRef: value => { const i=index++; return slots[i] || (slots[i]={current:value}); },
    useState: value => { const i=index++; if (!slots[i]) slots[i]={value}; return [slots[i].value, v => { slots[i].value=typeof v==='function'?v(slots[i].value):v; }]; },
    useEffect: (run, deps) => { const i=index++; if (!same(slots[i]?.deps,deps)) { effects.push(() => { slots[i]?.cleanup?.(); slots[i]={deps,cleanup:run()}; }); } },
  };
  const render = () => { index=0;tree=component(props);while(effects.length)effects.shift()();index=0;tree=component(props);return tree; };
  const walk = node => !node || typeof node !== 'object' ? [] : [node,...(node.props?.children || []).flat(Infinity).flatMap(walk)];
  const find = predicate => walk(tree).find(predicate);
  const priorWindow = globalThis.window; globalThis.__kitchenSoundHooks=hooks;
  let plays=0,reads=0;let clock=10;
  class Context {
    constructor(){this.state='running';this.currentTime=0;this.destination={};}
    async resume(){} async close(){}
    createOscillator(){return {frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){plays++;},stop(){}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const values=new Map();
  globalThis.window={location:{origin:'https://qa.example.test',search:''},performance:{now:()=>clock},AudioContext:Context,WARUN_KITCHEN_API_TOKEN:'fixture-only-token',localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},fetch:async()=>{reads++;return {ok:true,json:async()=>({activeOrders:[]})};}};
  try {
    component=(await import('data:text/javascript;base64,'+Buffer.from(transformed.code).toString('base64'))).KitchenOrderSound;
    props={orders:[],ready:true,requestStartedAt:10,demoMode:false};render();
    const toggle=()=>find(n=>n.props?.role==='switch');
    assert.equal(toggle().props['aria-checked'],false);
    toggle().props.onClick();render();
    assert.equal(toggle().props['aria-busy'],true);
    await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(reads,1);assert.equal(plays,0);
    assert.equal(toggle().props['aria-checked'],true);
    clock=20;props={...props,orders:[order('new')],requestStartedAt:20};render();
    assert.equal(toggle().props['aria-checked'],true);assert.equal(plays,1);
    find(n=>n.type==='input').props.onChange({target:{value:'80'}});render();
    assert.equal(toggle().props['aria-checked'],true);
    const trial=find(n=>n.type==='button'&&n.props.children.includes('音を試す'));
    await trial.props.onClick();await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(toggle().props['aria-checked'],true);assert.equal(plays,2);
    toggle().props.onClick();render();assert.equal(toggle().props['aria-checked'],false);
    await find(n=>n.type==='button'&&n.props.children.includes('音を試す')).props.onClick();await new Promise(resolve=>setImmediate(resolve));render();
    assert.equal(toggle().props['aria-checked'],false);assert.equal(plays,3);
  } finally {
    for(const slot of slots)slot?.cleanup?.();globalThis.window=priorWindow;delete globalThis.__kitchenSoundHooks;
  }
});
