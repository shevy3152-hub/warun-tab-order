import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapCustomerOrderClient } from "../src/customer-bootstrap.js";
import { createCustomerOrderClient, createMemoryOutbox } from "../src/order-outbox.js";

const TOKEN = "credential-token-kept-in-memory-only";

function environment() {
  return {
    location: { origin: "http://192.168.1.12:5173" },
    navigator: { onLine: true },
    indexedDB: {},
  };
}

test("credential survives reload-equivalent bootstrap and selects same-origin API transport", async () => {
  let captured;
  let config;
  const client = await bootstrapCustomerOrderClient({
    globalObject: environment(),
    onConfig(value) { config = value; },
    credentialStore: { async load() { return { deviceId: "device-id", token: TOKEN, config: { tableId: 1, tableLabel: "テーブル1" } }; } },
    createClient(options) {
      captured = options;
      return { mode: "api" };
    },
  });

  assert.equal(client.mode, "api");
  assert.equal(captured.global.WARUN_ORDER_MODE, "api");
  assert.equal(captured.global.WARUN_API_BASE, "http://192.168.1.12:5173/v1");
  assert.equal(captured.global.WARUN_API_TOKEN, TOKEN);
  assert.deepEqual(config, { tableId: 1, tableLabel: "テーブル1" });
  assert.doesNotMatch(captured.global.WARUN_API_BASE, new RegExp(TOKEN));
});

test("missing credential goes to pairing instead of implicit demo mode", async () => {
  let createCalls = 0;
  const client = await bootstrapCustomerOrderClient({
    globalObject: environment(),
    credentialStore: { async load() { return null; } },
    createClient() { createCalls += 1; return { mode: "demo" }; },
  });

  assert.equal(client, null);
  assert.equal(createCalls, 0);
});

test("demo transport is available only with explicit demo configuration", async () => {
  let captured;
  const client = await bootstrapCustomerOrderClient({
    globalObject: { ...environment(), WARUN_ORDER_MODE: "demo" },
    credentialStore: { async load() { throw new Error("credential store must not be needed"); } },
    createClient(options) { captured = options; return { mode: "demo" }; },
  });

  assert.equal(client.mode, "demo");
  assert.equal(captured.global.WARUN_ORDER_MODE, "demo");
});

test("credential-first client posts once with Bearer auth and intent-only payload", async () => {
  const calls = [];
  const env = {
    ...environment(),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return { idempotencyResult: "created" }; } };
    },
  };
  const store = createMemoryOutbox();
  const client = await bootstrapCustomerOrderClient({
    globalObject: env,
    credentialStore: { async load() { return { deviceId: "device-id", token: TOKEN }; } },
    createClient(options) {
      return createCustomerOrderClient({ ...options, store, autoRetry: false, idFactory: () => "00000000-0000-4000-8000-000000000701" });
    },
  });

  assert.equal(client.mode, "api");
  const record = await client.enqueue({ items: [{ menuItemId: "edamame", quantity: 1 }] });
  await client.flush({ clientOrderId: record.clientOrderId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://192.168.1.12:5173/v1/orders");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(calls[0].options.body, new RegExp(TOKEN));
  assert.deepEqual(JSON.parse(calls[0].options.body).items, [{ menuItemId: "edamame", quantity: 1 }]);
});
