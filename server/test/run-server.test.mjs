import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { accessUrls, createSameOriginWebServer, lanIPv4Addresses } from "../src/run-server.mjs";

test("LAN access URLs are derived without changing the API contract", () => {
  assert.deepEqual(lanIPv4Addresses({
    Ethernet: [
      { family: "IPv4", address: "192.168.1.23", internal: false },
      { family: "IPv6", address: "::1", internal: false },
    ],
    Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  }), ["192.168.1.23"]);
  assert.deepEqual(accessUrls({ host: "0.0.0.0", port: 8787, webPort: 5173, addresses: ["192.168.1.23"] }), {
    apiUrls: ["http://127.0.0.1:8787/v1", "http://192.168.1.23:8787/v1"],
    webUrls: ["http://127.0.0.1:5173/", "http://192.168.1.23:5173/"],
  });
});

test("admin runtime is injected only into the admin shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "warun-web-runtime-"));
  const apiServer = createServer((_request, response) => response.end());
  const token = "test-admin-runtime-token";
  let webServer;
  try {
    await writeFile(join(root, "index.html"), '<!doctype html><html><head><script type="module">window.app = true;</script></head><body></body></html>');
    webServer = createSameOriginWebServer({ apiServer, webRoot: root, adminRuntimeToken: token });
    await new Promise((resolve, reject) => { webServer.once("error", reject); webServer.listen(0, "127.0.0.1", resolve); });
    const { port } = webServer.address();
    const fetchHtml = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((response) => response.text());
    const customerHtml = await fetchHtml("/");
    const adminHtml = await fetchHtml("/admin.html");
    assert.doesNotMatch(customerHtml, /WARUN_RUNTIME_CONFIG|test-admin-runtime-token/);
    assert.match(adminHtml, /WARUN_RUNTIME_CONFIG/);
    assert.match(adminHtml, /test-admin-runtime-token/);
    assert.ok(adminHtml.indexOf("WARUN_RUNTIME_CONFIG") < adminHtml.indexOf('type="module"'));
  } finally {
    await new Promise((resolve) => webServer?.close(resolve));
    apiServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
