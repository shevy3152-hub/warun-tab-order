import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTBOX_DB_NAME,
  OUTBOX_DB_VERSION,
  OUTBOX_STATES,
  createApiOrderTransport,
  createCustomerOrderClient,
  createMemoryOutbox,
  createOrderOutbox,
  createOrderPayload,
  fetchCustomerCheckout,
  fetchCustomerTheme,
  fetchCustomerThemeConfig,
  requestCustomerCheckout,
  fetchCustomerOrderHistory,
  fetchCustomerOrderStartNotice,
  postCustomerStaffCall,
  resolveOrderApiConfig,
  retryDelayForAttempt,
  subscribeCustomerInvalidations,
} from "../src/order-outbox.js";
import { customerOrderErrorCategory, customerOrderNoticeFromOutboxEvent } from "../src/customer-order-notice.js";

const ITEM_ID = "edamame";

function uuid(value = 1) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

test("staff call client posts only the idempotency key and visit context, and does not report failed sends as success", async () => {
  const calls = [];
  const clientCallId = uuid(77);
  const visitContextId = `v1_${"a".repeat(64)}`;
  const config = { enabled: true, baseUrl: "http://localhost:8787/v1", token: "test-token" };
  const response = {
    status: 201,
    headers: { get: (name) => name === "Idempotency-Result" ? "created" : null },
    async json() { return { clientCallId, callType: "staff", status: "open", idempotencyResult: "created" }; },
  };
  const result = await postCustomerStaffCall({
    config, clientCallId, visitContextId, env: { navigator: { onLine: true } },
    fetchImpl: async (...args) => { calls.push(args); return response; },
  });
  assert.equal(result.idempotencyResult, "created");
  assert.equal(calls[0][0], "http://localhost:8787/v1/staff-calls");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0][1].body), { clientCallId, visitContextId });
  await assert.rejects(() => postCustomerStaffCall({
    config, clientCallId, visitContextId, env: { navigator: { onLine: true } },
    fetchImpl: async () => ({ status: 503, headers: { get: () => null }, async json() { return { error: { code: "SERVICE_UNAVAILABLE" } }; } }),
  }), /呼出を保存できませんでした/);
});

function successfulTransport(result = "created", calls = []) {
  return {
    enabled: true,
    canAttempt: () => true,
    async send(payload) {
      calls.push(payload);
      return { kind: "success", idempotencyResult: result };
    },
  };
}

function pendingTransport(errorCode = "NETWORK_ERROR", calls = []) {
  return {
    enabled: true,
    canAttempt: () => true,
    async send(payload) {
      calls.push(payload);
      return { kind: "retry", errorCode };
    },
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

test("outbox constants keep the browser database contract fixed", () => {
  assert.equal(OUTBOX_DB_NAME, "warun-customer-order-outbox");
  assert.equal(OUTBOX_DB_VERSION, 1);
  assert.deepEqual(Object.values(OUTBOX_STATES).sort(), ["pending", "rejected", "review_required", "sending", "synced"]);
});

test("clientOrderId is generated once and the record is saved before sending", async () => {
  const calls = [];
  let idCalls = 0;
  const store = createMemoryOutbox();
  const transport = successfulTransport("created", calls);
  const service = createOrderOutbox({
    store,
    transport: {
      ...transport,
      async send(payload) {
        calls.push({ type: "send", payload });
        return transport.send(payload);
      },
    },
    idFactory: () => { idCalls += 1; return uuid(1); },
    autoRetry: false,
  });

  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal(idCalls, 1);
  assert.equal(calls.length, 0);
  assert.equal((await store.get(record.clientOrderId)).state, "pending");
  await service.flush({ clientOrderId: record.clientOrderId });
  assert.equal(calls[0].type, "send");
  assert.equal(calls[0].payload.clientOrderId, record.clientOrderId);
});

for (const idempotencyResult of ["created", "replayed"]) {
  test(`${idempotencyResult} marks the outbox record synced`, async () => {
    const service = createOrderOutbox({
      store: createMemoryOutbox(),
      transport: successfulTransport(idempotencyResult),
      idFactory: () => uuid(idempotencyResult === "created" ? 2 : 3),
      autoRetry: false,
    });
    const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 2 }] });
    const result = await service.flush({ clientOrderId: record.clientOrderId });
    assert.equal(result.state, "synced");
    assert.equal(result.idempotencyResult, idempotencyResult);
    assert.equal((await service.get(record.clientOrderId)).state, "synced");
  });
}

test("network errors and 5xx responses remain pending", async (t) => {
  for (const errorCode of ["NETWORK_ERROR", "HTTP_503"]) {
    await t.test(errorCode, async () => {
      const service = createOrderOutbox({
        store: createMemoryOutbox(),
        transport: pendingTransport(errorCode),
        idFactory: () => uuid(errorCode === "NETWORK_ERROR" ? 4 : 5),
        autoRetry: false,
      });
      const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
      const result = await service.flush({ clientOrderId: record.clientOrderId });
      const persisted = await service.get(record.clientOrderId);
      assert.equal(result.state, "pending");
      assert.equal(persisted.state, "pending");
      assert.equal(persisted.lastErrorCode, errorCode);
    });
  }
});

test("4xx business errors become rejected and are not scheduled for retry", async () => {
  const timers = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: {
      enabled: true,
      canAttempt: () => true,
      async send() { return { kind: "rejected", errorCode: "HTTP_422" }; },
    },
    idFactory: () => uuid(6),
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return {}; },
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const result = await service.flush({ clientOrderId: record.clientOrderId });
  assert.equal(result.state, "rejected");
  assert.equal((await service.get(record.clientOrderId)).lastErrorCode, "HTTP_422");
  assert.equal(timers.length, 0);
});

test("resending keeps the original clientOrderId and payload", async () => {
  const calls = [];
  let attempt = 0;
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: {
      enabled: true,
      canAttempt: () => true,
      async send(payload) {
        calls.push(payload);
        attempt += 1;
        return attempt === 1 ? { kind: "retry", errorCode: "NETWORK_ERROR" } : { kind: "success", idempotencyResult: "created" };
      },
    },
    idFactory: () => uuid(7),
    autoRetry: false,
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  await service.flush({ clientOrderId: record.clientOrderId });
  await service.flush({ clientOrderId: record.clientOrderId, force: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].clientOrderId, calls[1].clientOrderId);
  assert.deepEqual(calls[0].items, calls[1].items);
  assert.equal((await service.get(record.clientOrderId)).state, "synced");
});

test("a restarted service recovers an interrupted send without creating a new id", async () => {
  const calls = [];
  const store = createMemoryOutbox([{
    clientOrderId: uuid(8),
    payload: createOrderPayload({ clientOrderId: uuid(8), items: [{ menuItemId: ITEM_ID, quantity: 1 }] }),
    state: "sending",
    attemptCount: 1,
    createdAt: 1,
    lastAttemptAt: 2,
    lastErrorCode: null,
  }]);
  const service = createOrderOutbox({ store, transport: successfulTransport("replayed", calls), idFactory: () => { throw new Error("must not generate a replacement id"); }, autoRetry: false });
  await service.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientOrderId, uuid(8));
  assert.equal((await service.get(uuid(8))).state, "synced");
});

test("the same order is not sent twice during concurrent flush calls", async () => {
  let release;
  const calls = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: {
      enabled: true,
      canAttempt: () => true,
      send(payload) {
        calls.push(payload);
        return new Promise((resolve) => { release = () => resolve({ kind: "success", idempotencyResult: "created" }); });
      },
    },
    idFactory: () => uuid(9),
    autoRetry: false,
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const first = service.flush({ clientOrderId: record.clientOrderId });
  const second = service.flush({ clientOrderId: record.clientOrderId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal((await service.get(record.clientOrderId)).state, "synced");
});

test("two services sharing an outbox atomically claim the same order once", async () => {
  const store = createMemoryOutbox();
  let release;
  let calls = 0;
  const transport = {
    enabled: true,
    canAttempt: () => true,
    send() {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve({ kind: "success", idempotencyResult: "created" }); });
    },
  };
  const first = createOrderOutbox({ store, transport, idFactory: () => uuid(10), autoRetry: false });
  const second = createOrderOutbox({ store, transport, idFactory: () => uuid(11), autoRetry: false });
  const record = await first.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const firstFlush = first.flush({ clientOrderId: record.clientOrderId });
  const secondFlush = second.flush({ clientOrderId: record.clientOrderId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([firstFlush, secondFlush]);
  assert.equal((await store.get(record.clientOrderId)).state, "synced");
});

test("online recovery flushes pending orders", async () => {
  const target = eventTarget();
  let available = false;
  const calls = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: { ...successfulTransport("created", calls), canAttempt: () => available },
    idFactory: () => uuid(12),
    eventTarget: target,
    autoRetry: false,
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  await service.start();
  assert.equal(calls.length, 0);
  available = true;
  target.dispatch("online");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientOrderId, record.clientOrderId);
});

test("offline deferral schedules bounded retries even if no online event is delivered", async () => {
  const timers = [];
  const calls = [];
  let available = false;
  const store = createMemoryOutbox();
  const service = createOrderOutbox({
    store,
    transport: { ...successfulTransport("created", calls), canAttempt: () => available },
    idFactory: () => uuid(47),
    setTimeoutImpl(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl() {},
  });
  const visitContextId = `v1_${"a".repeat(64)}`;
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }], visitContextId });

  assert.equal((await service.flush({ clientOrderId: record.clientOrderId })).state, "pending");
  assert.equal((await store.get(record.clientOrderId)).attemptCount, 0);
  assert.equal(calls.length, 0);
  assert.equal(timers[0].delay, 1_000);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(timers[1].delay, 2_000);
  assert.equal((await store.get(record.clientOrderId)).payload.visitContextId, visitContextId);

  available = true;
  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const saved = await store.get(record.clientOrderId);
  assert.equal(saved.state, "synced");
  assert.equal(saved.attemptCount, 1);
  assert.equal(saved.payload.visitContextId, visitContextId);
  await service.stop();
});

test("outbox success events map to a customer sent notice after recovery", () => {
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(40), state: "synced", displayState: "synced" }), {
    kind: "success",
    message: "送信済みです。ご注文を承りました。",
  });
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(41), state: "synced", displayState: "synced", idempotencyResult: "replayed" }), {
    kind: "success",
    message: "送信済みです。ご注文を承りました。",
  });
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(42), state: "rejected", displayState: "business_error", lastErrorCode: "INVALID_ORDER_REQUEST" }), {
    kind: "error",
    message: "注文内容エラーのため送信できませんでした。内容を確認してください。",
  });
  assert.equal(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(43), state: "pending", displayState: "failed" }).kind, "failed");
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(44), state: "review_required", displayState: "review_required" }), {
    kind: "error",
    message: "来店または端末の割当が変わりました。注文内容を保持しています。スタッフへ確認してください。",
  });
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(45), state: "review_required", displayState: "review_required", lastErrorCode: "HTTP_401" }), {
    kind: "error",
    message: "端末の接続を確認できません。注文内容を保持しています。スタッフへ確認してください。",
  });
});

test("stale outbox submissions are retained in a non-retrying staff-review state", async () => {
  const calls = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: { ...successfulTransport("created", calls), async send(payload) { calls.push(payload); return { kind: "rejected", errorCode: "VISIT_CONTEXT_STALE" }; } },
    idFactory: () => uuid(44),
    autoRetry: false,
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }], visitContextId: `v1_${"a".repeat(64)}` });
  const result = await service.flush({ clientOrderId: record.clientOrderId });
  const saved = await service.get(record.clientOrderId);
  assert.equal(result.state, "review_required");
  assert.equal(saved.state, "review_required");
  assert.equal(saved.payload.items[0].menuItemId, ITEM_ID);
  assert.equal((await service.flush({ clientOrderId: record.clientOrderId })).state, "review_required");
  assert.equal(calls.length, 1);
});

test("a 401 order response holds the existing payload for review instead of rejecting or retrying it", async () => {
  const visitContextId = `v1_${"f".repeat(64)}`;
  const calls = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: {
      enabled: true,
      canAttempt: () => true,
      async send() { calls.push("send"); return { kind: "rejected", errorCode: "HTTP_401" }; },
    },
    idFactory: () => uuid(56),
    autoRetry: false,
  });
  const record = await service.enqueue({ visitContextId, items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const result = await service.flush({ clientOrderId: record.clientOrderId });
  const retained = await service.get(record.clientOrderId);

  assert.equal(result.state, "review_required");
  assert.equal(retained.state, "review_required");
  assert.equal(retained.lastErrorCode, "HTTP_401");
  assert.equal(retained.payload.visitContextId, visitContextId);
  assert.deepEqual(retained.payload.items, [{ menuItemId: ITEM_ID, quantity: 1 }]);
  assert.equal((await service.flush({ clientOrderId: record.clientOrderId, force: true })).state, "review_required");
  assert.deepEqual(calls, ["send"]);
});

test("an SSE authorization failure keeps an in-flight timeout from becoming retryable under new credentials", async () => {
  let sendStarted;
  let completeSend;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const sendResult = new Promise((resolve) => { completeSend = resolve; });
  const store = createMemoryOutbox();
  const service = createOrderOutbox({
    store,
    transport: {
      enabled: true,
      canAttempt: () => true,
      async send() { sendStarted(); return sendResult; },
    },
    idFactory: () => uuid(59),
    autoRetry: false,
  });
  const record = await service.enqueue({ visitContextId: `v1_${"a".repeat(64)}`, items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const flush = service.flush({ clientOrderId: record.clientOrderId });
  await started;
  await service.holdPendingForReview("HTTP_401");
  completeSend({ kind: "retry", errorCode: "NETWORK_ERROR" });
  await flush;

  const retained = await service.get(record.clientOrderId);
  assert.equal(retained.state, "review_required");
  assert.equal(retained.lastErrorCode, "HTTP_401");
  assert.equal(retained.payload.items[0].menuItemId, ITEM_ID);
  assert.equal((await service.flush({ clientOrderId: record.clientOrderId, force: true })).state, "review_required");
});

test("connectivity confirmation does not bypass stale visit-context rejection", async () => {
  const calls = [];
  const visitContextId = `v1_${"d".repeat(64)}`;
  const store = createMemoryOutbox();
  const service = createOrderOutbox({
    store,
    transport: {
      enabled: true,
      canAttempt: () => false,
      async checkVisitContext(_expectedContext, options) {
        assert.equal(options.connectivityRestored, true);
        return { status: "stale" };
      },
      async send(payload) { calls.push(payload); return { kind: "success", idempotencyResult: "created" }; },
    },
    idFactory: () => uuid(50),
    autoRetry: false,
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }], visitContextId });

  const result = await service.flush({ clientOrderId: record.clientOrderId, force: true, connectivityRestored: true });
  const saved = await store.get(record.clientOrderId);
  assert.equal(result.state, "review_required");
  assert.equal(saved.state, "review_required");
  assert.equal(saved.lastErrorCode, "VISIT_CONTEXT_STALE");
  assert.equal(saved.attemptCount, 0);
  assert.equal(saved.payload.visitContextId, visitContextId);
  assert.equal(calls.length, 0);
  await service.stop();
});

test("legacy outbox payloads remain contextless until the server either replays or requires staff review", async () => {
  const legacyPayload = { schemaVersion: 1, clientOrderId: uuid(46), items: [{ menuItemId: ITEM_ID, quantity: 1 }] };
  const calls = [];
  const store = createMemoryOutbox([{
    clientOrderId: legacyPayload.clientOrderId,
    payload: legacyPayload,
    state: "pending",
    attemptCount: 0,
    createdAt: 1,
    lastAttemptAt: null,
    lastErrorCode: null,
  }]);
  const service = createOrderOutbox({
    store,
    transport: { ...successfulTransport("replayed", calls), async send(payload) { calls.push(payload); return { kind: "rejected", errorCode: "VISIT_CONTEXT_STALE" }; } },
    autoRetry: false,
  });
  await service.flush({ clientOrderId: legacyPayload.clientOrderId });
  const saved = await service.get(legacyPayload.clientOrderId);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], "visitContextId"), false);
  assert.equal(Object.hasOwn(saved.payload, "visitContextId"), false);
  assert.equal(saved.state, "review_required");
});

test("customer order errors are shown as safe categories without exposing server details", () => {
  assert.equal(customerOrderErrorCategory("AUTHENTICATION_FAILED").label, "認証切れ");
  assert.equal(customerOrderErrorCategory("HTTP_409").label, "送信競合");
  assert.equal(customerOrderErrorCategory("MENU_ITEM_SOLD_OUT").label, "注文内容エラー");
  assert.equal(customerOrderErrorCategory("INTERNAL_ERROR").label, "サーバーエラー");
  assert.equal(customerOrderErrorCategory("secret-token-or-stack-trace").label, "注文受付エラー");
});

test("API rejection preserves the server public error code without preserving response details", async () => {
  const env = { navigator: { onLine: true } };
  const transport = createApiOrderTransport({
    config: { enabled: true, baseUrl: "http://safe-copy.test/v1", token: "runtime-secret-token" },
    env,
    fetchImpl: async () => ({
      status: 422,
      headers: { get: () => null },
      async json() {
        return { error: { code: "MENU_ITEM_SOLD_OUT", message: "A requested menu item is sold out." }, requestId: uuid(44) };
      },
    }),
  });
  const result = await transport.send(createOrderPayload({ clientOrderId: uuid(45), items: [{ menuItemId: ITEM_ID, quantity: 1 }] }));
  assert.deepEqual(result, { kind: "rejected", errorCode: "MENU_ITEM_SOLD_OUT" });
  assert.equal(JSON.stringify(result).includes("runtime-secret-token"), false);
});

test("retry delays use bounded exponential backoff instead of a tight loop", async () => {
  assert.equal(retryDelayForAttempt(1), 1_000);
  assert.equal(retryDelayForAttempt(2), 2_000);
  assert.equal(retryDelayForAttempt(7), 60_000);
  const timers = [];
  const service = createOrderOutbox({
    store: createMemoryOutbox(),
    transport: pendingTransport("HTTP_503"),
    idFactory: () => uuid(13),
    setTimeoutImpl: (callback, delay) => { timers.push({ callback, delay }); return {}; },
  });
  const record = await service.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  await service.flush({ clientOrderId: record.clientOrderId });
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 1_000);
});

test("API transport sends only the contract payload and never exposes the token", async () => {
  const token = "runtime-secret-token";
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: token,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const config = resolveOrderApiConfig(env);
  let request;
  const transport = createApiOrderTransport({
    config,
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { status: 201, headers: { get: () => "created" } };
    },
  });
  const payload = createOrderPayload({ clientOrderId: uuid(14), items: [{ menuItemId: ITEM_ID, quantity: 2, price: 999, total: 1998, tableId: "3" }] });
  const result = await transport.send(payload);
  const body = JSON.parse(request.options.body);
  assert.equal(result.kind, "success");
  assert.equal(request.url, "https://api.example.test/v1/orders");
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(Object.keys(body).sort(), ["clientOrderId", "items", "schemaVersion"]);
  assert.deepEqual(body.items, [{ menuItemId: ITEM_ID, quantity: 2 }]);
  assert.equal(request.url.includes(token), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("network errors do not include runtime tokens in the result", async () => {
  const token = "runtime-secret-token";
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: token,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const transport = createApiOrderTransport({ config: resolveOrderApiConfig(env), env, fetchImpl: async () => { throw new Error(token); } });
  const result = await transport.send(createOrderPayload({ clientOrderId: uuid(15), items: [{ menuItemId: ITEM_ID, quantity: 1 }] }));
  assert.equal(result.errorCode, "NETWORK_ERROR");
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("customer history uses the browser customer token without putting it in the URL or result", async () => {
  const token = "runtime-customer-secret";
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: token,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  let request;
  const orders = [{ orderId: uuid(20), clientOrderId: uuid(21), status: "completed", items: [] }];
  const result = await fetchCustomerOrderHistory({
    config: resolveOrderApiConfig(env),
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { status: 200, json: async () => ({ orders }) };
    },
  });

  assert.equal(request.url, "https://api.example.test/v1/customer/order-history");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(result, orders);
  assert.equal(request.url.includes(token), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("API customer client exposes authenticated history through its existing runtime credentials", async () => {
  const token = "runtime-customer-secret";
  const global = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: token,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  let authorization;
  const client = createCustomerOrderClient({
    global,
    store: createMemoryOutbox(),
    autoRetry: false,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return { status: 200, json: async () => ({ orders: [] }) };
    },
  });

  assert.deepEqual(await client.getHistory(), []);
  assert.equal(authorization, `Bearer ${token}`);
});

test("customer theme API returns only the supported public identifier with the customer token", async () => {
  let captured;
  const result = await fetchCustomerTheme({
    config: { enabled: true, baseUrl: "https://api.example.test/v1", token: "customer-runtime-secret" },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { status: 200, json: async () => ({ theme: "camellia", version: 4, updatedAtMs: 1234 }) };
    },
  });
  assert.equal(captured.url, "https://api.example.test/v1/customer/theme");
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.headers.Authorization, "Bearer customer-runtime-secret");
  assert.deepEqual(result, { theme: "camellia" });
});

test("customer theme config API returns only safe placement values", async () => {
  let captured;
  const result = await fetchCustomerThemeConfig({
    config: { enabled: true, baseUrl: "https://api.example.test/v1", token: "customer-runtime-secret" },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { status: 200, json: async () => ({ theme: "camellia", positionX: 0.2, positionY: 0.8, zoom: 0.5, prompt: "secret", notes: "secret" }) };
    },
  });
  assert.equal(captured.url, "https://api.example.test/v1/customer/theme-config");
  assert.equal(captured.options.headers.Authorization, "Bearer customer-runtime-secret");
  assert.deepEqual(result, { theme: "camellia", positionX: 0.2, positionY: 0.8, zoom: 0.5 });
  assert.equal(Object.hasOwn(result, "prompt"), false);
  assert.equal(Object.hasOwn(result, "notes"), false);
});

test("customer notice API returns shared plain text with preserved line breaks", async () => {
  let captured;
  const result = await fetchCustomerOrderStartNotice({
    config: { enabled: true, baseUrl: "https://api.example.test/v1", token: "customer-runtime-secret" },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { status: 200, json: async () => ({ heading: "利用前", body: "一行目\n二行目" }) };
    },
  });
  assert.equal(captured.url, "https://api.example.test/v1/customer/order-start-notice");
  assert.equal(captured.options.headers.Authorization, "Bearer customer-runtime-secret");
  assert.deepEqual(result, { heading: "利用前", body: "一行目\n二行目" });
});

test("customer theme API rejects unknown or malformed public responses", async () => {
  await assert.rejects(
    () => fetchCustomerTheme({
      config: { enabled: true, baseUrl: "https://api.example.test/v1", token: "customer-runtime-secret" },
      fetchImpl: async () => ({ status: 200, json: async () => ({ theme: "autumn" }) }),
    }),
    /Customer theme response is invalid/,
  );
});

test("customer invalidation subscription refreshes on safe SSE events and preserves the cursor", async () => {
  const token = "runtime-customer-secret";
  const eventEpoch = uuid(31);
  const event = {
    audience: "customer",
    eventEpoch,
    eventId: 7,
    type: "table.assignment_updated",
    aggregateId: "device-config",
    occurredAtMs: 1786786940836,
    payload: { resource: "deviceConfig", refreshRequired: true },
  };
  const timers = [];
  const requests = [];
  const received = [];
  const reconnectReasons = [];
  const encoded = new TextEncoder().encode(`id: 7\ndata: ${JSON.stringify(event)}\n\n`);
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: token,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  };
  const unsubscribe = subscribeCustomerInvalidations({
    config: resolveOrderApiConfig(env),
    env,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return name === "X-Event-Epoch" ? eventEpoch : null; } },
        body: {
          getReader() {
            let done = false;
            return { async read() { if (done) return { done: true }; done = true; return { done: false, value: encoded }; } };
          },
        },
      };
    },
    onEvent: (value) => received.push(value),
    onReconnect: (reason) => reconnectReasons.push(reason),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [event]);
  assert.equal(requests[0].url, "https://api.example.test/v1/events");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.headers["X-Event-Epoch"], undefined);
  assert.equal(requests[0].options.headers["Last-Event-ID"], undefined);
  assert.equal(timers.length, 1);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[1].options.headers["X-Event-Epoch"], eventEpoch);
  assert.equal(requests[1].options.headers["Last-Event-ID"], "7");
  assert.deepEqual(reconnectReasons, ["reconnect"]);
  unsubscribe();
});

test("customer invalidation subscription requests a refresh after an epoch reset", async () => {
  const eventEpoch = uuid(32);
  const timers = [];
  const requests = [];
  const reasons = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "epoch-reset-token",
    location: { origin: "https://tablet.example.test" },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  };
  const unsubscribe = subscribeCustomerInvalidations({
    config: resolveOrderApiConfig(env),
    env,
    fetchImpl: async (_url, options) => {
      requests.push(options);
      if (requests.length === 1) return { ok: true, status: 410, headers: { get: () => eventEpoch } };
      return { ok: true, status: 200, headers: { get: (name) => name === "X-Event-Epoch" ? eventEpoch : null }, body: null };
    },
    onEvent: () => {},
    onReconnect: (reason) => reasons.push(reason),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, ["epoch-reset"]);
  assert.equal(timers.length, 1);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers["X-Event-Epoch"], undefined);
  unsubscribe();
});

test("SSE 401 holds pending orders for review and stops retrying the revoked credential", async () => {
  const visitContextId = `v1_${"e".repeat(64)}`;
  const timers = [];
  const requests = [];
  const authFailures = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "revoked-sse-token",
    WARUN_VISIT_CONTEXT_ID: visitContextId,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(57),
    autoRetry: false,
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: false, status: 401 };
    },
  });
  const record = await client.enqueue({ visitContextId, items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const unsubscribe = client.subscribeInvalidations(() => {}, { onAuthorizationFailure: (code) => authFailures.push(code) });
  await new Promise((resolve) => setImmediate(resolve));

  const retained = await client.get(record.clientOrderId);
  assert.deepEqual(authFailures, ["HTTP_401"]);
  assert.deepEqual(requests, ["https://api.example.test/v1/events"]);
  assert.equal(timers.length, 0);
  assert.equal(retained.state, "review_required");
  assert.equal(retained.lastErrorCode, "HTTP_401");
  assert.equal(retained.payload.visitContextId, visitContextId);
  assert.deepEqual(retained.payload.items, [{ menuItemId: ITEM_ID, quantity: 1 }]);
  assert.equal((await client.flush({ clientOrderId: record.clientOrderId, force: true })).state, "review_required");
  assert.equal(requests.length, 1);
  unsubscribe();
  await client.stop();
});

test("SSE reconnect flushes a pending order after the online event was missed", async () => {
  const eventEpoch = uuid(34);
  const visitContextId = `v1_${"b".repeat(64)}`;
  const timers = [];
  const calls = [];
  const eventTargetApi = eventTarget();
  let eventRequests = 0;
  let contextRequests = 0;
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "reconnect-test-token",
    WARUN_VISIT_CONTEXT_ID: visitContextId,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: false },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout() {},
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    eventTarget: eventTargetApi,
    idFactory: () => uuid(48),
    autoRetry: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/events")) {
        eventRequests += 1;
        return {
          ok: true,
          status: 200,
          headers: { get(name) { return name === "X-Event-Epoch" ? eventEpoch : null; } },
          body: { getReader() { return { async read() { return { done: true }; } }; } },
        };
      }
      if (url.endsWith("/device/config")) {
        contextRequests += 1;
        return { ok: true, status: 200, async json() { return { role: "customer", visitContextId }; } };
      }
      if (url.endsWith("/orders")) {
        return { status: 201, headers: { get(name) { return name === "Idempotency-Result" ? "created" : null; } } };
      }
      throw new Error("Unexpected request.");
    },
  });

  await client.start();
  const reconnectReasons = [];
  const unsubscribe = client.subscribeInvalidations(() => {}, { onReconnect: (reason) => reconnectReasons.push(reason) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventRequests, 1);

  const record = await client.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }], visitContextId });
  assert.equal((await client.flush({ clientOrderId: record.clientOrderId })).state, "pending");
  assert.equal(calls.some(({ url }) => url.endsWith("/orders")), false);
  assert.equal(timers[0].delay, 3_000);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(eventRequests, 2);
  assert.deepEqual(reconnectReasons, ["reconnect"]);
  assert.equal(contextRequests, 1);
  const orderRequest = calls.find(({ url }) => url.endsWith("/orders"));
  assert.ok(orderRequest);
  assert.equal(JSON.parse(orderRequest.options.body).visitContextId, visitContextId);
  assert.equal((await client.get(record.clientOrderId)).state, "synced");
  unsubscribe();
  await client.stop();
});

test("customer invalidation subscribers share one SSE connection and close it after the last unsubscribe", async () => {
  const eventEpoch = uuid(63);
  let eventRequests = 0;
  let streamSignal;
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "shared-sse-test-token",
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    autoRetry: false,
    fetchImpl: async (url, options = {}) => {
      assert.equal(url, "https://api.example.test/v1/events");
      eventRequests += 1;
      streamSignal = options.signal;
      let sent = false;
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return name === "X-Event-Epoch" ? eventEpoch : null; } },
        body: { getReader() { return { async read() {
          if (!sent) {
            sent = true;
            const frame = `data: {"eventEpoch":"${eventEpoch}","eventId":1,"resource":"menu"}\n\n`;
            return { done: false, value: new TextEncoder().encode(frame) };
          }
          if (streamSignal.aborted) return { done: true };
          return new Promise((resolve) => streamSignal.addEventListener("abort", () => resolve({ done: true }), { once: true }));
        } }; } },
      };
    },
  });
  const eventsA = [];
  const eventsB = [];
  const unsubscribeA = client.subscribeInvalidations((event) => eventsA.push(event));
  const unsubscribeB = client.subscribeInvalidations((event) => eventsB.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventRequests, 1);
  assert.equal(eventsA.length, 1);
  assert.equal(eventsB.length, 1);

  unsubscribeA();
  assert.equal(streamSignal.aborted, false);
  unsubscribeB();
  assert.equal(streamSignal.aborted, true);
});

test("API mode without runtime configuration is safe and does not use demo transport", async () => {
  const client = createCustomerOrderClient({
    global: { WARUN_ORDER_MODE: "api", location: { origin: "https://tablet.example.test" }, navigator: { onLine: true } },
    store: createMemoryOutbox(),
    idFactory: () => uuid(16),
    autoRetry: false,
  });
  assert.equal(client.mode, "api");
  assert.equal(client.configured, false);
  const record = await client.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  const result = await client.flush({ clientOrderId: record.clientOrderId });
  assert.equal(record.state, "review_required");
  assert.equal(result.state, "review_required");
});

test("device config refresh updates the cached visit context for live assignment changes", async () => {
  const originalContext = "v1_" + "a".repeat(64);
  const refreshedContext = "v1_" + "b".repeat(64);
  const calls = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "customer-token",
    WARUN_VISIT_CONTEXT_ID: originalContext,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    autoRetry: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { role: "customer", tableId: 2, tableLabel: "テーブル2", visitContextId: refreshedContext };
        },
      };
    },
  });

  const deviceConfig = await client.getDeviceConfig();
  assert.deepEqual(deviceConfig, {
    role: "customer",
    tableId: 2,
    tableLabel: "テーブル2",
    visitContextId: refreshedContext,
  });
  assert.equal(calls[0].url, "https://api.example.test/v1/device/config");
  assert.equal(calls[0].options.headers.Authorization, "Bearer customer-token");
  assert.equal((await client.checkVisitContext(originalContext)).status, "stale");
});

test("a temporary pre-send visit-context lookup failure retries without changing the pinned context", async () => {
  const visitContextId = `v1_${"c".repeat(64)}`;
  const timers = [];
  const calls = [];
  let contextRequests = 0;
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "context-retry-test-token",
    WARUN_VISIT_CONTEXT_ID: visitContextId,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(49),
    setTimeoutImpl(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl() {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/device/config")) {
        contextRequests += 1;
        if (contextRequests === 1) return { ok: false, status: 503 };
        return { ok: true, status: 200, async json() { return { role: "customer", visitContextId }; } };
      }
      if (url.endsWith("/orders")) {
        return { status: 201, headers: { get(name) { return name === "Idempotency-Result" ? "created" : null; } } };
      }
      throw new Error("Unexpected request.");
    },
  });
  const record = await client.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }], visitContextId });

  assert.equal((await client.flush({ clientOrderId: record.clientOrderId })).state, "pending");
  assert.equal(calls.some(({ url }) => url.endsWith("/orders")), false);
  const waiting = await client.get(record.clientOrderId);
  assert.equal(waiting.state, "pending");
  assert.equal(waiting.attemptCount, 0);
  assert.equal(waiting.payload.visitContextId, visitContextId);
  assert.equal(timers[0].delay, 1_000);

  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const orderRequest = calls.find(({ url }) => url.endsWith("/orders"));
  assert.equal(contextRequests, 2);
  assert.ok(orderRequest);
  assert.equal(JSON.parse(orderRequest.options.body).visitContextId, visitContextId);
  const synced = await client.get(record.clientOrderId);
  assert.equal(synced.state, "synced");
  assert.equal(synced.payload.visitContextId, visitContextId);
  await client.stop();
});

test("cart-pinned visit context is preserved and a never-attempted stale order is held for review", async () => {
  const pinned = `v1_${"a".repeat(64)}`;
  const current = `v1_${"b".repeat(64)}`;
  const calls = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "customer-token",
    WARUN_VISIT_CONTEXT_ID: pinned,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const response = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (name) => headers[name] ?? null }, async json() { return body; } });
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(28),
    autoRetry: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/device/config")) return response({ role: "customer", visitContextId: current });
      return response({}, { "Idempotency-Result": "created" });
    },
  });
  const record = await client.enqueue({ visitContextId: pinned, items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal(record.payload.visitContextId, pinned);
  const result = await client.flush({ clientOrderId: record.clientOrderId, force: true });
  assert.equal(result.state, "review_required");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/device/config");
  const retained = await client.get(record.clientOrderId);
  assert.equal(retained.payload.visitContextId, pinned);
  assert.equal(retained.payload.items[0].menuItemId, ITEM_ID);
});

test("an unauthorized visit-context lookup holds the existing outbox payload for review", async () => {
  const visitContextId = `v1_${"d".repeat(64)}`;
  const calls = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "revoked-context-token",
    WARUN_VISIT_CONTEXT_ID: visitContextId,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(58),
    autoRetry: false,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: false, status: 401 };
    },
  });
  const record = await client.enqueue({ visitContextId, items: [{ menuItemId: ITEM_ID, quantity: 2 }] });

  const result = await client.flush({ clientOrderId: record.clientOrderId, force: true });
  const retained = await client.get(record.clientOrderId);
  assert.equal(result.state, "review_required");
  assert.equal(result.errorCode, "HTTP_401");
  assert.deepEqual(calls, ["https://api.example.test/v1/device/config"]);
  assert.equal(retained.payload.visitContextId, visitContextId);
  assert.deepEqual(retained.payload.items, [{ menuItemId: ITEM_ID, quantity: 2 }]);
  assert.equal((await client.getDeviceConfig()).status, "unauthorized");
  await client.stop();
});

test("offline queued order keeps its captured visit context through same-visit recovery", async () => {
  const pinned = `v1_${"c".repeat(64)}`;
  const calls = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "customer-token",
    WARUN_VISIT_CONTEXT_ID: pinned,
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: false },
  };
  const response = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (name) => headers[name] ?? null }, async json() { return body; } });
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(29),
    autoRetry: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/device/config")) return response({ role: "customer", visitContextId: pinned });
      return response({}, { "Idempotency-Result": "created" });
    },
  });
  const record = await client.enqueue({ visitContextId: await client.getVisitContextId(), items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal(record.payload.visitContextId, pinned);
  assert.equal((await client.flush({ clientOrderId: record.clientOrderId })).state, "pending");
  assert.equal(calls.length, 0);
  env.navigator.onLine = true;
  const result = await client.flush({ clientOrderId: record.clientOrderId, force: true });
  assert.equal(result.state, "synced");
  assert.equal(calls[0].url, "https://api.example.test/v1/device/config");
  assert.equal(calls[1].url, "https://api.example.test/v1/orders");
  assert.equal(JSON.parse(calls[1].options.body).visitContextId, pinned);
});

test("possibly accepted retry reaches replay-first server check after context changed", async () => {
  const pinned = `v1_${"d".repeat(64)}`;
  let current = pinned;
  const changed = `v1_${"e".repeat(64)}`;
  const calls = [];
  const env = {
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: "https://api.example.test/v1",
    WARUN_API_TOKEN: "customer-token",
    location: { origin: "https://tablet.example.test" },
    navigator: { onLine: true },
  };
  const response = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (name) => headers[name] ?? null }, async json() { return body; } });
  let loseFirstResponse = true;
  const client = createCustomerOrderClient({
    global: env,
    store: createMemoryOutbox(),
    idFactory: () => uuid(30),
    autoRetry: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/device/config")) return response({ role: "customer", visitContextId: current });
      if (loseFirstResponse) {
        loseFirstResponse = false;
        current = changed;
        throw new Error("simulated response loss");
      }
      return response({}, { "Idempotency-Result": "replayed" });
    },
  });
  const record = await client.enqueue({ visitContextId: pinned, items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal((await client.flush({ clientOrderId: record.clientOrderId, force: true })).state, "pending");
  assert.equal((await client.get(record.clientOrderId)).attemptCount, 1);
  const result = await client.flush({ clientOrderId: record.clientOrderId, force: true });
  assert.equal(result.state, "synced");
  assert.equal(result.idempotencyResult, "replayed");
  assert.equal(JSON.parse(calls.at(-1).options.body).visitContextId, pinned);
});

test("demo mode remains local and immediately succeeds without IndexedDB", async () => {
  const client = createCustomerOrderClient({ global: { WARUN_ORDER_MODE: "demo" }, idFactory: () => uuid(17) });
  const record = await client.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal(client.mode, "demo");
  assert.equal(record.state, "synced");
  assert.deepEqual(await client.list(), []);
});

test("customer checkout client uses authenticated current/create contracts and hides staff details", async () => {
  const calls = [];
  const config = { enabled: true, baseUrl: "http://127.0.0.1:8787/v1", token: "customer-runtime-token" };
  const checkoutRequestId = uuid(21);
  const response = (body, headers = {}) => ({ ok: true, status: 200, headers: { get(name) { return headers[name] ?? null; } }, async json() { return body; } });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/current")) return response({ checkout: { checkoutRequestId, status: "requested", receiptRequested: true, version: 1, requestedAtMs: 1, readyAtMs: null, orderedItemsTotalYen: 99999, adjustments: [] } });
    return response({ checkoutRequestId, status: "requested", receiptRequested: true, version: 1, requestedAtMs: 1, readyAtMs: null, grandTotalYen: 99999 }, { "Idempotency-Result": "created" });
  };
  const current = await fetchCustomerCheckout({ config, fetchImpl });
  assert.equal(current.status, "requested");
  assert.equal("orderedItemsTotalYen" in current, false);
  const created = await requestCustomerCheckout({ config, checkoutRequestId, receiptRequested: true, fetchImpl });
  assert.equal(created.receiptRequested, true);
  assert.equal(calls[0].options.headers.Authorization, "Bearer customer-runtime-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), { checkoutRequestId, receiptRequested: true });
});

test("customer checkout client preserves failure status without reporting success", async () => {
  const config = { enabled: true, baseUrl: "http://127.0.0.1:8787/v1", token: "customer-runtime-token" };
  const errorResponse = { ok: false, status: 409, async json() { return { error: { code: "CHECKOUT_CONFLICT" } }; } };
  await assert.rejects(() => requestCustomerCheckout({ config, checkoutRequestId: uuid(22), receiptRequested: false, fetchImpl: async () => errorResponse }), (error) => error.status === 409 && error.code === "CHECKOUT_CONFLICT");
});
