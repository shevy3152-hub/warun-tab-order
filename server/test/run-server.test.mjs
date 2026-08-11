import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { initializeDatabase } from "../src/db/database.mjs";
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

test("run-server stays alive until SIGINT and releases both ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "warun-lifecycle-"));
  const databasePath = join(root, "test.sqlite3");
  const adminToken = randomBytes(32).toString("base64url");
  const connection = initializeDatabase({ databasePath });
  const adminId = "00000000-0000-4000-8000-000000000001";
  connection.database.prepare("INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'admin', ?, ?, 'active', 1, 1, 1)").run(adminId, "Test admin", createHash("sha256").update(adminToken, "utf8").digest("hex"));
  connection.database.prepare("INSERT INTO tables (table_id, label, is_active, version, created_at_ms, updated_at_ms) VALUES (1, 'Table 1', 1, 1, 1, 1)").run();
  connection.close();
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apiPort = 18787;
  const webPort = 15173;
  const child = spawn(process.execPath, ["src/run-server.mjs"], {
    cwd: serverRoot,
    env: { ...process.env, WARUN_DB_PATH: databasePath, WARUN_ADMIN_API_TOKEN: adminToken, WARUN_SERVER_PORT: String(apiPort), WARUN_WEB_PORT: String(webPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("Server did not announce its URLs.")), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${webPort}/`)) { clearTimeout(timeout); resolveReady(); }
    });
    child.once("error", (error) => { clearTimeout(timeout); rejectReady(error); });
    child.once("exit", (code) => { if (code !== null) { clearTimeout(timeout); rejectReady(new Error(`Server exited before readiness: ${code}`)); } });
  });
  try {
    await ready;
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/v1/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${webPort}/`)).status, 200);
    const adminHtmlResponse = await fetch(`http://127.0.0.1:${webPort}/admin.html`);
    assert.equal(adminHtmlResponse.status, 200);
    const adminHtml = await adminHtmlResponse.text();
    assert.match(adminHtml, /WARUN_RUNTIME_CONFIG/);
    const pairingResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/admin/pairing-codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "customer", tableId: 1, expiresAtMs: Date.now() + 600000 }),
    });
    assert.equal(pairingResponse.status, 201);
    assert.doesNotMatch(await pairingResponse.text(), new RegExp(adminToken));
    assert.equal(child.exitCode, null);
    child.kill("SIGINT");
    await Promise.race([once(child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("Server did not stop after SIGINT.")), 5000))]);
    await assert.rejects(() => fetch(`http://127.0.0.1:${webPort}/`));
    await assert.rejects(() => fetch(`http://127.0.0.1:${apiPort}/v1/health`));
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
