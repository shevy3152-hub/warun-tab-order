import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_CATALOG_ERROR_CODES, fetchCustomerCatalog } from "../src/customer-catalog.js";

const TOKEN = "catalog-token-memory-only";

function env(fetch) {
  return {
    location: { origin: "http://tablet.example.test" },
    WARUN_API_BASE: "http://tablet.example.test/v1",
    WARUN_API_TOKEN: TOKEN,
    fetch,
  };
}

test("customer catalog loads device table and server menu with Bearer only", async () => {
  const requests = [];
  const catalog = await fetchCustomerCatalog({
    globalObject: env(async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/device/config")) {
        return { ok: true, async json() { return { deviceId: "00000000-0000-4000-8000-000000000101", role: "customer", status: "active", tableId: 3, tableLabel: "Table 3", configVersion: 1, eventEpoch: 1, lastEventId: 0 }; } };
      }
      return { ok: true, async json() { return { audience: "customer", eventEpoch: 1, lastEventId: 0, categories: [{ categoryId: "food", name: "Food", sortOrder: 1 }], items: [{ menuItemId: "edamame", categoryId: "food", formalName: "Edamame", description: "", isSoldOut: false, sortOrder: 1 }] }; } };
    }),
  });

  assert.equal(catalog.tableId, "3");
  assert.equal(catalog.menuItems.length, 1);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname).sort(), ["/v1/device/config", "/v1/menu"]);
  for (const request of requests) {
    assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(request.url.includes(TOKEN), false);
  }
});

test("an empty server menu is a blocking catalog error", async () => {
  await assert.rejects(
    fetchCustomerCatalog({
      globalObject: env(async (url) => ({ ok: true, async json() {
        if (url.endsWith("/device/config")) return { deviceId: "00000000-0000-4000-8000-000000000101", role: "customer", status: "active", tableId: 3, tableLabel: "Table 3", configVersion: 1, eventEpoch: 1, lastEventId: 0 };
        return { audience: "customer", eventEpoch: 1, lastEventId: 0, categories: [], items: [] };
      } })),
    }),
    (error) => error.code === CUSTOMER_CATALOG_ERROR_CODES.MENU_EMPTY,
  );
});
