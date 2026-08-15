import assert from "node:assert/strict";
import test from "node:test";
import { fetchKitchenOrders, kitchenApiConfigured, markKitchenItemServed } from "../src/kitchen-api.js";

const TOKEN = "fixture-kitchen-runtime-token";

function environment(fetch) {
  return {
    location: { origin: "http://192.168.1.10:5173" },
    WARUN_RUNTIME_CONFIG: { kitchenToken: TOKEN },
    fetch,
  };
}

test("kitchen API uses the runtime token and maps active snapshot orders", async () => {
  const calls = [];
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          activeOrders: [{
            orderId: "order-1",
            tableId: 1,
            acceptedAtMs: 1786786940836,
            status: "new",
            totalAmountYen: 960,
            items: [{ orderItemId: 11, menuItemId: "edamame", formalNameSnapshot: "枝豆", kitchenAliasSnapshot: "枝豆", quantity: 1, isServed: false, servedAtMs: null }],
          }],
        };
      },
    };
  });

  assert.equal(kitchenApiConfigured(env), true);
  const orders = await fetchKitchenOrders({ env });
  assert.equal(orders[0].tableId, "1");
  assert.equal(orders[0].items[0].isServed, false);
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/snapshot");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("kitchen serving update uses the same runtime token", async () => {
  const calls = [];
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  });

  await markKitchenItemServed({ env, orderId: "order-1", orderItemId: 11 });
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/kitchen/order-items/serve");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { orderId: "order-1", orderItemId: 11 });
});

test("kitchen API is not configured without an explicit runtime token", () => {
  const env = { location: { origin: "http://192.168.1.10:5173" }, fetch() {} };
  assert.equal(kitchenApiConfigured(env), false);
});

test("kitchen API can read the admin-shell meta token without runtime globals", () => {
  const env = {
    location: { origin: "http://192.168.1.10:5173" },
    document: {
      querySelector(selector) {
        assert.equal(selector, 'meta[name="warun-kitchen-token"]');
        return { getAttribute(name) { return name === "content" ? TOKEN : null; } };
      },
    },
    fetch() {},
  };
  assert.equal(kitchenApiConfigured(env), true);
});
