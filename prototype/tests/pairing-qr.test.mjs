import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AdminPairingError, fetchAdminDiagnostics, fetchAdminPairingPreflight, issueCustomerPairingCode, pairingCodeFromLocation, pairingRegistrationUrl, revokeAdminDevice } from "../src/admin-pairing.js";
import { pairingCodeQrSvg } from "../src/qr-code.js";

const CODE = "A".repeat(43);
const TOKEN = "runtime-admin-token-is-not-in-the-qr";
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const pairingMainSource = await readFile(new URL("../src/pairing-main.jsx", import.meta.url), "utf8");
const credentialsSource = await readFile(new URL("../src/device-credentials.js", import.meta.url), "utf8");

test("pairing QR contains only a generated QR image, not the raw code", () => {
  const svg = pairingCodeQrSvg(CODE);
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, new RegExp(CODE));
  assert.match(svg, /rect/);
});

test("admin pairing transport uses the Bearer token only in the header", async () => {
  let request;
  const result = await issueCustomerPairingCode({
    env: { location: { origin: "http://localhost" }, WARUN_ADMIN_API_TOKEN: TOKEN },
    tableId: 1,
    expiresAtMs: Date.now() + 600000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 201, async json() { return { code: CODE, role: "customer", tableId: 1, expiresAtMs: Date.now() + 600000, pairingUrl: "http://192.0.2.1:25173/pairing.html#p=CODE" }; } };
    },
  });
  assert.equal(result.tableId, 1);
  assert.equal(request.url, "http://localhost/v1/admin/pairing-codes");
  assert.equal(request.options.body.includes(TOKEN), false);
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("admin pairing reuses the existing runtime API token path", async () => {
  let authorization;
  await issueCustomerPairingCode({
    env: { location: { origin: "http://localhost" }, WARUN_RUNTIME_CONFIG: { apiToken: TOKEN } },
    tableId: 1,
    expiresAtMs: Date.now() + 600000,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return { ok: true, status: 201, async json() { return { code: CODE, role: "customer", tableId: 1, expiresAtMs: Date.now() + 600000, pairingUrl: "http://192.0.2.1:25173/pairing.html#p=CODE" }; } };
    },
  });
  assert.equal(authorization, `Bearer ${TOKEN}`);
});

test("admin device revoke uses the existing authenticated endpoint without sending the token in the body", async () => {
  let request;
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const result = await revokeAdminDevice({
    env: { location: { origin: "http://localhost" }, WARUN_ADMIN_API_TOKEN: TOKEN },
    deviceId,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return { deviceId, status: "revoked" }; } };
    },
  });
  assert.equal(result.status, "revoked");
  assert.equal(request.url, "http://localhost/v1/admin/devices/revoke");
  assert.doesNotMatch(request.options.body, new RegExp(TOKEN));
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("pairing URL stores the code in a LAN URL fragment", () => {
  const url = pairingRegistrationUrl("ABCD-EFGH-IJKL", "http://example.test:25173");
  assert.equal(url, "http://example.test:25173/pairing.html#p=ABCDEFGHIJKL");
  assert.equal(pairingCodeFromLocation(new URL(url)), "ABCDEFGHIJKL");
});

test("pairing preflight reports a missing admin token as 401 without sending a request", async () => {
  await assert.rejects(
    () => fetchAdminPairingPreflight({ env: { location: { origin: "http://example.test:25173" }, fetch: async () => { throw new Error("must not call"); } } }),
    (error) => error instanceof AdminPairingError && error.status === 401 && error.code === "AUTH_TOKEN_MISMATCH",
  );
});

test("pairing preflight uses the same-origin admin endpoint", async () => {
  let request;
  const result = await fetchAdminPairingPreflight({
    env: { location: { origin: "http://example.test:25173" }, WARUN_ADMIN_API_TOKEN: TOKEN },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            authentication: { status: "valid", role: "admin" },
            database: { target: "safe-copy", isProduction: false, environment: "safe-copy", path: "C:/safe-copy.sqlite3" },
            server: { apiPort: 28787, webPort: 25173, lanIPv4: ["192.0.2.1"], webOrigins: ["http://example.test:25173"], requestedOrigin: "http://example.test:25173", webOriginMatches: true, apiBasePath: "/v1", pairingUrlOrigin: "http://192.0.2.1:25173", pairingUrlTemplate: "http://192.0.2.1:25173/pairing.html#p=<code>" },
            tables: { available: [{ tableId: 2, label: "Table 2" }], assigned: [{ tableId: 1, label: "Table 1", deviceDisplayName: "Existing" }] },
            pairing: { canIssue: true, blockedReason: null },
          };
        },
      };
    },
  });
  assert.equal(request.url, "http://example.test:25173/v1/admin/pairing-preflight");
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(result.tables.available.map((table) => table.tableId), [2]);
});

test("admin diagnostics uses a read-only same-origin endpoint and exposes no request body", async () => {
  let request;
  const result = await fetchAdminDiagnostics({
    env: { location: { origin: "http://example.test:25173" }, WARUN_ADMIN_API_TOKEN: TOKEN },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            runtime: { lanIPv4: ["192.0.2.1"], webPort: 25173, apiPort: 28787, processId: 17, databaseTarget: "safe-copy", isProduction: false },
            schemaVersion: 4,
            authentication: { status: "valid", role: "admin" },
            tables: { available: [], assigned: [] },
            storage: { orders: 0, orderItems: 0, eventLog: 0 },
            latestOrderSend: { status: 201, requestId: "00000000-0000-4000-8000-000000000017", endpoint: "POST /v1/orders" },
            latestOrderRetrieval: null,
            recent: [],
          };
        },
      };
    },
  });
  assert.equal(request.url, "http://example.test:25173/v1/admin/diagnostics");
  assert.equal(request.options.method, undefined);
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(result.runtime.databaseTarget, "safe-copy");
  assert.equal(result.schemaVersion, 4);
});

test("admin source renders a QR modal and does not fall back to raw code display", () => {
  assert.match(appSource, /pairingCodeQrSvg/);
  assert.match(appSource, /pairing-qr-modal/);
  assert.match(appSource, /接続解除/);
  assert.doesNotMatch(appSource, /入力コード.*formatPairingCode\(pairingCode\)/);
});

test("customer pairing surfaces expired and existing-device causes", () => {
  assert.match(credentialsSource, /PairingClaimError/);
  assert.match(credentialsSource, /コード期限切れ/);
  assert.match(credentialsSource, /既存端末競合/);
  assert.match(pairingMainSource, /pairingClaimErrorMessage/);
  assert.match(pairingMainSource, /role=\"alert\"/);
  assert.match(appSource, /pairingClaimErrorMessage/);
});
