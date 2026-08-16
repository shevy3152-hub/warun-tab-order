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
  fetchCustomerOrderHistory,
  resolveOrderApiConfig,
  retryDelayForAttempt,
  subscribeCustomerInvalidations,
} from "../src/order-outbox.js";
import { customerOrderNoticeFromOutboxEvent } from "../src/customer-order-notice.js";

const ITEM_ID = "edamame";

function uuid(value = 1) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

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
  assert.deepEqual(Object.values(OUTBOX_STATES).sort(), ["pending", "rejected", "sending", "synced"]);
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

test("outbox success events map to a customer sent notice after recovery", () => {
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(40), state: "synced", displayState: "synced" }), {
    kind: "success",
    message: "送信済みです。ご注文を承りました。",
  });
  assert.deepEqual(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(41), state: "synced", displayState: "synced", idempotencyResult: "replayed" }), {
    kind: "success",
    message: "送信済みです。ご注文を承りました。",
  });
  assert.equal(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(42), state: "rejected", displayState: "business_error" }).kind, "error");
  assert.equal(customerOrderNoticeFromOutboxEvent({ clientOrderId: uuid(43), state: "pending", displayState: "failed" }).kind, "failed");
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
  unsubscribe();
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
  assert.equal(result.state, "pending");
  assert.equal(result.errorCode, "API_TOKEN_UNCONFIGURED");
});

test("demo mode remains local and immediately succeeds without IndexedDB", async () => {
  const client = createCustomerOrderClient({ global: { WARUN_ORDER_MODE: "demo" }, idFactory: () => uuid(17) });
  const record = await client.enqueue({ items: [{ menuItemId: ITEM_ID, quantity: 1 }] });
  assert.equal(client.mode, "demo");
  assert.equal(record.state, "synced");
  assert.deepEqual(await client.list(), []);
});
