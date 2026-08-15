import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = resolve(scriptDirectory, "../dist/client");
const smokeToken = "production-smoke-customer-token";
const smokeDeviceId = "00000000-0000-4000-8000-000000000701";
const smokeOrderId = "00000000-0000-4000-8000-000000000702";
const smokeClientOrderId = "00000000-0000-4000-8000-000000000703";
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".ttf", "font/ttf"],
]);

async function findChrome() {
  const candidates = [
    process.env.WARUN_CHROME_PATH,
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Chrome is required for the production browser smoke test.");
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(50);
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready.");
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function removeTemporaryProfile(path) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 10) throw error;
      await delay(100 * attempt);
    }
  }
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
    },
    once(method) {
      return new Promise((resolveEvent) => {
        const listener = (params) => {
          listeners.set(method, (listeners.get(method) || []).filter((entry) => entry !== listener));
          resolveEvent(params);
        };
        this.on(method, listener);
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed.");
  }
  return result.result.value;
}

async function navigate(cdp, url) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function waitForBrowserValue(cdp, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(50);
  }
  throw new Error("Production browser smoke condition timed out.");
}

async function openHistory(cdp, origin, expectedText) {
  await navigate(cdp, `${origin}/`);
  await waitForBrowserValue(cdp, `document.querySelector("#root")?.children.length > 0`);
  const clicked = await waitForBrowserValue(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find(entry => entry.innerText.includes("注文履歴"));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true);
  return waitForBrowserValue(cdp, `document.body.innerText.includes(${JSON.stringify(expectedText)}) ? document.body.innerText : ""`);
}

await access(join(clientDirectory, "index.html"));
const chrome = await findChrome();
const profileDirectory = await mkdtemp(join(tmpdir(), "warun-production-smoke-"));
let historyRequests = 0;
const historyAuthorizations = [];
const historyRequestModes = [];
let historyMode = "success";
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/v1/customer/order-history") {
      historyRequests += 1;
      historyAuthorizations.push(request.headers.authorization || "");
      historyRequestModes.push(historyMode);
      if (historyMode === "network") {
        request.socket.destroy();
        return;
      }
      if (historyMode === "401" || historyMode === "403") {
        response.writeHead(Number(historyMode), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: { code: "SMOKE_AUTH_FAILURE", message: "Smoke authorization failure." } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ orders: [{
        orderId: smokeOrderId,
        clientOrderId: smokeClientOrderId,
        tableNumberSnapshot: 1,
        status: "completed",
        acceptedAtMs: 1_800_000_000_000,
        completedAtMs: 1_800_000_001_000,
        items: [{
          orderItemId: 1,
          menuItemId: "edamame",
          formalNameSnapshot: "枝豆 smoke",
          quantity: 1,
          isServed: true,
          servedAtMs: 1_800_000_001_000,
        }],
      }] }));
      return;
    }
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const candidate = resolve(clientDirectory, `.${pathname}`);
    if (!candidate.startsWith(`${clientDirectory}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(candidate);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(candidate)) || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

let chromeProcess;
let cdp;
try {
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  chromeProcess = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ], { stdio: "ignore" });
  const endpoint = (await waitForFile(join(profileDirectory, "DevToolsActivePort"))).trim().split(/\r?\n/);
  const devtoolsPort = Number(endpoint[0]);
  assert.ok(Number.isSafeInteger(devtoolsPort) && devtoolsPort > 0);
  const pages = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) => response.json());
  const page = pages.find((entry) => entry.type === "page");
  assert.ok(page?.webSocketDebuggerUrl);
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  const browserErrors = [];
  const failedResources = [];
  const requestUrls = new Map();
  cdp.on("Runtime.exceptionThrown", (event) => browserErrors.push(event.exceptionDetails?.text || "runtime exception"));
  cdp.on("Network.requestWillBeSent", (event) => requestUrls.set(event.requestId, event.request.url));
  cdp.on("Network.loadingFailed", (event) => failedResources.push({
    url: requestUrls.get(event.requestId) || "unknown",
    error: event.errorText || "resource load failed",
  }));
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
  ]);

  await navigate(cdp, `${origin}/`);
  const seedResult = await evaluate(cdp, `new Promise((resolve, reject) => {
    const request = indexedDB.open("warun-device-credentials", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("credentials", { keyPath: "key" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("credentials", "readwrite");
      transaction.objectStore("credentials").put(${JSON.stringify({
        key: "customer",
        deviceId: smokeDeviceId,
        token: smokeToken,
        config: { tableId: 1, tableLabel: "テーブル1" },
      })});
      transaction.oncomplete = () => resolve("seeded");
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  assert.equal(seedResult, "seeded");

  historyMode = "success";
  const historyText = await openHistory(cdp, origin, "枝豆 smoke");
  assert.match(historyText, /提供済み/);
  assert.match(historyText, /枝豆 smoke/);

  for (const mode of ["401", "403", "network"]) {
    historyMode = mode;
    const errorText = await openHistory(cdp, origin, "注文履歴を取得できません。");
    assert.match(errorText, /注文履歴/);
    assert.match(errorText, /注文履歴を取得できません。/);
  }

  assert.ok(historyRequests >= 4);
  assert.deepEqual([...new Set(historyRequestModes)], ["success", "401", "403", "network"]);
  assert.deepEqual(historyAuthorizations, Array(historyRequests).fill(`Bearer ${smokeToken}`));
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(
    failedResources.filter((entry) => !entry.url.endsWith("/v1/customer/order-history")),
    [],
  );
  console.log("Production browser smoke passed: success, 401, 403, and network failure kept the customer UI rendered.");
} finally {
  if (cdp) {
    try { await cdp.send("Browser.close"); } catch {}
    cdp.close();
  }
  if (!(await waitForChildExit(chromeProcess))) {
    chromeProcess.kill();
    await waitForChildExit(chromeProcess);
  }
  await close(server);
  await removeTemporaryProfile(profileDirectory);
}
