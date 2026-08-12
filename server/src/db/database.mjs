import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;
export const LEGACY_SCHEMA_VERSION = 1;

export const REQUIRED_TABLES = Object.freeze([
  'system_state',
  'devices',
  'tables',
  'pairing_codes',
  'categories',
  'menu_items',
  'orders',
  'order_items',
  'staff_calls',
  'event_log',
  'registration_requests',
]);

export const REQUIRED_INDEXES = Object.freeze([
  'idx_devices_status_role',
  'idx_pairing_codes_expiry_unused',
  'idx_categories_visible_sort',
  'idx_menu_items_category_sort',
  'idx_menu_items_sold_out',
  'idx_orders_status_accepted',
  'idx_orders_table_status',
  'idx_orders_customer_device',
  'idx_order_items_order_served',
  'uq_order_items_order_menu',
  'idx_staff_calls_status_created',
  'idx_staff_calls_table_status',
  'idx_event_log_type_event',
  'idx_event_log_aggregate',
  'idx_registration_requests_status_expiry',
  'uq_registration_requests_approved_table',
]);

export const REQUIRED_TRIGGERS = Object.freeze([
  'trg_tables_assignment_insert_valid',
  'trg_tables_assignment_update_valid',
  'trg_orders_server_assignment_insert',
  'trg_staff_calls_server_assignment_insert',
  'trg_event_log_current_epoch',
  'trg_orders_immutable_identity',
  'trg_order_items_immutable_snapshots',
  'trg_completed_order_items_read_only',
  'trg_staff_calls_immutable_origin',
]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCHEMA_PATH = resolve(
  moduleDirectory,
  '..',
  '..',
  '..',
  'docs',
  'schema-v1.sql',
);
export const DEFAULT_MIGRATION_V2_PATH = resolve(
  moduleDirectory,
  '..',
  '..',
  '..',
  'docs',
  'schema-v2.sql',
);

export class DatabaseInitializationError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'DatabaseInitializationError';
    this.code = code;
  }
}

function resolveFilePath(filePath, label) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new DatabaseInitializationError(
      'INVALID_PATH',
      `${label} must be a non-empty file path.`,
    );
  }

  return isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
}

function pragmaValue(database, pragmaName) {
  const row = database.prepare(`PRAGMA ${pragmaName}`).get();
  return row ? Object.values(row)[0] : undefined;
}

function configureConnectionPragmas(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
  `);
}

function enableWriteAheadLogging(database) {
  database.exec('PRAGMA journal_mode = WAL;');
}

function userTableNames(database) {
  return database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
}

function schemaObjectNames(database, type) {
  return new Set(
    database
      .prepare('SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name')
      .all(type)
      .map(({ name }) => name),
  );
}

function assertRequiredNames(actualNames, requiredNames, objectType) {
  const missingNames = requiredNames.filter((name) => !actualNames.has(name));
  if (missingNames.length > 0) {
    throw new DatabaseInitializationError(
      'SCHEMA_INCOMPLETE',
      `Schema v${SCHEMA_VERSION} is missing required ${objectType}: ${missingNames.join(', ')}`,
    );
  }
}

function validateSchema(database, { version = SCHEMA_VERSION } = {}) {
  const requiredTables = version === LEGACY_SCHEMA_VERSION
    ? REQUIRED_TABLES.filter((name) => name !== 'registration_requests')
    : REQUIRED_TABLES;
  const requiredIndexes = version === LEGACY_SCHEMA_VERSION
    ? REQUIRED_INDEXES.filter((name) => !name.startsWith('idx_registration_requests') && name !== 'uq_registration_requests_approved_table')
    : REQUIRED_INDEXES;
  assertRequiredNames(schemaObjectNames(database, 'table'), requiredTables, 'tables');
  assertRequiredNames(schemaObjectNames(database, 'index'), requiredIndexes, 'indexes');
  assertRequiredNames(schemaObjectNames(database, 'trigger'), REQUIRED_TRIGGERS, 'triggers');

  const state = database
    .prepare(`
      SELECT schema_version, event_epoch
      FROM system_state
      WHERE singleton_id = 1
    `)
    .get();

  if (
    state?.schema_version !== version
    || typeof state?.event_epoch !== 'string'
    || state.event_epoch.length !== 36
  ) {
    throw new DatabaseInitializationError(
      'SCHEMA_INCOMPLETE',
      'Schema v2 system_state metadata is missing or invalid.',
    );
  }

  const integrityRows = database.prepare('PRAGMA quick_check').all();
  const integrityMessages = integrityRows.map((row) => String(Object.values(row)[0]));
  if (integrityMessages.length !== 1 || integrityMessages[0].toLowerCase() !== 'ok') {
    throw new DatabaseInitializationError(
      'DATABASE_CORRUPT',
      `SQLite quick_check failed: ${integrityMessages.join('; ')}`,
    );
  }
}

function validatePragmas(database) {
  const actual = {
    foreignKeys: Number(pragmaValue(database, 'foreign_keys')),
    busyTimeout: Number(pragmaValue(database, 'busy_timeout')),
    journalMode: String(pragmaValue(database, 'journal_mode')).toLowerCase(),
    synchronous: Number(pragmaValue(database, 'synchronous')),
  };

  const expected = {
    foreignKeys: 1,
    busyTimeout: 5000,
    journalMode: 'wal',
    synchronous: 2,
  };

  const failures = Object.entries(expected)
    .filter(([name, value]) => actual[name] !== value)
    .map(([name, value]) => `${name}=${actual[name]} (expected ${value})`);

  if (failures.length > 0) {
    throw new DatabaseInitializationError(
      'PRAGMA_MISMATCH',
      `SQLite connection PRAGMA verification failed: ${failures.join(', ')}`,
    );
  }
}

function safelyClose(database) {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // No transaction was active. Closing is still required.
  }

  try {
    database.close();
  } catch {
    // Preserve the initialization error that caused cleanup.
  }
}

function migrateV1ToV2(database, migrationPath) {
  const migrationSql = readFileSync(migrationPath, 'utf8');
  database.exec(migrationSql);
}

export function initializeDatabase({ databasePath, schemaPath = DEFAULT_SCHEMA_PATH, migrationV2Path = DEFAULT_MIGRATION_V2_PATH } = {}) {
  const resolvedDatabasePath = resolveFilePath(databasePath, 'databasePath');
  const resolvedSchemaPath = resolveFilePath(schemaPath, 'schemaPath');
  const resolvedMigrationV2Path = resolveFilePath(migrationV2Path, 'migrationV2Path');

  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });

  let database;
  try {
    database = new DatabaseSync(resolvedDatabasePath);
    configureConnectionPragmas(database);

    const currentVersion = Number(pragmaValue(database, 'user_version'));
    const tables = userTableNames(database);

    if (currentVersion === 0 && tables.length === 0) {
      enableWriteAheadLogging(database);
      const schemaSql = readFileSync(resolvedSchemaPath, 'utf8');
      database.exec(schemaSql);
      migrateV1ToV2(database, resolvedMigrationV2Path);
    } else if (currentVersion === LEGACY_SCHEMA_VERSION) {
      validateSchema(database, { version: LEGACY_SCHEMA_VERSION });
      migrateV1ToV2(database, resolvedMigrationV2Path);
    } else if (currentVersion === SCHEMA_VERSION) {
      validateSchema(database);
      enableWriteAheadLogging(database);
    } else if (currentVersion === 0) {
      throw new DatabaseInitializationError(
        'UNVERSIONED_DATABASE',
        `Refusing to initialize an unversioned database containing tables: ${tables.join(', ')}`,
      );
    } else {
      throw new DatabaseInitializationError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported SQLite schema version ${currentVersion}; expected ${LEGACY_SCHEMA_VERSION} or ${SCHEMA_VERSION}.`,
      );
    }

    configureConnectionPragmas(database);

    const appliedVersion = Number(pragmaValue(database, 'user_version'));
    if (appliedVersion !== SCHEMA_VERSION) {
      throw new DatabaseInitializationError(
        'SCHEMA_VERSION_MISMATCH',
        `SQLite schema initialization produced version ${appliedVersion}; expected ${SCHEMA_VERSION}.`,
      );
    }

    validateSchema(database);
    validatePragmas(database);
  } catch (error) {
    if (database) {
      safelyClose(database);
    }

    if (error instanceof DatabaseInitializationError) {
      throw error;
    }

    throw new DatabaseInitializationError(
      'INITIALIZATION_FAILED',
      `Failed to initialize SQLite database at ${resolvedDatabasePath}: ${error.message}`,
      { cause: error },
    );
  }

  let isClosed = false;
  return Object.freeze({
    database,
    databasePath: resolvedDatabasePath,
    schemaVersion: SCHEMA_VERSION,
    close() {
      if (!isClosed) {
        database.close();
        isClosed = true;
      }
    },
  });
}
