import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { isLocalStaffRequest, isStaffEntryPath } from "../src/http/staff-shell-access.mjs";
import { createSameOriginWebServer, createWarunServer } from "../src/run-server.mjs";
import { fetchAdminOrderHistory } from "../../prototype/src/admin-pairing.js";
import { fetchKitchenSnapshot } from "../../prototype/src/kitchen-api.js";

const ADMIN_TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const KITCHEN_TOKEN = Buffer.alloc(32, 0x62).toString("base64url");
const CUSTOMER_TOKEN = Buffer.alloc(32, 0x63).toString("base64url");
const HTML = '<!doctype html><html><head><script type="module">/* fixture app */</script></head><body>Fictional test fixture</body></html>';
const PORT = 49152;
const localRequest = (remoteAddress = "127.0.0.1", host = "127.0.0.1:" + PORT) => ({
  socket: { remoteAddress, localPort: PORT },
  rawHeaders: ["Host", host],
});
const lanAddress = Object.values(networkInterfaces()).flat().find((entry) =>
  entry.family === "IPv4" && !entry.internal)?.address;

function assertNoStaffCredentials(result) {
  const response = JSON.stringify(result);
  for (const token of [ADMIN_TOKEN, KITCHEN_TOKEN]) assert.equal(response.includes(token), false);
  assert.doesNotMatch(response, /WARUN_RUNTIME_CONFIG|warun-kitchen-token/);
}

test("staff peer check accepts IPv4, IPv6 and mapped IPv6 loopback only", () => {
  for (const address of [
    "127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1", "::ffff:7fff:fffe", "0:0:0:0:0:ffff:7f00:1",
  ]) assert.equal(isLocalStaffRequest(localRequest(address)), true, address);
  for (const address of [
    "192.0.2.44", "10.0.0.1", "0.0.0.0", "::", "fe80::1",
    "::ffff:192.0.2.44", "::ffff:7e00:1", "::ffff:8000:1",
    "::127.0.0.1", "127.0.0.1.invalid", "127.1", "evil127.0.0.1",
    "::1.invalid", "::1%lo", "", null,
  ]) assert.equal(isLocalStaffRequest(localRequest(address)), false, String(address));
  assert.equal(isLocalStaffRequest({ ...localRequest(), socket: { localPort: PORT } }), false);
  assert.equal(isLocalStaffRequest({ ...localRequest(), socket: null }), false);
});

test("Host independently rejects rebinding, ambiguous authority and wrong ports", () => {
  for (const host of [
    "localhost:" + PORT, "LOCALHOST:" + PORT, "127.0.0.1:" + PORT,
    "127.42.1.9:" + PORT, "[::1]:" + PORT,
    "[0:0:0:0:0:0:0:1]:" + PORT, "[::ffff:127.0.0.1]:" + PORT,
  ]) assert.equal(isLocalStaffRequest(localRequest("::1", host)), true, host);
  for (const host of [
    "attacker.example:" + PORT, "localhost.attacker.example:" + PORT,
    "localhost.:" + PORT, "127.0.0.1.attacker.example:" + PORT,
    "192.0.2.44:" + PORT, "[::ffff:192.0.2.44]:" + PORT,
    "[127.0.0.1]:" + PORT, "::1:" + PORT, "127.1:" + PORT,
    "2130706433:" + PORT, "0x7f000001:" + PORT, "localhost:80",
    "localhost:0", "localhost:65536", "localhost:049152",
    "localhost", "localhost:49152@attacker.example", "localhost:49152/path",
    "localhost:49152,attacker.example", "localhost:49152 ", "",
  ]) assert.equal(isLocalStaffRequest(localRequest("127.0.0.1", host)), false, host);
  assert.equal(isLocalStaffRequest({
    socket: { remoteAddress: "127.0.0.1", localPort: 80 }, rawHeaders: ["Host", "localhost"],
  }), true);
});

test("spoofed forwarding and Origin headers cannot authorize a non-loopback peer", () => {
  const request = localRequest("192.0.2.44");
  request.rawHeaders.push(
    "Origin", "http://127.0.0.1:" + PORT,
    "X-Forwarded-For", "127.0.0.1", "Forwarded", 'for=127.0.0.1;host="localhost"',
    "X-Real-IP", "::1", "X-Forwarded-Host", "localhost:" + PORT,
  );
  assert.equal(isLocalStaffRequest(request), false);
  for (const rawHeaders of [
    [], ["Host"], ["Host", "localhost:" + PORT, "host", "127.0.0.1:" + PORT],
    ["Host", ["localhost:" + PORT]], ["X-Forwarded-Host", "localhost:" + PORT],
  ]) assert.equal(isLocalStaffRequest({ ...localRequest(), rawHeaders }), false);
  assert.equal(isLocalStaffRequest({
    ...localRequest(), rawHeaders: [], headers: { host: "localhost:" + PORT },
  }), false);
});

test("staff entry aliases are recognized before static serving or SPA fallback", () => {
  for (const path of [
    "/admin.html", "/ADMIN.HTML", "/admin.html/", "/admin.html/child",
    "/%61dmin.html", "/admin%2ehtml", "/admin.html%2fchild", "/admin.html%5cchild",
    "/admin.html.", "/admin.html%20", "/admin.html::$DATA",
    "/nested/../admin.html", "/nested/%2e%2e/admin.html", "/admin/menu",
    "/admin", "/kitchen", "/kitchen/", "/history", "/ADMIN/menu",
  ]) assert.equal(isStaffEntryPath(path), true, path);
  for (const path of ["/", "/index.html", "/pairing.html", "/customer/customer-01", "/assets/app.js", "/v1/admin/order-history"]) {
    assert.equal(isStaffEntryPath(path), false, path);
  }
  assert.throws(() => isStaffEntryPath("/admin%XX"), URIError);
  assert.throws(() => isStaffEntryPath("/admin.html%00"), URIError);
});

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function fixtureRoot(t) {
  const root = await mkdtemp(join(process.env.WARUN_TEST_ARTIFACT_ROOT || tmpdir(), "staff-fixture-"));
  t.diagnostic("Preserved fictional fixture: " + root);
  await writeFile(join(root, "index.html"), HTML);
  await writeFile(join(root, "pairing.html"), "<!doctype html><p>Fictional pairing</p>");
  await writeFile(join(root, "app.js"), "/* shared tokenless code */");
  await writeFile(join(root, "sample.webp"), "RIFF0000WEBP");
  // A physical staff-named file must not bypass the entry guard on Windows.
  await writeFile(join(root, "admin.html"), "STATIC-STAFF-DECOY");
  return root;
}
async function withWeb(t, run, { host = "127.0.0.1", missingRoot = false } = {}) {
  const root = await fixtureRoot(t);
  const api = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ path: request.url, fictional: true }));
  });
  const server = createSameOriginWebServer({
    apiServer: api, webRoot: missingRoot ? join(root, "absent") : root,
    adminRuntimeToken: ADMIN_TOKEN, kitchenRuntimeToken: KITCHEN_TOKEN,
  });
  try {
    await listen(server, host);
    await run(server, root);
  } finally {
    await close(server);
    api.close();
  }
}
function request(server, {
  peer = "127.0.0.1", path = "/admin.html", host,
  headers = {}, method = "GET", rawHeaders, headersOnly = false,
} = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const client = http.request({
      hostname: peer, port, path, method, agent: false, setHost: false,
      headers: rawHeaders ?? { Host: host ?? ("127.0.0.1:" + port), ...headers },
    }, (response) => {
      const chunks = [];
      if (headersOnly) {
        resolve({ status: response.statusCode, headers: response.headers, body: "" });
        response.destroy();
        return;
      }
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    client.setTimeout(5000, () => client.destroy(new Error("Isolated HTTP request timed out.")));
    client.on("error", reject);
    client.end();
  });
}

test("loopback bootstrap serves both staff roles, query strings and HEAD without changing HTML on disk", async (t) => {
  await withWeb(t, async (server) => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const result = await request(server, { host: host + ":" + server.address().port });
      assert.equal(result.status, 200);
      assert.ok(result.body.includes(ADMIN_TOKEN));
      assert.ok(result.body.includes(KITCHEN_TOKEN));
      assert.equal(result.body.includes("STATIC-STAFF-DECOY"), false);
      assert.match(result.body, /window\.location\.hash="\/admin\/devices"/);
      assert.equal(result.headers["cache-control"], "no-store");
    }
    assert.equal((await request(server, { path: "/admin.html?screen=kitchen" })).status, 200);
    const head = await request(server, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    for (const path of ["/", "/index.html", "/customer/customer-01", "/missing.html", "/pairing.html", "/app.js"]) {
      const result = await request(server, { path });
      assert.equal(result.status, 200);
      assertNoStaffCredentials(result);
    }
  });
});

test("real HTTP rejects rebinding Host, duplicate/missing Host and noncanonical credential targets", async (t) => {
  await withWeb(t, async (server) => {
    for (const host of ["attacker.example", "localhost.attacker.example", "192.0.2.44"]) {
      const result = await request(server, {
        host: host + ":" + server.address().port,
        headers: { Origin: "http://localhost", "X-Forwarded-For": "127.0.0.1" },
      });
      assert.equal(result.status, 403);
      assert.equal(result.body, "Forbidden");
      assertNoStaffCredentials(result);
    }
    for (const rawHeaders of [[], ["Host", "localhost", "Host", "localhost"]]) {
      const result = await request(server, { rawHeaders });
      assert.ok([400, 403].includes(result.status));
      assertNoStaffCredentials(result);
    }
    for (const path of ["/nested/../admin.html", "/v1/../admin.html", "/%2e/admin.html", "/admin.html#fragment"]) {
      const result = await request(server, { path });
      assert.equal(result.status, 404);
      assertNoStaffCredentials(result);
    }
    for (const path of ["http://localhost/admin.html", "//localhost/admin.html", "/admin%XX", "/admin.html%00"]) {
      const result = await request(server, { path });
      assert.equal(result.status, 400);
      assertNoStaffCredentials(result);
    }
  });
});

test("non-loopback TCP cannot fetch staff entries even with spoofed headers or static aliases", async (t) => {
  if (!lanAddress) return t.skip("No local non-loopback IPv4 interface is available.");
  await withWeb(t, async (server) => {
    const observedPeers = [];
    server.prependListener("request", (incoming) => observedPeers.push(incoming.socket.remoteAddress));
    for (const path of [
      "/admin.html", "/admin.html?screen=kitchen", "/ADMIN.HTML", "/admin.html/", "/admin.html/child",
      "/%61dmin.html", "/admin%2ehtml", "/admin.html%2fchild", "/admin.html%5cchild",
      "/admin.html.", "/admin.html%20", "/admin.html::$DATA", "/nested/../admin.html",
      "/v1/../admin.html", "/admin/menu", "/kitchen", "/history",
    ]) {
      const result = await request(server, {
        peer: lanAddress, path,
        headers: { Origin: "http://127.0.0.1", "X-Forwarded-For": "127.0.0.1", Forwarded: "for=127.0.0.1" },
      });
      assert.equal(result.status, 403, path);
      assert.equal(result.body, "Forbidden");
      assert.equal(result.headers["cache-control"], "no-store");
      assertNoStaffCredentials(result);
    }
    const head = await request(server, { peer: lanAddress, method: "HEAD" });
    assert.equal(head.status, 403);
    assert.equal(head.body, "");
    assert.ok(observedPeers.length >= 18);
    assert.ok(observedPeers.every((peer) => peer === lanAddress));
    t.diagnostic("Verified actual non-loopback TCP peers on an ephemeral, fictional server.");
  }, { host: "0.0.0.0" });
});

test("non-loopback rejection happens even when no HTML exists", async (t) => {
  if (!lanAddress) return t.skip("No local non-loopback IPv4 interface is available.");
  await withWeb(t, async (server) => {
    const result = await request(server, { peer: lanAddress });
    assert.equal(result.status, 403);
    assert.equal(result.body, "Forbidden");
    assertNoStaffCredentials(result);
  }, { host: "0.0.0.0", missingRoot: true });
});

test("customer LAN static files, pairing, SPA fallbacks and original API routing remain available", async (t) => {
  if (!lanAddress) return t.skip("No local non-loopback IPv4 interface is available.");
  await withWeb(t, async (server) => {
    for (const path of ["/", "/index.html", "/customer/customer-01", "/pairing.html", "/app.js", "/sample.webp", "/unknown"]) {
      const result = await request(server, { peer: lanAddress, path, host: lanAddress + ":" + server.address().port });
      assert.equal(result.status, 200, path);
      assertNoStaffCredentials(result);
      if (path === "/sample.webp") assert.equal(result.headers["content-type"], "image/webp");
    }
    for (const path of ["/v1/device/config", "/v1/menu", "/v1/events"]) {
      const result = await request(server, { peer: lanAddress, path, host: lanAddress + ":" + server.address().port });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).path, path);
      assertNoStaffCredentials(result);
    }
  }, { host: "0.0.0.0" });
});

test("real IPv6 loopback and IPv4-mapped loopback sockets receive the staff bootstrap", async (t) => {
  const root = await fixtureRoot(t);
  const api = http.createServer((_incoming, response) => response.end());
  const server = createSameOriginWebServer({
    apiServer: api, webRoot: root, adminRuntimeToken: ADMIN_TOKEN, kitchenRuntimeToken: KITCHEN_TOKEN,
  });
  const peers = [];
  server.prependListener("request", (incoming) => peers.push(incoming.socket.remoteAddress));
  try {
    try { await listen(server, "::"); }
    catch (error) {
      if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return t.skip("IPv6 listener is unavailable.");
      throw error;
    }
    for (const [peer, host] of [["::1", "[::1]"], ["127.0.0.1", "127.0.0.1"]]) {
      const result = await request(server, { peer, host: host + ":" + server.address().port });
      assert.equal(result.status, 200);
      assert.ok(result.body.includes(ADMIN_TOKEN));
      assert.ok(result.body.includes(KITCHEN_TOKEN));
    }
    assert.ok(peers.includes("::1"));
    assert.ok(peers.includes("::ffff:127.0.0.1"));
  } finally {
    await close(server);
    api.close();
  }
});

test("injected staff credentials work with real client adapters; customer LAN auth, SSE and images still work", async (t) => {
  if (!lanAddress) return t.skip("No local non-loopback IPv4 interface is available.");
  const root = await fixtureRoot(t);
  const productImages = join(root, "fixture-product-images");
  await mkdir(productImages);
  const imageName = "00000000-0000-4000-8000-000000000099.webp";
  await writeFile(join(productImages, imageName), "RIFF0000WEBP");
  const diagnosticsDirectory = join(root, "fixture-diagnostics");
  await mkdir(diagnosticsDirectory);
  const diagnosticPaths = {
    WARUN_COMMUNICATION_DIAGNOSTIC_LOG_PATH: join(diagnosticsDirectory, "communication.jsonl"),
    WARUN_PAIRING_DIAGNOSTIC_LOG_PATH: join(diagnosticsDirectory, "pairing.jsonl"),
    WARUN_MENU_DIAGNOSTIC_LOG_PATH: join(diagnosticsDirectory, "menu.jsonl"),
  };
  const previousDiagnosticPaths = new Map(Object.keys(diagnosticPaths).map((name) => [name, process.env[name]]));
  let application;
  // The factory captures these paths synchronously. Restore before any await.
  try {
    for (const [name, value] of Object.entries(diagnosticPaths)) process.env[name] = value;
    application = createWarunServer({
      databasePath: join(root, "fictional.sqlite3"),
      productImageStoragePath: productImages,
      customerThemeImageStoragePath: join(root, "fixture-theme-images"),
    });
  } finally {
    for (const [name, value] of previousDiagnosticPaths) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.ok([...previousDiagnosticPaths].every(([name, value]) => process.env[name] === value),
    "Diagnostic environment must be restored before asynchronous requests.");
  let web;
  try {
    const database = application.connection.database;
    const hash = (token) => createHash("sha256").update(token).digest("hex");
    const insertDevice = database.prepare("INSERT INTO devices (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, 'Fictional test device', ?, 'active', 1, 1, 1)");
    for (const [suffix, role, token] of [["001", "admin", ADMIN_TOKEN], ["002", "kitchen", KITCHEN_TOKEN], ["003", "customer", CUSTOMER_TOKEN]]) {
      insertDevice.run("00000000-0000-4000-8000-000000000" + suffix, role, hash(token));
    }
    database.prepare("INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms) VALUES (1, 'Fictional table', '00000000-0000-4000-8000-000000000003', 1, 1, 1, 1)").run();
    web = createSameOriginWebServer({
      apiServer: application.server, webRoot: root, adminRuntimeToken: ADMIN_TOKEN, kitchenRuntimeToken: KITCHEN_TOKEN,
    });
    await listen(web, "0.0.0.0");
    const result = await request(web);
    assert.equal(result.status, 200);
    const runtimeScript = result.body.match(/<script>(window\.WARUN_RUNTIME_CONFIG=[\s\S]*?)<\/script>/)?.[1];
    assert.ok(runtimeScript);
    const env = { location: { origin: "http://127.0.0.1:" + web.address().port }, fetch };
    runInNewContext(runtimeScript, { window: env });
    assert.deepEqual(await fetchAdminOrderHistory({ env }), []);
    assert.deepEqual((await fetchKitchenSnapshot({ env })).orders, []);
    for (const path of ["/v1/device/config", "/v1/menu"]) {
      const response = await request(web, {
        peer: lanAddress, path, host: lanAddress + ":" + web.address().port,
        headers: { Authorization: "Bearer " + CUSTOMER_TOKEN },
      });
      assert.equal(response.status, 200, path);
      assertNoStaffCredentials(response);
    }
    const deniedAdmin = await request(web, {
      peer: lanAddress, path: "/v1/admin/order-history",
      headers: { Authorization: "Bearer " + CUSTOMER_TOKEN },
    });
    assert.equal(deniedAdmin.status, 403);
    const events = await request(web, {
      peer: lanAddress, path: "/v1/events", host: lanAddress + ":" + web.address().port,
      headers: { Accept: "text/event-stream", Authorization: "Bearer " + CUSTOMER_TOKEN }, headersOnly: true,
    });
    assert.equal(events.status, 200);
    assert.match(events.headers["content-type"], /text\/event-stream/);
    const image = await request(web, {
      peer: lanAddress, path: "/v1/product-images/" + imageName,
      host: lanAddress + ":" + web.address().port,
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers["content-type"], "image/webp");
    assertNoStaffCredentials(image);
    const diagnostics = (await readFile(diagnosticPaths.WARUN_COMMUNICATION_DIAGNOSTIC_LOG_PATH, "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    for (const endpoint of ["GET /v1/admin/order-history", "GET /v1/snapshot"]) {
      assert.ok(diagnostics.some((entry) => entry.endpoint === endpoint && entry.status === 200),
        "Successful retrieval must be recorded in the fixture's own diagnostics.");
    }
  } finally {
    await close(web);
    application.closeDependencies();
  }
});
