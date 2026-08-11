import { createServer as createNodeServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceAuthenticator } from "./auth/device-auth.mjs";
import { createCatalogRepository } from "./catalog/catalog-repository.mjs";
import { initializeDatabase } from "./db/database.mjs";
import { createEventRepository } from "./events/event-repository.mjs";
import { createSseHub } from "./events/sse-hub.mjs";
import { createSnapshotService } from "./events/snapshot-service.mjs";
import { createHttpServer } from "./http/http-server.mjs";
import { createOrderRepository } from "./orders/order-repository.mjs";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_WEB_PORT = 5173;
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
});

export function lanIPv4Addresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((entries) => entries || [])
    .filter((entry) => entry?.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index)
    .sort();
}

export function accessUrls({ host = DEFAULT_HOST, port = DEFAULT_PORT, webPort = DEFAULT_WEB_PORT, addresses = lanIPv4Addresses() } = {}) {
  const apiUrls = [`http://127.0.0.1:${port}/v1`];
  const webUrls = [`http://127.0.0.1:${webPort}/`];
  if (host !== "127.0.0.1" && host !== "localhost") {
    for (const address of addresses) {
      apiUrls.push(`http://${address}:${port}/v1`);
      webUrls.push(`http://${address}:${webPort}/`);
    }
  }
  return { apiUrls, webUrls };
}

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

export function createWarunServer({ databasePath, now = Date.now } = {}) {
  const connection = initializeDatabase({ databasePath });
  const { database } = connection;
  const authenticator = createDeviceAuthenticator({ database });
  const catalog = createCatalogRepository({ database });
  const eventRepository = createEventRepository({ database });
  const orderRepository = createOrderRepository({ database, now });
  const snapshotService = createSnapshotService({ catalog, eventRepository });
  const sseHub = createSseHub({ eventRepository });
  const server = createHttpServer({
    database,
    authenticator,
    catalog,
    eventRepository,
    orderRepository,
    snapshotService,
    sseHub,
    now,
  });

  const closeDependencies = () => {
    sseHub.close();
    authenticator.close();
    catalog.close();
    eventRepository.close();
    orderRepository.close();
    snapshotService.close();
    connection.close();
  };

  return { server, closeDependencies, connection };
}

export function createSameOriginWebServer({ apiServer, webRoot }) {
  if (!apiServer || typeof apiServer.listeners !== "function") throw new TypeError("An API server is required.");
  const apiHandler = apiServer.listeners("request")[0];
  if (typeof apiHandler !== "function") throw new TypeError("The API server has no request handler.");
  const resolvedWebRoot = resolve(webRoot);

  return createNodeServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      apiHandler(request, response);
      return;
    }

    const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const candidate = resolve(resolvedWebRoot, requestedPath);
    const relativePath = relative(resolvedWebRoot, candidate);
    const safePath = relativePath && !relativePath.startsWith("..") && !relativePath.includes("..\\") && !relativePath.includes("../");
    const filePath = safePath ? candidate : resolve(resolvedWebRoot, "index.html");
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream" });
      response.end(body);
    } catch {
      if (filePath !== resolve(resolvedWebRoot, "index.html")) {
        try {
          const body = await readFile(resolve(resolvedWebRoot, "index.html"));
          response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": CONTENT_TYPES[".html"] });
          response.end(body);
          return;
        } catch {
          // Fall through to the generic 404 below.
        }
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function listen(server, { host, port }) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  return server.address();
}

async function main() {
  const host = process.env.WARUN_SERVER_HOST || DEFAULT_HOST;
  const port = envNumber("WARUN_SERVER_PORT", DEFAULT_PORT);
  const webPort = envNumber("WARUN_WEB_PORT", 5173);
  const databasePath = resolve(process.env.WARUN_DB_PATH || "var/warun.sqlite3");
  const application = createWarunServer({ databasePath });
  const webRoot = resolve(process.env.WARUN_WEB_ROOT || "../prototype/dist/client");
  const webServer = createSameOriginWebServer({ apiServer: application.server, webRoot });
  const address = await listen(application.server, { host, port });
  const webAddress = await listen(webServer, { host, port: webPort });
  const urls = accessUrls({ host, port: address.port, webPort: webAddress.port });

  console.log(`Warun API listening on ${host}:${address.port}`);
  console.log("PC API URL:", urls.apiUrls[0]);
  for (const url of urls.apiUrls.slice(1)) console.log("LAN API URL:", url);
  console.log("Web UI is served with the same-origin /v1 path; no API URL is entered on tablets.");
  console.log("PC Web URL:", urls.webUrls[0]);
  for (const url of urls.webUrls.slice(1)) console.log("LAN Web URL:", url);

  const shutdown = () => {
    webServer.close(() => application.server.close(() => {
      application.closeDependencies();
      process.exit(0);
    }));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error("Warun API failed to start:", error.message);
    process.exitCode = 1;
  });
}
