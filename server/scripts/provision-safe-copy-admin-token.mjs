import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceAuthenticator } from "../src/auth/device-auth.mjs";
import { initializeDatabase } from "../src/db/database.mjs";
import { classifyDatabaseTarget } from "../src/runtime-info.mjs";

const SCRIPT_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");
const SAFE_COPY_ROOT = resolve(REPOSITORY_ROOT, "server", "var", "safe-copies");
const TOKEN_ENV_NAME = "WARUN_ADMIN_API_TOKEN";
const TOKEN_FILE_NAME = "admin-token";
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

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertSafeCopyDatabase(databasePath) {
  if (typeof databasePath !== "string" || !isAbsolute(databasePath)) throw new Error("databasePath must be an absolute path.");
  const resolvedPath = resolve(databasePath);
  const target = classifyDatabaseTarget({ databasePath: resolvedPath, repositoryRoot: REPOSITORY_ROOT });
  if (target !== "safe-copy") throw new Error("Refusing to initialize an admin token outside the safe-copy database directory.");
  if (!existsSync(resolvedPath)) throw new Error("The safe-copy database was not found.");
  return resolvedPath;
}

function validateToken(token) {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Generated admin token was not canonical.");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== TOKEN_BYTES || decoded.toString("base64url") !== token) throw new Error("Generated admin token was not canonical.");
  decoded.fill(0);
}

function defaultSafeCopyAdminTokenFile() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !localAppData.trim()) throw new Error("The Windows local token store is not available.");
  return join(localAppData, "WarunTabOrder", "safe-copy", TOKEN_FILE_NAME);
}

function canonicalTokenOrEmpty(token) {
  try {
    validateToken(token);
    return token;
  } catch {
    return "";
  }
}

function readPersistedToken(tokenFilePath) {
  if (!existsSync(tokenFilePath)) return "";
  let token;
  try {
    token = readFileSync(tokenFilePath, "utf8").trim();
  } catch {
    throw new Error("The safe-copy admin token file could not be read.");
  }
  if (!canonicalTokenOrEmpty(token)) throw new Error("The safe-copy admin token file is invalid.");
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
  if (snapshot.existed) writeFileSync(tokenFilePath, snapshot.previous, { encoding: "utf8", mode: 0o600 });
  else if (existsSync(tokenFilePath)) unlinkSync(tokenFilePath);
}

function runEnvironmentCommand(script, token = "") {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WARUN_ADMIN_PROVISION_TOKEN: token },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("Could not update the Windows User environment token.");
  return result.stdout.trim();
}

function readUserEnvironmentToken() {
  if (process.platform !== "win32") return "";
  return runEnvironmentCommand(`[Environment]::GetEnvironmentVariable('${TOKEN_ENV_NAME}','User')`);
}

function setUserEnvironmentToken(token) {
  if (process.platform !== "win32") throw new Error("Windows User environment provisioning requires Windows.");
  runEnvironmentCommand(
    `$value=$env:WARUN_ADMIN_PROVISION_TOKEN; if($value.Length -ne 43){exit 3}; [Environment]::SetEnvironmentVariable('${TOKEN_ENV_NAME}',$value,'User')`,
    token,
  );
}

function restoreUserEnvironmentToken(token) {
  if (process.platform !== "win32") return;
  runEnvironmentCommand(`[Environment]::SetEnvironmentVariable('${TOKEN_ENV_NAME}',$env:WARUN_ADMIN_PROVISION_TOKEN,'User')`, token);
}

function tableCounts(database) {
  return Object.fromEntries(PROTECTED_TABLES.map((table) => [
    table,
    Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}

export function provisionSafeCopyAdminToken({ databasePath, tokenFilePath = undefined, setEnvironment = setUserEnvironmentToken, readEnvironment = readUserEnvironmentToken, restoreEnvironment = restoreUserEnvironmentToken } = {}) {
  const resolvedPath = assertSafeCopyDatabase(databasePath);
  const resolvedTokenFilePath = tokenFilePath || defaultSafeCopyAdminTokenFile();
  if (!isAbsolute(resolvedTokenFilePath)) throw new Error("The safe-copy admin token file path must be absolute.");
  const connection = initializeDatabase({ databasePath: resolvedPath });
  let token = "";
  let previousToken = "";
  let environmentChanged = false;
  let tokenFileChanged = false;
  let previousTokenFile;
  let committed = false;
  try {
    previousToken = readEnvironment();
    if (typeof previousToken !== "string") throw new Error("The existing Windows User environment token could not be read.");
    token = readPersistedToken(resolvedTokenFilePath) || canonicalTokenOrEmpty(previousToken) || randomBytes(TOKEN_BYTES).toString("base64url");
    validateToken(token);
    const admin = connection.database.prepare(`
      SELECT device_id AS deviceId
      FROM devices
      WHERE role = 'admin' AND status = 'active'
      ORDER BY device_id
    `).all();
    if (admin.length !== 1) throw new Error("Expected exactly one active admin device in the safe-copy database.");
    const before = tableCounts(connection.database);
    connection.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = connection.database.prepare(`
        UPDATE devices
        SET token_hash = ?, updated_at_ms = ?
        WHERE device_id = ? AND role = 'admin' AND status = 'active'
      `).run(tokenHash(token), Date.now(), admin[0].deviceId);
      if (updated.changes !== 1) throw new Error("The safe-copy admin device could not be updated.");
      previousTokenFile = persistToken(resolvedTokenFilePath, token);
      tokenFileChanged = true;
      setEnvironment(token);
      environmentChanged = true;
      const authenticator = createDeviceAuthenticator({ database: connection.database });
      try {
        const principal = authenticator.authenticateDeviceToken(token);
        if (principal.role !== "admin" || principal.deviceId !== admin[0].deviceId) throw new Error("The safe-copy admin token verification failed.");
      } finally {
        authenticator.close();
      }
      connection.database.exec("COMMIT");
      committed = true;
    } catch (error) {
      try { connection.database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    const after = tableCounts(connection.database);
    for (const table of PROTECTED_TABLES) {
      if (after[table] !== before[table]) throw new Error(`Protected table changed: ${table}.`);
    }
    return Object.freeze({ status: "initialized", databasePath: resolvedPath, adminDeviceId: admin[0].deviceId });
  } catch (error) {
    if (tokenFileChanged && !committed) {
      try { restorePersistedToken(resolvedTokenFilePath, previousTokenFile); } catch { /* Preserve the original failure. */ }
    }
    if (environmentChanged && !committed) {
      try { restoreEnvironment(previousToken); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  } finally {
    token = "";
    previousToken = "";
    connection.close();
  }
}

function parseDatabasePath(argv) {
  if (argv.length !== 2 || argv[0] !== "--db" || !isAbsolute(argv[1])) {
    throw new Error("Usage: node server/scripts/provision-safe-copy-admin-token.mjs --db <absolute-safe-copy-path>");
  }
  return argv[1];
}

if (process.argv[1] && process.argv[1].endsWith("provision-safe-copy-admin-token.mjs")) {
  try {
    provisionSafeCopyAdminToken({ databasePath: parseDatabasePath(process.argv.slice(2)) });
    console.log("Safe-copy admin token initialized. The plaintext token was not printed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Safe-copy admin token initialization failed.");
    process.exitCode = 1;
  }
}
