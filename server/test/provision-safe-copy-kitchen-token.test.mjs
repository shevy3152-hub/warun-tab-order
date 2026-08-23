import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import {
  backupSafeCopyDatabase,
  checkSafeCopyKitchenToken,
  ensureSafeCopyKitchenToken,
} from "../scripts/provision-safe-copy-kitchen-token.mjs";
import { initializeDatabase } from "../src/db/database.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SAFE_COPY_ROOT = resolve(REPOSITORY_ROOT, "server", "var", "safe-copies");
const KITCHEN_DEVICE_ID = "00000000-0000-4000-8000-000000008888";
const OLD_TOKEN = randomBytes(32).toString("base64url");
const NEW_TOKEN = randomBytes(32).toString("base64url");

function hash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function makeSafeCopyFixture() {
  const directory = await mkdtemp(join(SAFE_COPY_ROOT, "kitchen-token-test-"));
  const databasePath = join(directory, "fixture.sqlite3");
  const connection = initializeDatabase({ databasePath });
  connection.database.prepare(`
    INSERT INTO devices (device_id, role, display_name, token_hash, status, app_version, paired_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, 'kitchen', 'Fixture kitchen', ?, 'active', 'test', 1, 1, 1)
  `).run(KITCHEN_DEVICE_ID, hash(OLD_TOKEN));
  connection.database.prepare(`
    INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms)
    VALUES (4, 'Fixture table 4', NULL, 1, 1, 1, 1)
  `).run();
  connection.close();
  return { directory, databasePath, tokenFilePath: join(directory, "kitchen-token") };
}

test("kitchen token persists across a restart boundary and only the DB hash is stored", async () => {
  const fixture = await makeSafeCopyFixture();
  try {
    const first = ensureSafeCopyKitchenToken({
      databasePath: fixture.databasePath,
      tokenFilePath: fixture.tokenFilePath,
      randomToken: () => NEW_TOKEN,
    });
    assert.equal(first.status, "provisioned");
    assert.equal(readFileSync(fixture.tokenFilePath, "utf8"), NEW_TOKEN);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(NEW_TOKEN));

    // A new read-only connection models the next process after a restart.
    const afterRestart = checkSafeCopyKitchenToken({
      databasePath: fixture.databasePath,
      tokenFilePath: fixture.tokenFilePath,
    });
    assert.equal(afterRestart.status, "verified");

    const reused = ensureSafeCopyKitchenToken({
      databasePath: fixture.databasePath,
      tokenFilePath: fixture.tokenFilePath,
      randomToken: () => OLD_TOKEN,
    });
    assert.equal(reused.status, "reused");

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const device = database.prepare("SELECT role, status, token_hash AS tokenHash FROM devices WHERE device_id = ?").get(KITCHEN_DEVICE_ID);
      assert.equal(device.role, "kitchen");
      assert.equal(device.status, "active");
      assert.equal(device.tokenHash, hash(NEW_TOKEN));
      assert.doesNotMatch(JSON.stringify(device), new RegExp(NEW_TOKEN));
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tables").get().count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_log").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a mismatched kitchen token fails the read-only startup check and is explicitly provisioned", async () => {
  const fixture = await makeSafeCopyFixture();
  try {
    await writeFile(fixture.tokenFilePath, NEW_TOKEN, "utf8");
    assert.throws(
      () => checkSafeCopyKitchenToken({ databasePath: fixture.databasePath, tokenFilePath: fixture.tokenFilePath }),
      /not synchronized/,
    );

    const provisioned = ensureSafeCopyKitchenToken({
      databasePath: fixture.databasePath,
      tokenFilePath: fixture.tokenFilePath,
      randomToken: () => NEW_TOKEN,
    });
    assert.equal(provisioned.status, "provisioned");
    assert.equal(checkSafeCopyKitchenToken({ databasePath: fixture.databasePath, tokenFilePath: fixture.tokenFilePath }).status, "verified");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("missing kitchen device is created only by explicit safe-copy provisioning", async () => {
  const directory = await mkdtemp(join(SAFE_COPY_ROOT, "kitchen-device-provision-test-"));
  const databasePath = join(directory, "fixture.sqlite3");
  const tokenFilePath = join(directory, "kitchen-token");
  const connection = initializeDatabase({ databasePath });
  connection.close();
  try {
    const result = ensureSafeCopyKitchenToken({
      databasePath,
      tokenFilePath,
      randomToken: () => NEW_TOKEN,
      randomDeviceId: () => KITCHEN_DEVICE_ID,
    });
    assert.equal(result.status, "provisioned");
    assert.equal(checkSafeCopyKitchenToken({ databasePath, tokenFilePath }).status, "verified");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const devices = database.prepare("SELECT role,status FROM devices").all();
      assert.equal(devices.length, 1);
      assert.equal(devices[0].role, "kitchen");
      assert.equal(devices[0].status, "active");
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe-copy backup serializes the selected DB without touching production", async () => {
  const fixture = await makeSafeCopyFixture();
  const backupPath = join(fixture.directory, "before-kitchen-token.sqlite3");
  try {
    const result = backupSafeCopyDatabase({ databasePath: fixture.databasePath, backupPath });
    assert.equal(result.status, "backed-up");
    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM tables").get().count, 1);
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
    } finally {
      backup.close();
    }
    assert.throws(
      () => backupSafeCopyDatabase({
        databasePath: resolve(REPOSITORY_ROOT, "server", "var", "warun.sqlite3"),
        backupPath,
      }),
      /safe-copy database directory/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
