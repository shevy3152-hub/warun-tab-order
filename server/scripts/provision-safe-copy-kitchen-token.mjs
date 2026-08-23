import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceAuthenticator } from "../src/auth/device-auth.mjs";
import { initializeDatabase } from "../src/db/database.mjs";
import { classifyDatabaseTarget } from "../src/runtime-info.mjs";

const SCRIPT_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");
const SAFE_COPY_ROOT = resolve(REPOSITORY_ROOT, "server", "var", "safe-copies");
const TOKEN_FILE_NAME = "kitchen-token";
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
  "table_sessions",
]);

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("The safe-copy kitchen token is invalid.");
  }
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== TOKEN_BYTES || decoded.toString("base64url") !== token) {
    decoded.fill(0);
    throw new Error("The safe-copy kitchen token is invalid.");
  }
  decoded.fill(0);
}

function canonicalTokenOrEmpty(token) {
  try {
    validateToken(token);
    return token;
  } catch {
    return "";
  }
}

function defaultSafeCopyKitchenTokenFile() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !localAppData.trim()) {
    throw new Error("The Windows local token store is not available.");
  }
  return join(localAppData, "WarunTabOrder", "safe-copy", TOKEN_FILE_NAME);
}

function assertSafeCopyDatabase(databasePath) {
  if (typeof databasePath !== "string" || !isAbsolute(databasePath)) {
    throw new Error("databasePath must be an absolute path.");
  }
  const resolvedPath = resolve(databasePath);
  const target = classifyDatabaseTarget({
    databasePath: resolvedPath,
    repositoryRoot: REPOSITORY_ROOT,
  });
  if (target !== "safe-copy") {
    throw new Error("Refusing to initialize a kitchen token outside the safe-copy database directory.");
  }
  if (!existsSync(resolvedPath)) throw new Error("The safe-copy database was not found.");
  return resolvedPath;
}

function assertAbsoluteTokenFile(tokenFilePath) {
  if (typeof tokenFilePath !== "string" || !isAbsolute(tokenFilePath)) {
    throw new Error("The safe-copy kitchen token file path must be absolute.");
  }
  return resolve(tokenFilePath);
}

function readPersistedToken(tokenFilePath, { allowMissing = false } = {}) {
  if (!existsSync(tokenFilePath)) {
    if (allowMissing) return "";
    throw new Error("The safe-copy kitchen token store is missing.");
  }
  let token;
  try {
    token = readFileSync(tokenFilePath, "utf8").trim();
  } catch {
    throw new Error("The safe-copy kitchen token store could not be read.");
  }
  validateToken(token);
  return token;
}

function persistToken(tokenFilePath, token) {
  const existed = existsSync(tokenFilePath);
  const previous = existed ? readFileSync(tokenFilePath, "utf8") : "";
  mkdirSync(dirname(tokenFilePath), { recursive: true });
  writeFileSync(tokenFilePath, token, { encoding: "utf8", mode: 0o600 });
  return { existed, previous };
}

function restorePersistedToken(tokenFilePath, snapshot) {
  if (snapshot.existed) {
    writeFileSync(tokenFilePath, snapshot.previous, { encoding: "utf8", mode: 0o600 });
  } else if (existsSync(tokenFilePath)) {
    unlinkSync(tokenFilePath);
  }
}

function tableCounts(database) {
  return Object.fromEntries(PROTECTED_TABLES.map((table) => [
    table,
    Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}

function deviceRows(database) {
  return database.prepare(`
    SELECT device_id AS deviceId, role, status, token_hash AS tokenHash
    FROM devices
    ORDER BY device_id
  `).all();
}

function getKitchenDevice(database, { allowMissing = false } = {}) {
  const devices = database.prepare(`
    SELECT device_id AS deviceId, role, status, token_hash AS tokenHash
    FROM devices
    WHERE role = 'kitchen'
    ORDER BY device_id
  `).all();
  if (allowMissing && devices.length === 0) return null;
  if (devices.length !== 1 || devices[0].role !== "kitchen" || devices[0].status !== "active") {
    throw new Error("Expected exactly one active kitchen device in the safe-copy database.");
  }
  return devices[0];
}

function verifyKitchenToken(database, token, expectedDevice) {
  const authenticator = createDeviceAuthenticator({ database });
  try {
    const principal = authenticator.authenticateDeviceToken(token);
    if (principal.role !== "kitchen" || principal.deviceId !== expectedDevice.deviceId) {
      throw new Error("The safe-copy kitchen token verification failed.");
    }
  } finally {
    authenticator.close();
  }
}

function assertProtectedCounts(before, after) {
  for (const table of PROTECTED_TABLES) {
    if (after[table] !== before[table]) throw new Error(`Protected table changed: ${table}.`);
  }
}

function assertDeviceRowsUnchangedExceptToken(before, after, deviceId, expectedHash, { added = false } = {}) {
  if (after.length !== before.length + (added ? 1 : 0)) throw new Error("The safe-copy device count changed unexpectedly.");
  const afterById = new Map(after.map((row) => [row.deviceId, row]));
  for (const beforeRow of before) {
    const afterRow = afterById.get(beforeRow.deviceId);
    if (!afterRow) throw new Error("A safe-copy device disappeared unexpectedly.");
    if (beforeRow.deviceId !== afterRow.deviceId || beforeRow.role !== afterRow.role || beforeRow.status !== afterRow.status) {
      throw new Error("A safe-copy device role or status changed unexpectedly.");
    }
    if (afterRow.deviceId === deviceId) {
      if (afterRow.tokenHash !== expectedHash) throw new Error("The safe-copy kitchen token hash was not stored.");
    } else if (beforeRow.tokenHash !== afterRow.tokenHash) {
      throw new Error("A non-target safe-copy device token hash changed unexpectedly.");
    }
  }
  const target = afterById.get(deviceId);
  if (!target || target.role !== "kitchen" || target.status !== "active" || target.tokenHash !== expectedHash) {
    throw new Error("The safe-copy kitchen device was not provisioned as active.");
  }
}

export function checkSafeCopyKitchenToken({ databasePath, tokenFilePath = undefined } = {}) {
  const resolvedPath = assertSafeCopyDatabase(databasePath);
  const resolvedTokenFilePath = assertAbsoluteTokenFile(tokenFilePath || defaultSafeCopyKitchenTokenFile());
  const token = readPersistedToken(resolvedTokenFilePath);
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    const kitchen = getKitchenDevice(database);
    if (kitchen.tokenHash !== tokenHash(token)) throw new Error("The safe-copy kitchen token is not synchronized with the database.");
    verifyKitchenToken(database, token, kitchen);
    return Object.freeze({ status: "verified", databasePath: resolvedPath });
  } finally {
    database.close();
  }
}

export function ensureSafeCopyKitchenToken({ databasePath, tokenFilePath = undefined, randomToken = undefined, randomDeviceId = randomUUID } = {}) {
  const resolvedPath = assertSafeCopyDatabase(databasePath);
  const resolvedTokenFilePath = assertAbsoluteTokenFile(tokenFilePath || defaultSafeCopyKitchenTokenFile());
  const connection = initializeDatabase({ databasePath: resolvedPath });
  let token = "";
  let previousTokenFile;
  let tokenFileChanged = false;
  let committed = false;
  try {
    const kitchen = getKitchenDevice(connection.database, { allowMissing: true });
    const persistedToken = readPersistedToken(resolvedTokenFilePath, { allowMissing: true });
    if (kitchen && persistedToken && kitchen.tokenHash === tokenHash(persistedToken)) {
      verifyKitchenToken(connection.database, persistedToken, kitchen);
      return Object.freeze({ status: "reused", databasePath: resolvedPath });
    }

    token = typeof randomToken === "function" ? randomToken() : randomBytes(TOKEN_BYTES).toString("base64url");
    validateToken(token);
    const beforeCounts = tableCounts(connection.database);
    const beforeDevices = deviceRows(connection.database);
    connection.database.exec("BEGIN IMMEDIATE");
    try {
      const targetDeviceId = kitchen?.deviceId || randomDeviceId();
      if (typeof targetDeviceId !== "string" || targetDeviceId.length === 0) throw new Error("The safe-copy kitchen device id could not be provisioned.");
      if (kitchen) {
        const updated = connection.database.prepare(`
          UPDATE devices
          SET token_hash = ?, updated_at_ms = ?
          WHERE device_id = ? AND role = 'kitchen' AND status = 'active'
        `).run(tokenHash(token), Date.now(), targetDeviceId);
        if (updated.changes !== 1) throw new Error("The safe-copy kitchen device could not be updated.");
      } else {
        connection.database.prepare(`
          INSERT INTO devices (
            device_id, role, display_name, token_hash, status, app_version,
            paired_at_ms, last_seen_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, 'kitchen', 'Safe-copy kitchen', ?, 'active', 'safe-copy', ?, NULL, NULL, ?, ?)
        `).run(targetDeviceId, tokenHash(token), Date.now(), Date.now(), Date.now());
      }
      previousTokenFile = persistToken(resolvedTokenFilePath, token);
      tokenFileChanged = true;
      verifyKitchenToken(connection.database, token, { deviceId: targetDeviceId });
      connection.database.exec("COMMIT");
      committed = true;
    } catch (error) {
      try { connection.database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    const afterCounts = tableCounts(connection.database);
    assertProtectedCounts(beforeCounts, afterCounts);
    assertDeviceRowsUnchangedExceptToken(beforeDevices, deviceRows(connection.database), kitchen?.deviceId || deviceRows(connection.database).find((row) => row.role === "kitchen" && row.status === "active")?.deviceId, tokenHash(token), { added: kitchen === null });
    return Object.freeze({ status: "provisioned", databasePath: resolvedPath });
  } catch (error) {
    if (tokenFileChanged && !committed) {
      try { restorePersistedToken(resolvedTokenFilePath, previousTokenFile); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  } finally {
    token = "";
    connection.close();
  }
}

export function backupSafeCopyDatabase({ databasePath, backupPath } = {}) {
  const resolvedPath = assertSafeCopyDatabase(databasePath);
  const resolvedBackupPath = assertAbsoluteTokenFile(backupPath);
  if (resolvedPath === resolvedBackupPath) throw new Error("The safe-copy backup path must differ from the database path.");
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    const bytes = database.serialize();
    mkdirSync(dirname(resolvedBackupPath), { recursive: true });
    writeFileSync(resolvedBackupPath, bytes, { mode: 0o600 });
    return Object.freeze({ status: "backed-up", databasePath: resolvedPath, backupPath: resolvedBackupPath });
  } finally {
    database.close();
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--db", "--token-file", "--backup", "--mode"].includes(key) || typeof value !== "string") {
      throw new Error("Usage: node server/scripts/provision-safe-copy-kitchen-token.mjs --mode <check|ensure|backup> --db <absolute-safe-copy-path> [--token-file <absolute-path>] [--backup <absolute-path>]");
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.db || !isAbsolute(options.db)) throw new Error("The safe-copy database path must be absolute.");
  if (!options.mode || !["check", "ensure", "backup"].includes(options.mode)) throw new Error("The safe-copy kitchen token mode is invalid.");
  return options;
}

if (process.argv[1] && process.argv[1].endsWith("provision-safe-copy-kitchen-token.mjs")) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === "check") {
      checkSafeCopyKitchenToken({ databasePath: options.db, tokenFilePath: options.tokenFile });
      console.log("Safe-copy kitchen token check passed. The plaintext token was not printed.");
    } else if (options.mode === "backup") {
      if (!options.backup || !isAbsolute(options.backup)) throw new Error("The safe-copy backup path must be absolute.");
      backupSafeCopyDatabase({ databasePath: options.db, backupPath: options.backup });
      console.log("Safe-copy database backup completed. Token and order contents were not printed.");
    } else {
      const result = ensureSafeCopyKitchenToken({ databasePath: options.db, tokenFilePath: options.tokenFile });
      console.log(`Safe-copy kitchen token ${result.status}. The plaintext token was not printed.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Safe-copy kitchen token operation failed.");
    process.exitCode = 1;
  }
}
