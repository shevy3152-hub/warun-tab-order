import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { initializeDatabase } from "../src/db/database.mjs";

const TOKEN_ENV_NAME = "WARUN_KITCHEN_API_TOKEN";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROTECTED_TABLES = Object.freeze([
  "tables",
  "pairing_codes",
  "categories",
  "menu_items",
  "orders",
  "order_items",
  "staff_calls",
  "event_log",
]);

function usageError(message) {
  return new Error(`${message} Usage: node server/scripts/provision-kitchen-device.mjs --db <absolute-path>`);
}

function parseArguments(argv) {
  let databasePath = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--db") throw usageError(`Unknown argument: ${argv[index]}`);
    databasePath = argv[index + 1] || "";
    index += 1;
  }
  if (!databasePath || !isAbsolute(databasePath)) throw usageError("--db must be an absolute path.");
  return resolve(databasePath);
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tableCounts(database) {
  return Object.fromEntries(PROTECTED_TABLES.map((table) => [
    table,
    database.prepare(`SELECT COUNT(1) AS count FROM ${table}`).get().count,
  ]));
}

function setUserEnvironmentToken(token) {
  if (process.platform !== "win32") throw new Error("User environment provisioning requires Windows.");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$existing=[Environment]::GetEnvironmentVariable('${TOKEN_ENV_NAME}','User')`,
    "if(-not [string]::IsNullOrWhiteSpace($existing)){exit 2}",
    `$value=$env:WARUN_KITCHEN_PROVISION_TOKEN`,
    "if($value.Length -eq 0){exit 3}",
    `[Environment]::SetEnvironmentVariable('${TOKEN_ENV_NAME}',$value,'User')`,
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WARUN_KITCHEN_PROVISION_TOKEN: token },
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.status !== 0) throw new Error("Could not set the Windows User environment variable.");
}

function clearUserEnvironmentToken(token) {
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='Stop'",
    `$existing=[Environment]::GetEnvironmentVariable('${TOKEN_ENV_NAME}','User')`,
    "$value=$env:WARUN_KITCHEN_PROVISION_TOKEN",
    `if($existing -eq $value){[Environment]::SetEnvironmentVariable('${TOKEN_ENV_NAME}',$null,'User')}`,
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WARUN_KITCHEN_PROVISION_TOKEN: token },
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export function provisionKitchenDevice({ databasePath, displayName = "厨房端末", setEnvironment = setUserEnvironmentToken } = {}) {
  if (typeof databasePath !== "string" || !isAbsolute(databasePath)) throw usageError("databasePath must be an absolute path.");
  const connection = initializeDatabase({ databasePath: resolve(databasePath) });
  let token = randomBytes(TOKEN_BYTES).toString("base64url");
  const deviceId = randomUUID();
  let environmentSet = false;
  let committed = false;
  const before = tableCounts(connection.database);
  try {
    if (!TOKEN_PATTERN.test(token)) throw new Error("Generated token was not canonical.");
    connection.database.exec("BEGIN IMMEDIATE");
    const now = Date.now();
    connection.database.prepare(`
      INSERT INTO devices (
        device_id, role, display_name, token_hash, status, app_version,
        paired_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'kitchen', ?, ?, 'active', ?, ?, NULL, ?, ?)
    `).run(deviceId, displayName, tokenHash(token), "provisioning", now, now, now);
    setEnvironment(token);
    environmentSet = true;
    connection.database.exec("COMMIT");
    committed = true;
    const after = tableCounts(connection.database);
    for (const table of PROTECTED_TABLES) {
      if (after[table] !== before[table]) throw new Error(`Protected table changed: ${table}.`);
    }
    return { deviceId, role: "kitchen" };
  } catch (error) {
    if (!committed) {
      try { connection.database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    }
    if (environmentSet && !committed) clearUserEnvironmentToken(token);
    throw error;
  } finally {
    token = "";
    connection.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith("provision-kitchen-device.mjs")) {
  try {
    const result = provisionKitchenDevice({ databasePath: parseArguments(process.argv.slice(2)) });
    console.log(`Provisioned ${result.role} device. Token was stored only as a hash in SQLite and in the Windows User environment.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Kitchen device provisioning failed.");
    process.exitCode = 1;
  }
}
