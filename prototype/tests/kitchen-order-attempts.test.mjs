import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createKitchenOrderAttempts, createKitchenOrderStorageLock, KITCHEN_ORDER_ATTEMPT_PREFIX } from "../src/kitchen-order-attempts.js";
import { createKitchenOrder, adjustKitchenOrderItemQuantity, kitchenAdditionRequestItem } from "../src/kitchen-api.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const addition = { tableId: 1, sessionId: uuid(10), items: [{ menuItemId: "fictional-item", quantity: 1 }] };
const increase = { orderId: uuid(20), orderItemId: 1, expectedBillableQuantity: 1 };
const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const noop = () => {};
function memoryStorage() {
  const data = new Map([["unrelated-setting", "keep"]]);
  return { get length() { return data.size; }, key(index) { return [...data.keys()][index] ?? null; }, getItem(key) { return data.get(key) ?? null; }, setItem(key, value) { data.set(key, String(value)); }, removeItem(key) { data.delete(key); } };
}
function serialStorageLock() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
function fixture({ lose = false, pause = false, storage = memoryStorage() } = {}) {
  const saved = new Map(); const calls = []; const releases = [];
  const withStorageLock = serialStorageLock();
  let ids = 0; let rejection = null;
  const env = { location: { origin: "https://isolated.example.test" }, WARUN_KITCHEN_API_TOKEN: "fictional-test-credential" };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (rejection) return { ok: false, status: rejection.status, json: async () => ({ error: { code: rejection.code } }) };
    const id = body.clientOrderId ?? body.operationId;
    const prior = saved.get(id);
    if (prior) assert.deepEqual(body, prior, "replay must have exactly the original request");
    else saved.set(id, structuredClone(body));
    if (lose && calls.length === 1) throw new TypeError("isolated response loss after commit");
    if (pause) await new Promise((resolve) => releases.push(resolve));
    return { ok: true, status: prior ? 200 : 201, json: async () => ({ orders: [{ orderId: body.orderId ?? uuid(100 + saved.size) }] }) };
  };
  const make = () => createKitchenOrderAttempts({ storage, withStorageLock, idFactory: () => uuid(++ids), now: () => 1000,
    sendAddition: (request) => createKitchenOrder({ ...request, env, fetchImpl }),
    sendIncrease: (request) => adjustKitchenOrderItemQuantity({ ...request, env, fetchImpl }),
  });
  return { make, controller: make(), storage, saved, calls, releases, reject: (value) => { rejection = value; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function handler(name, end, bindings, text = source) {
  const start = text.indexOf(`  const ${name} =`);
  assert.ok(start >= 0);
  const body = text.slice(start, text.indexOf(`  const ${end} =`, start));
  return new Function(...Object.keys(bindings), `${body}; return ${name};`)(...Object.values(bindings));
}

test("rapid repeated addition saves share one in-flight mutation", async () => {
  const f = fixture({ pause: true });
  const results = [f.controller.submitAddition(addition), f.controller.submitAddition(addition), f.controller.submitAddition(addition)];
  await tick();
  assert.equal(f.saved.size, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getState().busy, true);
  f.releases.forEach((release) => release()); await Promise.all(results);
  assert.equal(f.controller.getState().pending.length, 0);
});

test("rapid repeated one-item increases share one in-flight mutation", async () => {
  const f = fixture({ pause: true });
  const first = f.controller.submitIncrease(increase);
  const second = f.controller.submitIncrease(increase);
  await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.saved.size, 1);
  f.releases.forEach((release) => release()); await Promise.all([first, second]);
});

test("an unresolved increase never changes its target, expected quantity, or direction", async () => {
  const f = fixture({ lose: true });
  await assert.rejects(() => f.controller.submitIncrease(increase));
  for (const changed of [{ orderId: uuid(21) }, { orderItemId: 2 }, { expectedBillableQuantity: 2 }, { direction: "decrease" }, { confirmZero: true }, { reason: "別操作" }]) {
    await assert.rejects(() => f.controller.submitIncrease({ ...increase, ...changed }));
  }
  assert.equal(f.calls.length, 1);
  await f.controller.retry(f.controller.getState().pending[0].id);
  assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.equal(f.saved.size, 1);
});

test("failed local cleanup preserves the acknowledgement and the remaining same-ID record", async () => {
  const storage = memoryStorage(); const remove = storage.removeItem;
  storage.removeItem = () => { throw new Error("isolated storage failure"); };
  const f = fixture({ storage });
  const acknowledged = await f.controller.submitAddition(addition); assert.equal(acknowledged.orderId, uuid(101));
  assert.equal(f.controller.getState().pending.length, 1); assert.equal(f.saved.size, 1);
  storage.removeItem = remove;
  await f.controller.retry(f.controller.getState().pending[0].id);
  assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.equal(f.saved.size, 1);
});

for (const [kind, request, method, key] of [["addition", addition, "submitAddition", "clientOrderId"], ["increase", increase, "submitIncrease", "operationId"]]) {
  test(`${kind} retries a saved order after response loss with the same ID and body`, async () => {
    const f = fixture({ lose: true });
    await assert.rejects(() => f.controller[method](request), /保存結果が未確認/);
    assert.equal(f.saved.size, 1); assert.equal(f.controller.getState().pending.length, 1);
    await f.controller[method](request);
    assert.equal(f.saved.size, 1); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body[key], f.calls[1].body[key]);
    assert.deepEqual(f.calls[0].body, f.calls[1].body);
    assert.equal(f.controller.getState().pending.length, 0);
  });
  test(`${kind} intentionally repeated after confirmation creates a separate order`, async () => {
    const f = fixture();
    await f.controller[method](request); await f.controller[method](request);
    assert.equal(f.saved.size, 2); assert.notEqual(f.calls[0].body[key], f.calls[1].body[key]);
  });
  test(`${kind} survives reload or screen closure using only its persisted intent`, async () => {
    const f = fixture({ lose: true });
    await assert.rejects(() => f.controller[method](request));
    const reopened = f.make();
    const pending = reopened.getState().pending[0];
    await reopened.retry(pending.id);
    assert.equal(f.saved.size, 1); assert.deepEqual(f.calls[0].body, f.calls[1].body);
    assert.equal(f.storage.getItem("unrelated-setting"), "keep");
  });
}

test("changed contents and another kind cannot reuse an unresolved operation ID", async () => {
  const f = fixture({ lose: true });
  await assert.rejects(() => f.controller.submitAddition(addition));
  await assert.rejects(() => f.controller.submitAddition({ ...addition, items: [{ menuItemId: "fictional-item", quantity: 2 }] }), (e) => e.code === "KITCHEN_ORDER_PENDING");
  await assert.rejects(() => f.controller.submitIncrease(increase), (e) => e.code === "KITCHEN_ORDER_PENDING");
  assert.equal(f.calls.length, 1);
  await f.controller.retry(f.controller.getState().pending[0].id);
  await f.controller.submitAddition({ ...addition, items: [{ name: "架空別注文", priceYen: 500, quantity: 2 }] });
  assert.equal(f.saved.size, 2); assert.notEqual(f.calls[0].body.clientOrderId, f.calls[2].body.clientOrderId);
});

test("closing a screen during transmission and retrying preserves one saved order", async () => {
  const f = fixture({ pause: true });
  const first = f.controller.submitIncrease(increase); await tick();
  const reopened = f.make();
  const second = reopened.retry(reopened.getState().pending[0].id); await tick();
  assert.equal(f.saved.size, 1); assert.deepEqual(f.calls[0].body, f.calls[1].body);
  f.releases.forEach((release) => release()); await Promise.all([first, second]);
  assert.equal(reopened.getState().pending.length, 0);
});

test("unavailable, full, or corrupt storage prevents mutations before sending", async () => {
  for (const storage of [null, { ...memoryStorage(), setItem() { throw new Error("quota"); } }, memoryStorage()]) {
    if (storage?.setItem && storage.getItem("unrelated-setting") === "keep" && storage.setItem.name === "setItem") {
      try { storage.setItem(KITCHEN_ORDER_ATTEMPT_PREFIX + uuid(90), "corrupt"); } catch { /* quota fixture */ }
    }
    const f = fixture({ storage });
    await assert.rejects(() => f.controller.submitAddition(addition));
    assert.equal(f.calls.length, 0);
  }
});

test("a known initial rejection allows a corrected new intent, but an ambiguous retry retains its ID", async () => {
  const f = fixture(); f.reject({ status: 409, code: "ORDER_CONFLICT" });
  await assert.rejects(() => f.controller.submitAddition(addition));
  assert.equal(f.controller.getState().pending.length, 0);
  f.reject(null); await f.controller.submitAddition(addition);
  assert.notEqual(f.calls[0].body.clientOrderId, f.calls[1].body.clientOrderId);
  const g = fixture({ lose: true }); await assert.rejects(() => g.controller.submitIncrease(increase));
  g.reject({ status: 401, code: "AUTHENTICATION_FAILED" });
  await assert.rejects(() => g.controller.retry(g.controller.getState().pending[0].id));
  assert.equal(g.controller.getState().pending.length, 1);
  assert.equal(g.calls[0].body.operationId, g.calls[1].body.operationId);
});

test("mutating caller data cannot change the persisted retry body and no credentials are stored", async () => {
  const f = fixture({ lose: true }); const draft = structuredClone(addition);
  await assert.rejects(() => f.controller.submitAddition({ ...draft, token: "fictional-extra-field" }));
  draft.items[0].quantity = 9;
  const pending = f.controller.getState().pending[0];
  assert.equal(pending.request.items[0].quantity, 1);
  assert.equal(JSON.stringify(pending).includes("credential"), false); assert.equal(JSON.stringify(pending).includes("token"), false);
  await f.controller.retry(pending.id);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
});

test("actual App addition and increase handlers use the retained mutation controller", async () => {
  const f = fixture({ lose: true });
  const common = { apiMode: true, kitchenOrderAttempts: f.controller, createKitchenOperationId: () => { throw new Error("must use retained operation ID"); }, window: { dispatchEvent: noop }, CustomEvent: class {}, kitchenAdditionRequestItem: (item) => item, updateState: noop };
  const add = handler("submitKitchenAddition", "toggleServed", common);
  await assert.rejects(() => add({ tableId: 1, sessionId: uuid(10), item: addition.items[0] }));
  await add({ tableId: 1, sessionId: uuid(10), item: addition.items[0] }); assert.equal(f.saved.size, 1);
  const g = fixture({ lose: true });
  const plus = handler("submitQuantityAdjustment", "saveItemPrice", { ...common, kitchenOrderAttempts: g.controller, priceDraftRevision: { current: 0 }, priceDraftOpenedRevision: { current: 0 }, priceTarget: { orderId: uuid(20), id: 1, billableQuantity: 1, locked: false }, quantityReason: "", setQuantityBusy: noop, setQuantityError: noop, setQuantityZeroConfirm: noop, setQuantityReason: noop, setPriceTarget: noop });
  await plus("increase"); await plus("increase"); assert.equal(g.saved.size, 1);
});

test("actual modal submit lock stops same-tick clicks and catches failed saves", async () => {
  const modal = source.slice(source.indexOf("function KitchenAdditionModal"), source.indexOf("function cancelledQuantityForDisplay"));
  const submitCode = modal.slice(modal.indexOf("  const submit ="), modal.indexOf("  return <Modal"));
  let calls = 0; let release; let error = "";
  const submit = new Function("submitLock", "locked", "quantity", "kind", "menuItems", "menuItemId", "setError", "onSubmit", "draftRevision", "submissionRef", "mountedRef", "pendingRef", "confirmedIdRef", "onConfirmed", "target", "kitchenAdditionRequestItem", submitCode + "; return submit;")({ current: false }, false, "1", "menu", [{ id: "fictional-item", name: "架空検証品", price: 300 }], "fictional-item", (value) => { error = value; }, async () => { calls++; await new Promise((resolve) => { release = resolve; }); throw new Error("架空通信エラー"); }, { current: 0 }, { current: null }, { current: true }, { current: null }, { current: null }, () => { throw new Error("failed save must not close the modal"); }, { tableId: 1, sessionId: uuid(10) }, kitchenAdditionRequestItem);
  const first = submit({ preventDefault: noop }); const second = submit({ preventDefault: noop });
  assert.equal(calls, 1); release(); await Promise.all([first, second]); assert.equal(error, "架空通信エラー");
});

test("quantity increase acknowledgement remains confirmed if its later display refresh fails", async () => {
  const adjust = handler("adjustKitchenItemQuantity", "changeKitchenOrderItemCancellation", { window: {}, adjustKitchenItemQuantityRequest: async () => ({ orderId: uuid(20) }), fetchKitchenSnapshot: async () => { throw new Error("isolated refresh error"); }, fetchKitchenCheckoutRequests: async () => [], setKitchenApiState: noop, setKitchenCheckoutState: noop });
  assert.deepEqual(await adjust({ direction: "increase" }), { orderId: uuid(20) }); await tick();
});

function modalHandler(name, next, bindings) {
  const modal = source.slice(source.indexOf("function KitchenAdditionModal"), source.indexOf("function cancelledQuantityForDisplay"));
  const code = modal.slice(modal.indexOf(`  const ${name} =`), modal.indexOf(`  ${next}`));
  return new Function(...Object.keys(bindings), code + `; return ${name};`)(...Object.values(bindings));
}

test("addition modal retry closes only its own unchanged draft", async () => {
  for (const scenario of ["own", "reopened-pending", "other-draft", "edited-before", "edited-after", "different-pending", "unmounted", "failed"]) {
    const pending = { id: uuid(1), kind: "addition", request: addition };
    const revision = { current: scenario === "edited-before" ? 2 : 1 };
    let closed = 0; let release; let error = "";
    const pendingRef = { current: pending };
    const retry = modalHandler("retry", "const submit =", {
      pendingHere: true, busy: false, submitLock: { current: false }, pending,
      draftRevision: revision, openedPendingId: { current: scenario === "reopened-pending" ? pending.id : null },
      submissionRef: { current: scenario === "other-draft" || scenario === "reopened-pending" ? null : { id: pending.id, revision: 1 } },
      mountedRef: { current: scenario !== "unmounted" }, pendingRef,
      onRetry: async (attempt) => { assert.equal(attempt, pending); await new Promise((resolve) => { release = resolve; }); return scenario !== "failed"; },
      setError: (value) => { error = value; }, onConfirmed: () => { closed++; },
    });
    if (scenario === "reopened-pending") revision.current = 0;
    const waiting = retry();
    if (scenario === "edited-after") revision.current++;
    if (scenario === "different-pending") pendingRef.current = { ...pending, id: uuid(2) };
    release(); await waiting;
    assert.equal(closed, scenario === "own" || scenario === "reopened-pending" ? 1 : 0, scenario);
    assert.equal(Boolean(error), scenario === "failed", scenario);
  }
});

test("addition modal late save leaves changed input and a replacement instance intact", async () => {
  for (const scenario of ["unchanged", "edited", "unmounted", "different-pending"]) {
    const revision = { current: 1 }; const mounted = { current: true }; const pending = { current: null };
    let closed = 0; let release; let submitted;
    const submit = modalHandler("submit", "return <Modal", {
      submitLock: { current: false }, locked: false, quantity: "2", kind: "menu", menuItems: [{ id: "fictional-item", name: "架空検証品", price: 300 }], menuItemId: "fictional-item",
      setError: (message) => { if (message) throw new Error(message); }, target: { tableId: 1, sessionId: uuid(10) }, kitchenAdditionRequestItem, draftRevision: revision, submissionRef: { current: null }, mountedRef: mounted, pendingRef: pending, confirmedIdRef: { current: null }, onConfirmed: () => { closed++; },
      onSubmit: async (item, onPrepared) => { submitted = structuredClone(item); onPrepared(uuid(1)); await new Promise((resolve) => { release = resolve; }); },
    });
    const waiting = submit({ preventDefault: noop });
    if (scenario === "edited") revision.current++;
    if (scenario === "unmounted") mounted.current = false;
    if (scenario === "different-pending") pending.current = { id: uuid(2) };
    release(); await waiting;
    assert.deepEqual(submitted, { menuItemId: "fictional-item", name: "架空検証品", priceYen: 300, quantity: 2 });
    assert.equal(closed, scenario === "unchanged" ? 1 : 0, scenario);
  }
});

test("global pending retry never closes another addition or price draft", async () => {
  const attempt = { id: uuid(1) }; let retried;
  const retry = handler("retryPendingKitchenOrder", "retryPendingKitchenQuantity", {
    pendingOrderAttempt: attempt, kitchenOrderAttempts: { retry: async (id) => { retried = id; } },
    setOrderAttemptMessage: noop, setAdditionTarget: () => { throw new Error("another addition must stay"); }, setPriceTarget: () => { throw new Error("another price draft must stay"); },
  });
  assert.equal(await retry(), true); assert.equal(retried, attempt.id);
});

test("quantity retry keeps preexisting, later-edited and replacement price drafts", async () => {
  for (const scenario of ["unchanged", "edited-before", "edited-after", "replacement"]) {
    const target = { orderId: uuid(20), id: 1 };
    const revision = { current: scenario === "edited-before" ? 2 : 1 };
    let current = target; let release;
    const retry = handler("retryPendingKitchenQuantity", "sessions", {
      priceTarget: target, pendingOrderAttempt: { id: uuid(1), kind: "increase", request: increase },
      priceDraftRevision: revision, priceDraftOpenedRevision: { current: 1 },
      retryPendingKitchenOrder: async () => { await new Promise((resolve) => { release = resolve; }); return true; },
      setPriceTarget: (updater) => { current = updater(current); },
    });
    const waiting = retry();
    if (scenario === "edited-after") revision.current++;
    if (scenario === "replacement") current = { ...target };
    const expected = scenario === "unchanged" ? null : current;
    release(); await waiting; assert.equal(current, expected, scenario);
  }
});

function preparationFixture(mode = "normal") {
  const data = memoryStorage(); let blocked = false; let writes = 0; let locks = 0; let ids = 0; let inside = false;
  const calls = []; const observations = []; const failures = []; let release;
  const unavailable = () => Object.assign(new Error("isolated lock failure"), { code: "KITCHEN_ORDER_LOCK_UNAVAILABLE" });
  const guard = () => { if (blocked) throw new Error("isolated unreadable records"); };
  const storage = {
    get length() { guard(); return data.length; }, key: (index) => { guard(); return data.key(index); }, getItem: (key) => { guard(); return data.getItem(key); },
    setItem(key, value) {
      writes++;
      if (mode === "write-before" && writes === 1) throw new Error("isolated no-write failure");
      data.setItem(key, value);
      if (mode === "write-after-unknown" && writes === 1) { blocked = true; throw new Error("isolated failure after write"); }
    }, removeItem: (key) => data.removeItem(key),
  };
  const withStorageLock = async (operation) => {
    const first = locks++ === 0;
    if (first && mode.startsWith("before")) { if (mode.endsWith("unknown")) blocked = true; throw unavailable(); }
    inside = true;
    try {
      const result = operation();
      if (first && mode.startsWith("after")) { if (mode.endsWith("unknown")) blocked = true; throw unavailable(); }
      return result;
    } finally { inside = false; }
  };
  const controller = createKitchenOrderAttempts({ storage, withStorageLock, idFactory: () => uuid(++ids), now: () => 1000,
    sendAddition: async (request) => {
      calls.push(structuredClone(request));
      if (mode === "hold") await new Promise((resolve) => { release = resolve; });
      if (mode === "rejected") throw Object.assign(new Error("isolated rejection"), { status: 401, code: "UNAUTHORIZED" });
      return { orderId: uuid(100) };
    },
  });
  const options = { onPrepared: (attempt) => observations.push({ attempt, inside, beforeStorage: data.getItem(KITCHEN_ORDER_ATTEMPT_PREFIX + attempt.id) === null, beforeHttp: calls.length === 0 }), onFailure: (result) => failures.push(result) };
  return { controller, storage, data, calls, observations, failures, options, unblock: () => { blocked = false; }, release: () => release(), get ids() { return ids; } };
}

test("preparation binds canonical ID before storage and preserves it after post-write abort", async () => {
  const f = preparationFixture("after");
  await assert.rejects(f.controller.submitAddition(addition, f.options));
  assert.equal(f.calls.length, 0); assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].inside, true); assert.equal(f.observations[0].beforeStorage, true); assert.equal(f.observations[0].beforeHttp, true);
  const saved = f.controller.getState().pending[0], recovery = f.failures[0];
  assert.equal(recovery.state, "present"); assert.equal(recovery.canRelease, false); assert.equal(recovery.attempt.id, saved.id); assert.deepEqual(recovery.request, addition);
  f.observations[0].attempt.request.items[0].quantity = 9;
  assert.equal(f.controller.getState().pending[0].request.items[0].quantity, 1);
  await f.controller.retry(saved.id); assert.equal(f.calls[0].clientOrderId, saved.id); assert.deepEqual(f.calls[0].items, addition.items); assert.equal(f.ids, 1);
});

test("preparation keeps identity when post-write abort also makes storage unreadable", async () => {
  const f = preparationFixture("after-unknown"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  const recovery = f.failures[0]; assert.equal(recovery.state, "unknown"); assert.equal(recovery.canRelease, false); assert.equal(f.calls.length, 0);
  assert.equal(recovery.inspect().canRelease, false); f.unblock(); const restored = recovery.inspect();
  assert.equal(restored.state, "present"); assert.equal(restored.attempt.id, recovery.attempt.id); await f.controller.retry(restored.attempt.id); assert.equal(f.ids, 1);
});

test("preparation releases only confirmed empty pre-prepare failures for normal retry", async () => {
  const f = preparationFixture("before"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  assert.equal(f.ids, 0); assert.equal(f.calls.length, 0); assert.equal(f.failures[0].state, "absent"); assert.equal(f.failures[0].canRelease, true);
  await f.controller.submitAddition(addition); assert.equal(f.calls.length, 1); assert.equal(f.ids, 1);
});

test("preparation keeps unassigned intent when storage is unknown and releases after readable absence", async () => {
  const f = preparationFixture("before-unknown"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  const recovery = f.failures[0]; assert.equal(recovery.attempt, null); assert.equal(recovery.state, "unknown"); assert.equal(recovery.canRelease, false); assert.deepEqual(recovery.request, addition);
  f.unblock(); assert.equal(recovery.inspect().canRelease, true); assert.equal(f.calls.length, 0); await f.controller.submitAddition(addition); assert.equal(f.calls.length, 1);
});

test("preparation proves absent failed write while locked and permits a fresh unsent attempt", async () => {
  const f = preparationFixture("write-before"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  assert.equal(f.observations.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.failures[0].state, "absent"); assert.equal(f.failures[0].canRelease, true);
  const oldId = f.observations[0].attempt.id; await f.controller.submitAddition(addition); assert.notEqual(f.calls[0].clientOrderId, oldId);
});

test("preparation keeps partial writes on generic storage errors until same-ID recovery", async () => {
  const f = preparationFixture("write-after-unknown"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  const recovery = f.failures[0]; assert.equal(recovery.canRelease, false); assert.equal(recovery.state, "unknown"); assert.equal(f.calls.length, 0);
  f.unblock(); const ready = recovery.inspect(); assert.equal(ready.state, "present"); assert.equal(ready.attempt.id, f.observations[0].attempt.id); await f.controller.retry(ready.attempt.id); assert.equal(f.ids, 1);
});

test("preparation does not infer unsent status from later disappearance of a published intent", async () => {
  const f = preparationFixture("after"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  const recovery = f.failures[0]; f.data.removeItem(KITCHEN_ORDER_ATTEMPT_PREFIX + recovery.attempt.id);
  const missing = recovery.inspect(); assert.equal(missing.state, "absent"); assert.equal(missing.canRelease, false); assert.equal(missing.attempt.id, recovery.attempt.id);
});

test("preparation can release a definitive rejection only after matching cleanup", async () => {
  const f = preparationFixture("rejected"); await assert.rejects(f.controller.submitAddition(addition, f.options));
  assert.equal(f.calls.length, 1); assert.equal(f.failures[0].state, "absent"); assert.equal(f.failures[0].canRelease, true);
});

test("preparation observers joining the same flight receive its identical canonical intent", async () => {
  const f = preparationFixture("hold"); const observed = [];
  const first = f.controller.submitAddition(addition, f.options);
  const second = f.controller.submitAddition(addition, { onPrepared: (attempt) => observed.push(attempt) });
  await tick(); const third = f.controller.submitAddition(addition, { onPrepared: (attempt) => observed.push(attempt) });
  assert.equal(f.calls.length, 1); assert.equal(observed.length, 2); assert.deepEqual(observed[0], observed[1]); assert.equal(observed[0].id, f.calls[0].clientOrderId);
  f.release(); await Promise.all([first, second, third]);
});

test("preparation App handler wires source identity and failure proof without waiting for HTTP", async () => {
  const f = preparationFixture("after"); let prepared; let recovery;
  const add = handler("submitKitchenAddition", "toggleServed", { apiMode: true, kitchenOrderAttempts: f.controller, kitchenAdditionRequestItem, window: { dispatchEvent: noop }, CustomEvent: class {} });
  await assert.rejects(add({ tableId: 1, sessionId: uuid(10), item: addition.items[0], onPrepared: (id, request) => { prepared = { id, request }; }, onFailure: (result) => { recovery = result; } }));
  assert.equal(f.calls.length, 0); assert.equal(prepared.id, recovery.attempt.id); assert.deepEqual(prepared.request, addition); assert.equal(recovery.canRelease, false);
});

test("preparation modal keeps ownership by storage proof rather than the error code", async () => {
  for (const canRelease of [false, true]) {
    const submissionRef = { current: null }; let error = "";
    const attempt = { id: uuid(1), kind: "addition", request: addition };
    const submit = modalHandler("submit", "return <Modal", {
      submitLock: { current: false }, locked: false, quantity: "1", kind: "menu", menuItems: [{ id: "fictional-item", name: "架空品", price: 300 }], menuItemId: "fictional-item", target: { tableId: 1, sessionId: uuid(10) }, kitchenAdditionRequestItem,
      setError: (value) => { error = value; }, draftRevision: { current: 2 }, submissionRef, mountedRef: { current: true }, pendingRef: { current: attempt }, confirmedIdRef: { current: null }, onConfirmed: () => { throw new Error("failed preparation must not close"); },
      onSubmit: async (item, prepared, failed) => { prepared(attempt.id, attempt.request); failed({ attempt, state: canRelease ? "absent" : "present", canRelease }); throw Object.assign(new Error("isolated preparation error"), { code: "KITCHEN_ORDER_LOCK_UNAVAILABLE" }); },
    });
    await submit({ preventDefault: noop }); assert.equal(error, "isolated preparation error"); assert.equal(submissionRef.current === null, canRelease);
    if (!canRelease) { assert.equal(submissionRef.current.id, attempt.id); assert.deepEqual(submissionRef.current.attempt.request, addition); assert.equal(submissionRef.current.revision, 2); }
  }
});

test("preparation unassigned unknown input is not mistaken for a null acknowledgement", () => {
  const modal = source.slice(source.indexOf("function KitchenAdditionModal"), source.indexOf("function cancelledQuantityForDisplay"));
  const line = modal.split(/\r?\n/).find((value) => value.startsWith("  const pending ="));
  const pending = new Function("sharedPending", "ownAttempt", "confirmedIdRef", line + "; return pending;");
  const unassigned = { id: null, kind: "addition", request: addition };
  assert.equal(pending(null, unassigned, { current: null }), unassigned);
  const known = { ...unassigned, id: uuid(1) };
  assert.equal(pending(null, known, { current: known.id }), null);
  assert.equal(pending(null, known, { current: uuid(2) }), known);
});

function mixedResponses(kind) {
  const storage = memoryStorage();
  const withStorageLock = serialStorageLock();
  const calls = []; const saved = new Map();
  let ids = 0;
  const sender = (body) => new Promise((resolve, reject) => {
    calls.push({ body: structuredClone(body), resolve, reject });
  });
  const make = () => createKitchenOrderAttempts({ storage, withStorageLock, idFactory: () => uuid(++ids), now: () => 1000, sendAddition: sender, sendIncrease: sender });
  const method = kind === "addition" ? "submitAddition" : "submitIncrease";
  const request = kind === "addition" ? addition : increase;
  const key = kind === "addition" ? "clientOrderId" : "operationId";
  const markSaved = (index) => {
    const body = calls[index].body;
    if (saved.has(body[key])) assert.deepEqual(body, saved.get(body[key]));
    else saved.set(body[key], structuredClone(body));
  };
  return { storage, withStorageLock, make, calls, saved, request, method, key, markSaved };
}

for (const kind of ["addition", "increase"]) {
  for (const status of [401, 409]) test(`${kind}: late initial ${status} cannot clear a saved-but-unknown retry after reload`, async () => {
    const f = mixedResponses(kind);
    const original = f.make(); const first = original[f.method](f.request).catch((e) => e); await tick();
    const before = original.getState().pending[0]; assert.equal(before.generation, 1);
    const reopened = f.make(); const second = reopened.retry(before.id).catch((e) => e); await tick();
    const newer = reopened.getState().pending[0]; assert.equal(newer.generation, 2); assert.deepEqual(newer.request, before.request);
    f.markSaved(1);
    f.calls[0].reject(Object.assign(new Error("isolated initial rejection"), { status, code: status === 401 ? "AUTHENTICATION_FAILED" : "ORDER_CONFLICT" })); await first;
    assert.equal(reopened.getState().pending[0].generation, 2);
    f.calls[1].reject(new TypeError("isolated response loss after save")); await second;
    const afterReload = f.make(); const pending = afterReload.getState().pending[0];
    assert.equal(pending.id, before.id); assert.equal(pending.generation, 2); assert.deepEqual(pending.request, before.request);
    const replay = afterReload.retry(pending.id); await tick(); f.markSaved(2); f.calls[2].resolve({ orderId: uuid(100) }); await replay;
    assert.equal(f.saved.size, 1); assert.deepEqual(f.calls[1].body, f.calls[2].body);
    assert.equal(afterReload.getState().pending.length, 0);
  });

  test(`${kind}: late success cannot clear a later unknown generation`, async () => {
    const f = mixedResponses(kind); const original = f.make();
    const first = original[f.method](f.request); await tick(); const id = original.getState().pending[0].id;
    const reopened = f.make(); const second = reopened.retry(id).catch((e) => e); await tick();
    f.markSaved(0); f.markSaved(1); f.calls[0].resolve({ orderId: uuid(100) }); await first;
    assert.equal(reopened.getState().pending[0].generation, 2);
    f.calls[1].reject(new TypeError("isolated response loss")); await second;
    assert.equal(f.make().getState().pending[0].id, id); assert.equal(f.saved.size, 1);
  });

  test(`${kind}: a newer confirmed success is not resurrected by an older response`, async () => {
    const f = mixedResponses(kind); const old = f.make();
    const first = old[f.method](f.request).catch((e) => e); await tick(); const id = old.getState().pending[0].id;
    const current = f.make(); const second = current.retry(id); await tick();
    f.markSaved(1); f.calls[1].resolve({ orderId: uuid(100) }); await second;
    f.calls[0].reject(Object.assign(new Error("isolated late rejection"), { status: 409, code: "ORDER_CONFLICT" })); await first;
    assert.equal(f.make().getState().pending.length, 0); assert.equal(f.saved.size, 1);
    const next = current[f.method](f.request); await tick(); f.markSaved(2); f.calls[2].resolve({ orderId: uuid(101) }); await next;
    assert.equal(f.saved.size, 2); assert.notEqual(f.calls[1].body[f.key], f.calls[2].body[f.key]);
  });
}

test("shared critical sections serialize concurrent generations and protect comparison/removal", async () => {
  const f = mixedResponses("addition"); const a = f.make(); const first = a.submitAddition(addition).catch((e) => e); await tick();
  const id = a.getState().pending[0].id;
  let release; const barrier = f.withStorageLock(() => new Promise((resolve) => { release = resolve; })); await tick();
  const b = f.make(); const second = b.retry(id).catch((e) => e);
  const c = f.make(); const third = c.retry(id).catch((e) => e);
  f.calls[0].reject(Object.assign(new Error("isolated rejection"), { status: 401, code: "AUTHENTICATION_FAILED" }));
  await tick(); assert.equal(f.calls.length, 1); release(); await barrier; await tick();
  assert.equal(b.getState().pending[0].generation, 3); await first;
  f.markSaved(1); f.markSaved(2); f.calls[1].reject(new TypeError("isolated lost response")); f.calls[2].reject(new TypeError("isolated lost response")); await Promise.all([second, third]);
  assert.equal(f.make().getState().pending[0].generation, 3); assert.equal(f.saved.size, 1);
});

test("a retry queued behind acknowledged removal cannot resurrect the old record", async () => {
  const f = mixedResponses("addition"); const a = f.make(); const first = a.submitAddition(addition); await tick(); const id = a.getState().pending[0].id;
  let release; const barrier = f.withStorageLock(() => new Promise((resolve) => { release = resolve; })); await tick();
  f.markSaved(0); f.calls[0].resolve({ orderId: uuid(100) }); await tick();
  const retry = f.make().retry(id).catch((e) => e); await tick(); release(); await barrier; await first;
  assert.equal((await retry).code, "KITCHEN_ORDER_PENDING_CHANGED"); assert.equal(f.calls.length, 1); assert.equal(f.make().getState().pending.length, 0);
});

test("legacy records retain their ID and contents and receive a generation under the lock", async () => {
  const storage = memoryStorage(); const id = uuid(90);
  storage.setItem(KITCHEN_ORDER_ATTEMPT_PREFIX + id, JSON.stringify({ version: 1, id, kind: "addition", request: addition, createdAtMs: 1000 }));
  const f = fixture({ storage, pause: true }); const retry = f.controller.retry(id); await tick();
  assert.equal(f.controller.getState().pending[0].generation, 1); assert.equal(f.calls[0].body.clientOrderId, id);
  f.releases.forEach((resolve) => resolve()); await retry; assert.equal(f.saved.size, 1);
});

test("native lock unavailability fails before writing or sending, and invalid retry IDs never create an intent", async () => {
  const storage = memoryStorage(); let sent = 0;
  const controller = createKitchenOrderAttempts({ storage, idFactory: () => uuid(1), sendAddition: () => { sent++; }, withStorageLock: createKitchenOrderStorageLock({ indexedDB: null }) });
  await assert.rejects(() => controller.submitAddition(addition), (e) => e.code === "KITCHEN_ORDER_LOCK_UNAVAILABLE");
  await assert.rejects(() => controller.retry(undefined), (e) => e.code === "KITCHEN_ORDER_PENDING_CHANGED");
  assert.equal(sent, 0); assert.equal(controller.getState().pending.length, 0);
});
