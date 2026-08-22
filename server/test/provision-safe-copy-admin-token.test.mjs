import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { provisionSafeCopyAdminToken } from "../scripts/provision-safe-copy-admin-token.mjs";
import { initializeDatabase } from "../src/db/database.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SAFE_COPY_ROOT = resolve(REPOSITORY_ROOT, "server", "var", "safe-copies");
const ADMIN_DEVICE_ID = "00000000-0000-4000-8000-000000009999";
const OLD_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function hash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function makeSafeCopyFixture() {
  const directory = await mkdtemp(join(SAFE_COPY_ROOT, "admin-token-test-"));
  const databasePath = join(directory, "fixture.sqlite3");
  const connection = initializeDatabase({ databasePath });
  connection.database.prepare(`
    INSERT INTO devices (device_id, role, display_name, token_hash, status, app_version, paired_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, 'admin', 'Fixture admin', ?, 'active', 'test', 1, 1, 1)
  `).run(ADMIN_DEVICE_ID, hash(OLD_TOKEN));
  connection.database.prepare(`
    INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms)
    VALUES (4, 'Fixture table 4', NULL, 1, 1, 1, 1)
  `).run();
  connection.close();
  return { directory, databasePath };
}

test("safe-copy admin token provisioning stores only a hash and preserves protected rows", async () => {
  const fixture = await makeSafeCopyFixture();
  let rawToken = "";
  try {
    const result = provisionSafeCopyAdminToken({
      databasePath: fixture.databasePath,
      tokenFilePath: join(fixture.directory, "admin-token"),
      readEnvironment: () => "",
      setEnvironment(token) { rawToken = token; },
    });
    assert.equal(result.status, "initialized");
    assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const device = database.prepare("SELECT role, status, token_hash AS tokenHash FROM devices WHERE device_id = ?").get(ADMIN_DEVICE_ID);
      assert.equal(device.role, "admin");
      assert.equal(device.status, "active");
      assert.equal(device.tokenHash, hash(rawToken));
      assert.doesNotMatch(JSON.stringify(device), new RegExp(rawToken));
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tables").get().count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_log").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("safe-copy admin token provisioning rolls back when environment update fails", async () => {
  const fixture = await makeSafeCopyFixture();
  try {
    assert.throws(() => provisionSafeCopyAdminToken({
      databasePath: fixture.databasePath,
      tokenFilePath: join(fixture.directory, "admin-token"),
      readEnvironment: () => "",
      setEnvironment() { throw new Error("environment unavailable"); },
    }), /environment unavailable/);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT token_hash FROM devices WHERE device_id = ?").get(ADMIN_DEVICE_ID).token_hash, hash(OLD_TOKEN));
    } finally {
      database.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("safe-copy admin token provisioning reuses the local token file", async () => {
  const fixture = await makeSafeCopyFixture();
  const tokenFilePath = join(fixture.directory, "admin-token");
  let firstToken = "";
  let secondToken = "";
  try {
    provisionSafeCopyAdminToken({
      databasePath: fixture.databasePath,
      tokenFilePath,
      readEnvironment: () => "",
      setEnvironment(token) { firstToken = token; },
    });
    provisionSafeCopyAdminToken({
      databasePath: fixture.databasePath,
      tokenFilePath,
      readEnvironment: () => "stale-runtime-token",
      setEnvironment(token) { secondToken = token; },
    });
    assert.equal(secondToken, firstToken);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("safe-copy admin token provisioning refuses the production path", () => {
  assert.throws(() => provisionSafeCopyAdminToken({ databasePath: resolve(REPOSITORY_ROOT, "server", "var", "warun.sqlite3") }), /safe-copy database directory/);
});
