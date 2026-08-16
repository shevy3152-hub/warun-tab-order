import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const LEGACY_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;

export const REQUIRED_TABLES = Object.freeze([
  'system_state',
  'devices',
  'tables',
  'table_sessions',
  'pairing_codes',
  'categories',
  'menu_items',
  'orders',
  'order_items',
  'staff_calls',
  'event_log',
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
  'idx_table_sessions_table_opened',
  'uq_table_sessions_open_table',
  'idx_order_items_order_served',
  'uq_order_items_order_menu',
  'idx_staff_calls_status_created',
  'idx_staff_calls_table_status',
  'idx_event_log_type_event',
  'idx_event_log_aggregate',
]);

export const REQUIRED_TRIGGERS = Object.freeze([
  'trg_tables_assignment_insert_valid',
  'trg_tables_assignment_update_valid',
  'trg_orders_server_assignment_insert',
  'trg_orders_session_valid_insert',
  'trg_orders_session_immutable',
  'trg_table_sessions_immutable_origin',
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

function tableColumns(database, tableName) {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map(({ name }) => name),
  );
}

function hasSessionExtension(database) {
  const hasTable = schemaObjectNames(database, 'table').has('table_sessions');
  const hasColumn = tableColumns(database, 'orders').has('session_id');
  if (hasTable !== hasColumn) {
    throw new DatabaseInitializationError(
      'MIGRATION_INCOMPLETE',
      'The table-session migration is incomplete and cannot be resumed safely.',
    );
  }
  return hasTable;
}

function validateLegacySchema(database) {
  const legacyTables = REQUIRED_TABLES.filter((name) => name !== 'table_sessions');
  const legacyIndexes = REQUIRED_INDEXES.filter((name) => ![
    'idx_table_sessions_table_opened',
    'uq_table_sessions_open_table',
  ].includes(name));
  const legacyTriggers = REQUIRED_TRIGGERS.filter((name) => ![
    'trg_orders_session_valid_insert',
    'trg_orders_session_immutable',
    'trg_table_sessions_immutable_origin',
  ].includes(name));
  assertRequiredNames(schemaObjectNames(database, 'table'), legacyTables, 'tables');
  assertRequiredNames(schemaObjectNames(database, 'index'), legacyIndexes, 'indexes');
  assertRequiredNames(schemaObjectNames(database, 'trigger'), legacyTriggers, 'triggers');

  const state = database.prepare(`
    SELECT schema_version, event_epoch
    FROM system_state
    WHERE singleton_id = 1
  `).get();
  if (
    state?.schema_version !== LEGACY_SCHEMA_VERSION
    || typeof state?.event_epoch !== 'string'
    || state.event_epoch.length !== 36
  ) {
    throw new DatabaseInitializationError(
      'SCHEMA_INCOMPLETE',
      'Schema v1 system_state metadata is missing or invalid.',
    );
  }
}

function migrateSchemaV1ToV2(database) {
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const sessionExtensionPresent = hasSessionExtension(database);

    if (sessionExtensionPresent) {
      assertRequiredNames(schemaObjectNames(database, 'table'), ['table_sessions'], 'tables');
      assertRequiredNames(
        schemaObjectNames(database, 'index'),
        ['idx_table_sessions_table_opened', 'uq_table_sessions_open_table'],
        'indexes',
      );
      assertRequiredNames(
        schemaObjectNames(database, 'trigger'),
        ['trg_orders_session_valid_insert', 'trg_orders_session_immutable', 'trg_table_sessions_immutable_origin'],
        'triggers',
      );
    }

    database.exec('DROP TRIGGER trg_event_log_current_epoch;');

    if (!sessionExtensionPresent) database.exec(`
      CREATE TABLE table_sessions (
        session_id TEXT PRIMARY KEY
          CHECK (
            length(session_id) = 36
            AND substr(session_id, 9, 1) = '-'
            AND substr(session_id, 14, 1) = '-'
            AND substr(session_id, 19, 1) = '-'
            AND substr(session_id, 24, 1) = '-'
            AND session_id = lower(session_id)
            AND session_id NOT GLOB '*[^0-9a-f-]*'
          ),
        table_id INTEGER NOT NULL,
        opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0),
        closed_at_ms INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= opened_at_ms),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= opened_at_ms),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        FOREIGN KEY (table_id) REFERENCES tables(table_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );

      ALTER TABLE orders ADD COLUMN session_id TEXT REFERENCES table_sessions(session_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT;

      INSERT INTO table_sessions (
        session_id, table_id, opened_at_ms, version, created_at_ms, updated_at_ms
      )
      SELECT
        lower(
          hex(randomblob(4)) || '-' ||
          hex(randomblob(2)) || '-' ||
          '4' || substr(hex(randomblob(2)), 2, 3) || '-' ||
          '8' || substr(hex(randomblob(2)), 2, 3) || '-' ||
          hex(randomblob(6))
        ),
        table_id,
        MIN(accepted_at_ms),
        1,
        MIN(accepted_at_ms),
        MAX(accepted_at_ms)
      FROM orders
      GROUP BY table_id;

      UPDATE orders
      SET session_id = (
        SELECT session_id
        FROM table_sessions
        WHERE table_sessions.table_id = orders.table_id
      );

      CREATE INDEX idx_table_sessions_table_opened
        ON table_sessions (table_id, opened_at_ms, session_id);
      CREATE UNIQUE INDEX uq_table_sessions_open_table
        ON table_sessions (table_id)
        WHERE closed_at_ms IS NULL;

      CREATE TRIGGER trg_orders_session_valid_insert
      BEFORE INSERT ON orders
      WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM table_sessions AS s
        WHERE s.session_id = NEW.session_id
          AND s.table_id = NEW.table_id
          AND s.closed_at_ms IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'order must belong to the current open table session');
      END;

      CREATE TRIGGER trg_orders_session_immutable
      BEFORE UPDATE OF session_id ON orders
      WHEN NEW.session_id IS NOT OLD.session_id
      BEGIN
        SELECT RAISE(ABORT, 'order session identity is immutable');
      END;

      CREATE TRIGGER trg_table_sessions_immutable_origin
      BEFORE UPDATE OF session_id, table_id, opened_at_ms, created_at_ms ON table_sessions
      WHEN
        NEW.session_id IS NOT OLD.session_id
        OR NEW.table_id IS NOT OLD.table_id
        OR NEW.opened_at_ms IS NOT OLD.opened_at_ms
        OR NEW.created_at_ms IS NOT OLD.created_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'table session origin is immutable');
      END;
    `);

    const missingOrders = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM orders WHERE session_id IS NULL',
    ).get().count);
    if (missingOrders !== 0) {
      throw new DatabaseInitializationError(
        'MIGRATION_DATA_INVALID',
        'Existing orders could not be assigned to a table session.',
      );
    }

    database.exec(`
      CREATE TABLE system_state_v2 (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        event_epoch TEXT NOT NULL UNIQUE
          CHECK (
            length(event_epoch) = 36
            AND substr(event_epoch, 9, 1) = '-'
            AND substr(event_epoch, 14, 1) = '-'
            AND substr(event_epoch, 19, 1) = '-'
            AND substr(event_epoch, 24, 1) = '-'
            AND event_epoch = lower(event_epoch)
            AND event_epoch NOT GLOB '*[^0-9a-f-]*'
          ),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
      );

      INSERT INTO system_state_v2 (
        singleton_id, schema_version, event_epoch, created_at_ms, updated_at_ms
      )
      SELECT singleton_id, 2, event_epoch, created_at_ms, updated_at_ms
      FROM system_state;

      DROP TABLE system_state;
      ALTER TABLE system_state_v2 RENAME TO system_state;

      CREATE TRIGGER trg_event_log_current_epoch
      BEFORE INSERT ON event_log
      WHEN NEW.event_epoch IS NOT (
        SELECT event_epoch FROM system_state WHERE singleton_id = 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'event epoch does not match current system state');
      END;

      PRAGMA user_version = 2;
    `);

    database.exec('COMMIT;');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK;'); } catch {}
    }
    if (error instanceof DatabaseInitializationError) throw error;
    throw new DatabaseInitializationError(
      'MIGRATION_FAILED',
      'The table-session schema migration failed.',
      { cause: error },
    );
  }
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

function validateSchema(database) {
  assertRequiredNames(schemaObjectNames(database, 'table'), REQUIRED_TABLES, 'tables');
  assertRequiredNames(schemaObjectNames(database, 'index'), REQUIRED_INDEXES, 'indexes');
  assertRequiredNames(schemaObjectNames(database, 'trigger'), REQUIRED_TRIGGERS, 'triggers');

  const state = database
    .prepare(`
      SELECT schema_version, event_epoch
      FROM system_state
      WHERE singleton_id = 1
    `)
    .get();

  if (
    state?.schema_version !== SCHEMA_VERSION
    || typeof state?.event_epoch !== 'string'
    || state.event_epoch.length !== 36
  ) {
    throw new DatabaseInitializationError(
      'SCHEMA_INCOMPLETE',
      'Schema v1 system_state metadata is missing or invalid.',
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

export function initializeDatabase({ databasePath, schemaPath = DEFAULT_SCHEMA_PATH } = {}) {
  const resolvedDatabasePath = resolveFilePath(databasePath, 'databasePath');
  const resolvedSchemaPath = resolveFilePath(schemaPath, 'schemaPath');

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
    } else if (currentVersion === LEGACY_SCHEMA_VERSION) {
      validateLegacySchema(database);
      migrateSchemaV1ToV2(database);
      enableWriteAheadLogging(database);
    } else if (currentVersion === SCHEMA_VERSION) {
      if (!hasSessionExtension(database)) {
        throw new DatabaseInitializationError(
          'SCHEMA_INCOMPLETE',
          'Schema v2 is missing the table-session extension.',
        );
      }
      enableWriteAheadLogging(database);
    } else if (currentVersion === 0) {
      throw new DatabaseInitializationError(
        'UNVERSIONED_DATABASE',
        `Refusing to initialize an unversioned database containing tables: ${tables.join(', ')}`,
      );
    } else {
      throw new DatabaseInitializationError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `Unsupported SQLite schema version ${currentVersion}; expected ${SCHEMA_VERSION}.`,
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
