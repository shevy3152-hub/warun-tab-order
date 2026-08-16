import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeDatabase } from "../src/db/database.mjs";
import { createDeviceAuthenticator } from "../src/auth/device-auth.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");
const PRODUCTION_DATABASE_PATH = resolve(REPOSITORY_ROOT, "server", "var", "warun.sqlite3");
const BUSINESS_TABLES = Object.freeze([
  "devices",
  "tables",
  "pairing_codes",
  "categories",
  "menu_items",
  "orders",
  "order_items",
  "staff_calls",
  "event_log",
]);

// Reused from prototype/src/App.jsx. Keep this fixture aligned with the customer catalog.
const CATEGORIES = Object.freeze([
  { id: "recommended", name: "おすすめ", sortOrder: 1 },
  { id: "beer", name: "ビール", sortOrder: 2 },
  { id: "snack", name: "おつまみ", sortOrder: 3 },
  { id: "grill", name: "焼き物", sortOrder: 4 },
  { id: "drink", name: "ドリンク", sortOrder: 5 },
]);

const MENU_ITEMS = Object.freeze([
  { id: "edamame", categoryId: "recommended", name: "枝豆", alias: "枝豆", description: "まずは定番。シンプルな塩茹で。", priceYen: 380, isSoldOut: 0, sortOrder: 1 },
  { id: "dashimaki", categoryId: "recommended", name: "だし巻き玉子", alias: "だし巻き", description: "ふんわり出汁が香るやさしい味わい。", priceYen: 580, isSoldOut: 0, sortOrder: 2 },
  { id: "beer", categoryId: "beer", name: "生ビール", alias: "生ビール", description: "のどごし爽快。キンキンに冷えてます。", priceYen: 680, isSoldOut: 0, sortOrder: 1 },
  { id: "lemon", categoryId: "drink", name: "レモンサワー", alias: "レモンサワー", description: "すっきり爽やか。人気の定番サワー。", priceYen: 550, isSoldOut: 0, sortOrder: 1 },
  { id: "karaage", categoryId: "snack", name: "唐揚げ", alias: "唐揚げ", description: "特製ダレに漬け込んだジューシーな一品。", priceYen: 680, isSoldOut: 1, sortOrder: 1 },
  { id: "yakitori", categoryId: "grill", name: "焼き鳥（もも）", alias: "もも串", description: "香ばしく焼き上げた店の定番。", priceYen: 620, isSoldOut: 0, sortOrder: 1 },
  { id: "otoshi", categoryId: "snack", name: "お通し", alias: "お通し", description: "本日のお通し。", priceYen: 300, isSoldOut: 0, sortOrder: 2 },
]);

const TABLES = Object.freeze([1, 2, 3, 4]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function usageError(message) {
  return new Error(`${message} Usage: node server/scripts/provision-empty-db.mjs --db <absolute-path> [--allow-production]`);
}

function parseArguments(argv) {
  let databasePath = "";
  let allowProduction = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--db") {
      databasePath = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--allow-production") {
      allowProduction = true;
    } else {
      throw usageError(`Unknown argument: ${argument}`);
    }
  }
  if (!databasePath || !isAbsolute(databasePath)) throw usageError("--db must be an absolute path.");
  return { databasePath: resolve(databasePath), allowProduction };
}

function readAdminToken() {
  const token = process.env.WARUN_ADMIN_API_TOKEN?.trim() || "";
  if (!TOKEN_PATTERN.test(token)) throw new Error("WARUN_ADMIN_API_TOKEN is missing or invalid.");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== token) {
    throw new Error("WARUN_ADMIN_API_TOKEN is not a canonical device token.");
  }
  decoded.fill(0);
  return token;
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function counts(database) {
  return Object.fromEntries(BUSINESS_TABLES.map((table) => [
    table,
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
}

function assertSchema(database) {
  const version = Number(database.prepare("PRAGMA user_version").get().user_version);
  if (version !== 2) throw new Error(`Expected schema user_version=2, got ${version}.`);
}

function assertEmpty(database) {
  const existing = Object.entries(counts(database)).filter(([, count]) => count > 0);
  if (existing.length > 0) {
    throw new Error(`Refusing to provision a non-empty database: ${existing.map(([table, count]) => `${table}=${count}`).join(", ")}.`);
  }
}

function insertFixture(database, adminToken) {
  const now = Date.now();
  const adminDeviceId = randomUUID();
  const insertCategory = database.prepare(`
    INSERT INTO categories (category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 1, 1, ?, ?)
  `);
  const insertMenuItem = database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description, price_yen,
      is_sold_out, is_active, sort_order, version, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
  `);
  const insertTable = database.prepare(`
    INSERT INTO tables (table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms)
    VALUES (?, ?, NULL, 1, 1, ?, ?)
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO devices (
        device_id, role, display_name, token_hash, status, app_version,
        paired_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'admin', ?, ?, 'active', ?, ?, NULL, ?, ?)
    `).run(adminDeviceId, "店舗管理端末", tokenHash(adminToken), "provisioning", now, now, now);
    for (const category of CATEGORIES) insertCategory.run(category.id, category.name, category.sortOrder, now, now);
    for (const item of MENU_ITEMS) {
      insertMenuItem.run(
        item.id,
        item.categoryId,
        item.name,
        item.alias,
        item.description,
        item.priceYen,
        item.isSoldOut,
        item.sortOrder,
        now,
        now,
      );
    }
    for (const tableId of TABLES) insertTable.run(tableId, `テーブル ${tableId}`, now, now);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function assertAdminAuthentication(database, adminToken) {
  const authenticator = createDeviceAuthenticator({ database });
  try {
    const principal = authenticator.authenticateDeviceToken(adminToken);
    if (principal.role !== "admin") throw new Error("Provisioned device is not an admin.");
  } finally {
    authenticator.close();
  }
}

function main() {
  const { databasePath, allowProduction } = parseArguments(process.argv.slice(2));
  if (databasePath === PRODUCTION_DATABASE_PATH && !allowProduction) {
    throw new Error("Production database requires --allow-production.");
  }
  if (databasePath === PRODUCTION_DATABASE_PATH && !existsSync(databasePath)) {
    throw new Error("Production database does not exist; refusing to create it.");
  }

  let adminToken = readAdminToken();
  const connection = initializeDatabase({ databasePath });
  try {
    assertSchema(connection.database);
    assertEmpty(connection.database);
    insertFixture(connection.database, adminToken);
    assertAdminAuthentication(connection.database, adminToken);
    console.log(JSON.stringify({ status: "provisioned", databasePath, counts: counts(connection.database) }));
  } finally {
    adminToken = "";
    connection.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Provisioning failed.");
  process.exitCode = 1;
}
