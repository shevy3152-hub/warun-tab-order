import assert from "node:assert/strict";
import test from "node:test";

import { accessUrls, lanIPv4Addresses } from "../src/run-server.mjs";

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
