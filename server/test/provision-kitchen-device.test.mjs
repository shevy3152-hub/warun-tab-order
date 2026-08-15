import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";
import { provisionKitchenDevice } from "../scripts/provision-kitchen-device.mjs";

test("kitchen provisioning stores only a hash and preserves protected tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warun-provision-kitchen-"));
  const databasePath = join(directory, "warun.sqlite3");
  let rawToken = "";
  try {
    const result = provisionKitchenDevice({
      databasePath,
      setEnvironment(token) { rawToken = token; },
    });

    assert.equal(result.role, "kitchen");
    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const device = database.prepare("SELECT device_id AS deviceId, role, status, token_hash AS tokenHash FROM devices").get();
      assert.equal(device.deviceId, result.deviceId);
      assert.equal(device.role, "kitchen");
      assert.equal(device.status, "active");
      assert.equal(device.tokenHash, createHash("sha256").update(rawToken, "utf8").digest("hex"));
      assert.doesNotMatch(JSON.stringify(device), new RegExp(rawToken));
      assert.equal(database.prepare("SELECT COUNT(1) AS count FROM orders").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(1) AS count FROM order_items").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(1) AS count FROM event_log").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
