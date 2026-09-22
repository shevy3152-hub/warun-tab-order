import assert from "node:assert/strict";
import test from "node:test";
import { cancelKitchenCheckout, closeKitchenTableSession, fetchKitchenCheckoutRequests, fetchKitchenOrderHistory, fetchKitchenOrders, fetchKitchenPaymentHistory, fetchKitchenSnapshot, kitchenApiConfigured, markKitchenItemServed, payKitchenCheckout, readyKitchenCheckout, saveKitchenCheckoutAdjustments, voidKitchenPayment } from "../src/kitchen-api.js";

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
            items: [{ orderItemId: 11, menuItemId: "edamame", formalNameSnapshot: "枝豆", kitchenAliasSnapshot: "枝豆", variantNameSnapshot: "徳利2合", variantVolumeSnapshot: "360ml", temperatureSnapshot: "冷酒", quantity: 1, isServed: false, servedAtMs: null }],
          }],
        };
      },
    };
  });

  assert.equal(kitchenApiConfigured(env), true);
  const orders = await fetchKitchenOrders({ env });
  assert.equal(orders[0].tableId, "1");
  assert.equal(orders[0].items[0].isServed, false);
  assert.equal(orders[0].items[0].temperatureSnapshot, "冷酒");
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/snapshot");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("kitchen payment API keeps payment confirmation and void contracts explicit", async () => {
  const calls = [];
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return url.endsWith("payment-history") ? { payments: [] } : { paymentRecordId: "payment-1", status: url.endsWith("/void") ? "voided" : "paid", version: 2 }; } };
  });
  const paid = await payKitchenCheckout({ env, checkoutRequestId: "checkout-1", expectedVersion: 3, paymentMethod: "cash" });
  const history = await fetchKitchenPaymentHistory({ env });
  const voided = await voidKitchenPayment({ env, paymentRecordId: "payment-1", expectedVersion: paid.version, reason: "入力誤り" });
  assert.equal(paid.status, "paid");
  assert.deepEqual(history, []);
  assert.equal(voided.status, "voided");
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/kitchen/checkout-requests/checkout-1/pay");
  assert.deepEqual(JSON.parse(calls[0].options.body), { expectedVersion: 3, paymentMethod: "cash" });
  assert.equal(calls[1].url, "http://192.168.1.10:5173/v1/kitchen/payment-history");
  assert.equal(calls[2].url, "http://192.168.1.10:5173/v1/kitchen/payment-records/payment-1/void");
  assert.deepEqual(JSON.parse(calls[2].options.body), { expectedVersion: 2, reason: "入力誤り" });
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

test("kitchen snapshot exposes open sessions and close uses the runtime token", async () => {
  const calls = [];
  const sessionId = "00000000-0000-4000-8000-000000000777";
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/snapshot")) {
      return {
        ok: true,
        async json() {
          return {
            activeOrders: [],
            openSessions: [{ sessionId, tableId: 3, openedAtMs: 1786786940836, version: 1 }],
          };
        },
      };
    }
    return {
      ok: true,
      async json() { return { tableId: 3, sessionId, closedAtMs: 1786787000000, idempotencyResult: "created" }; },
    };
  });

  const snapshot = await fetchKitchenSnapshot({ env });
  assert.deepEqual(snapshot.sessions, [{
    sessionId,
    tableId: "3",
    openedAt: new Date(1786786940836).toISOString(),
    version: 1,
  }]);
  const closed = await closeKitchenTableSession({ env, tableId: 3, sessionId });
  assert.equal(closed.idempotencyResult, "created");
  assert.equal(calls[1].url, "http://192.168.1.10:5173/v1/tables/sessions/close");
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { tableId: 3, sessionId });
});

test("kitchen history uses the kitchen runtime token and SQLite API route", async () => {
  const calls = [];
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { orders: [{ orderId: "completed-order-1" }] }; } };
  });

  const orders = await fetchKitchenOrderHistory({ env });
  assert.equal(orders[0].orderId, "completed-order-1");
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/kitchen/order-history");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("kitchen checkout API reads and mutates the authenticated v12 contract", async () => {
  const calls = [];
  const checkoutRequestId = "00000000-0000-4000-8000-000000000778";
  const env = environment(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        if (url.endsWith("/checkout-requests")) return { checkouts: [{
          checkoutRequestId,
          status: "requested",
          tableSessionId: "00000000-0000-4000-8000-000000000777",
          receiptRequested: true,
          orderedItemsTotalYen: 1800,
          adjustmentsTotalYen: 500,
          grandTotalYen: null,
          version: 1,
          requestedAtMs: 1786786940836,
          readyAtMs: null,
          updatedAtMs: 1786786940836,
          adjustments: [{ adjustmentId: 1, checkoutRequestId, kind: "seat_charge", label: "席料", amountYen: 500, sortOrder: 0 }],
        }] };
        return {
          checkoutRequestId,
          status: url.endsWith("/ready") ? "ready" : url.endsWith("/cancel") ? "cancelled" : "requested",
          tableSessionId: "00000000-0000-4000-8000-000000000777",
          receiptRequested: true,
          orderedItemsTotalYen: 1800,
          adjustmentsTotalYen: 500,
          grandTotalYen: url.endsWith("/ready") ? 2300 : null,
          version: 2,
          requestedAtMs: 1786786940836,
          readyAtMs: url.endsWith("/ready") ? 1786787000000 : null,
          updatedAtMs: 1786787000000,
          adjustments: [{ adjustmentId: 1, checkoutRequestId, kind: "seat_charge", label: "席料", amountYen: 500, sortOrder: 0 }],
        };
      },
    };
  });
  const list = await fetchKitchenCheckoutRequests({ env });
  assert.equal(list[0].receiptRequested, true);
  assert.equal(list[0].adjustments[0].amountYen, 500);
  const saved = await saveKitchenCheckoutAdjustments({ env, checkoutRequestId, expectedVersion: 1, adjustments: [{ kind: "seat_charge", label: "席料", amountYen: 500 }] });
  const ready = await readyKitchenCheckout({ env, checkoutRequestId, expectedVersion: saved.version });
  await cancelKitchenCheckout({ env, checkoutRequestId, expectedVersion: ready.version });
  assert.equal(calls[0].url, "http://192.168.1.10:5173/v1/kitchen/checkout-requests");
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedVersion: 1, adjustments: [{ kind: "seat_charge", label: "席料", amountYen: 500 }] });
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[3].options.method, "POST");
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
