import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { issueCustomerPairingCode } from "../src/admin-pairing.js";
import { pairingCodeQrSvg } from "../src/qr-code.js";

const CODE = "A".repeat(43);
const TOKEN = "runtime-admin-token-is-not-in-the-qr";
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

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
      return { ok: true, async json() { return { code: CODE, role: "customer", tableId: 1, expiresAtMs: Date.now() + 600000 }; } };
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
      return { ok: true, async json() { return { code: CODE, role: "customer", tableId: 1, expiresAtMs: Date.now() + 600000 }; } };
    },
  });
  assert.equal(authorization, `Bearer ${TOKEN}`);
});

test("admin pairing 201 success transitions to visible QR without an error", async () => {
  let request;
  const response = await issueCustomerPairingCode({
    env: { location: { origin: "http://localhost" }, WARUN_RUNTIME_CONFIG: { apiToken: TOKEN } },
    tableId: 3,
    expiresAtMs: Date.now() + 600000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 201,
        async json() { return { code: CODE, role: "customer", tableId: 3, expiresAtMs: Date.now() + 600000 }; },
      };
    },
  });
  const svg = pairingCodeQrSvg(response.code);
  assert.equal(request.url, "http://localhost/v1/admin/pairing-codes");
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(svg, /^<svg /);
  assert.match(appSource, /import \{ pairingCodeQrSvg \} from "\.\/qr-code\.js";/);
  assert.match(appSource, /setPairingQr\(pairingCodeQrSvg\(result\.code\)\)/);
  assert.doesNotMatch(appSource, /setPairingError\(true\).*setPairingQr\(pairingCodeQrSvg/);
});
