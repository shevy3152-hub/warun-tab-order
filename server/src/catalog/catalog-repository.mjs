import {
  authorizeDeviceRole,
} from '../auth/device-auth.mjs';
import { isDeviceAuthError } from '../auth/auth-errors.mjs';
import {
  CATALOG_ERROR_CODES,
  CatalogRepositoryError,
} from './catalog-errors.mjs';

const DEVICE_ROLES = Object.freeze(['customer', 'kitchen', 'admin']);

function repositoryError(code, message, options = undefined) {
  return new CatalogRepositoryError(code, message, options);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function optionalImage(target, imageUri) {
  if (imageUri !== null) {
    target.imageUri = imageUri;
  }
  return target;
}

function mapPublicCategory(row) {
  return {
    categoryId: row.category_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

function mapAdminCategory(row) {
  return {
    ...mapPublicCategory(row),
    isVisible: row.is_visible === 1,
    version: row.version,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapCustomerMenuItem(row) {
  return optionalImage({
    menuItemId: row.menu_item_id,
    categoryId: row.category_id,
    formalName: row.formal_name,
    description: row.description,
    isSoldOut: row.is_sold_out === 1,
    sortOrder: row.sort_order,
    version: row.version,
  }, row.image_uri);
}

function mapKitchenMenuItem(row) {
  return {
    menuItemId: row.menu_item_id,
    categoryId: row.category_id,
    formalName: row.formal_name,
    kitchenAlias: row.kitchen_alias,
    isSoldOut: row.is_sold_out === 1,
    sortOrder: row.sort_order,
    version: row.version,
  };
}

function mapAdminMenuItem(row) {
  return optionalImage({
    menuItemId: row.menu_item_id,
    categoryId: row.category_id,
    formalName: row.formal_name,
    kitchenAlias: row.kitchen_alias,
    description: row.description,
    priceYen: row.price_yen,
    isSoldOut: row.is_sold_out === 1,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    version: row.version,
    updatedAtMs: row.updated_at_ms,
  }, row.image_uri);
}

export function createCatalogRepository({ database } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw repositoryError(
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
    );
  }

  let statements;
  try {
    statements = {
      findDeviceState: database.prepare(`
        SELECT
          d.device_id,
          d.role,
          d.display_name,
          d.status,
          d.updated_at_ms AS device_updated_at_ms,
          t.table_id,
          t.label AS table_label,
          t.is_active AS table_is_active,
          t.version AS table_version,
          t.updated_at_ms AS table_updated_at_ms
        FROM devices AS d
        LEFT JOIN tables AS t
          ON t.assigned_customer_device_id = d.device_id
        WHERE d.device_id = ?
        ORDER BY t.table_id
      `),
      findEventCursor: database.prepare(`
        SELECT
          s.event_epoch,
          COALESCE(MAX(e.event_id), 0) AS last_event_id
        FROM system_state AS s
        LEFT JOIN event_log AS e
          ON e.event_epoch = s.event_epoch
        WHERE s.singleton_id = 1
        GROUP BY s.event_epoch
      `),
      findVisibleCategories: database.prepare(`
        SELECT category_id, name, sort_order
        FROM categories
        WHERE is_visible = 1
        ORDER BY sort_order, category_id
      `),
      findAllCategories: database.prepare(`
        SELECT
          category_id,
          name,
          sort_order,
          is_visible,
          version,
          updated_at_ms
        FROM categories
        ORDER BY sort_order, category_id
      `),
      findCustomerMenuItems: database.prepare(`
        SELECT
          m.menu_item_id,
          m.category_id,
          m.formal_name,
          m.description,
          m.is_sold_out,
          m.sort_order,
          m.image_uri,
          m.version
        FROM menu_items AS m
        JOIN categories AS c
          ON c.category_id = m.category_id
        WHERE c.is_visible = 1
          AND m.is_active = 1
        ORDER BY c.sort_order, m.sort_order, m.menu_item_id
      `),
      findKitchenMenuItems: database.prepare(`
        SELECT
          m.menu_item_id,
          m.category_id,
          m.formal_name,
          m.kitchen_alias,
          m.is_sold_out,
          m.sort_order,
          m.version
        FROM menu_items AS m
        JOIN categories AS c
          ON c.category_id = m.category_id
        WHERE c.is_visible = 1
          AND m.is_active = 1
        ORDER BY c.sort_order, m.sort_order, m.menu_item_id
      `),
      findAdminMenuItems: database.prepare(`
        SELECT
          m.menu_item_id,
          m.category_id,
          m.formal_name,
          m.kitchen_alias,
          m.description,
          m.price_yen,
          m.is_sold_out,
          m.is_active,
          m.sort_order,
          m.image_uri,
          m.version,
          m.updated_at_ms
        FROM menu_items AS m
        JOIN categories AS c
          ON c.category_id = m.category_id
        ORDER BY c.sort_order, m.sort_order, m.menu_item_id
      `),
    };
  } catch (error) {
    throw repositoryError(
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
      'Failed to prepare catalog repository statements.',
      { cause: error },
    );
  }

  let closed = false;

  function assertAuthenticPrincipal(principal) {
    try {
      authorizeDeviceRole(principal, DEVICE_ROLES);
    } catch (error) {
      if (isDeviceAuthError(error)) {
        throw repositoryError(
          CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED,
          'An authenticated device principal is required.',
        );
      }
      throw error;
    }
  }

  function loadCurrentDevice(principal) {
    const rows = statements.findDeviceState.all(principal.deviceId);
    if (rows.length === 0 || rows[0].status !== 'active') {
      throw repositoryError(
        CATALOG_ERROR_CODES.DEVICE_NOT_ACTIVE,
        'The authenticated device is not active.',
      );
    }

    const device = rows[0];
    if (!DEVICE_ROLES.includes(device.role)) {
      throw repositoryError(
        CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
        'The current device state is inconsistent.',
      );
    }

    const assignedTables = rows.filter((row) => row.table_id !== null);
    if (device.role === 'customer') {
      if (assignedTables.length === 0) {
        throw repositoryError(
          CATALOG_ERROR_CODES.DEVICE_NOT_ASSIGNED,
          'The customer device is not assigned to a table.',
        );
      }
      if (assignedTables.length !== 1 || assignedTables[0].table_is_active !== 1) {
        throw repositoryError(
          CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
          'The customer device table assignment is inconsistent.',
        );
      }
      device.assignedTable = assignedTables[0];
    } else if (assignedTables.length !== 0) {
      throw repositoryError(
        CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT,
        'A staff device cannot have a customer table assignment.',
      );
    }

    return device;
  }

  function loadEventCursor() {
    const cursor = statements.findEventCursor.get();
    if (
      !cursor
      || typeof cursor.event_epoch !== 'string'
      || !Number.isSafeInteger(cursor.last_event_id)
      || cursor.last_event_id < 0
    ) {
      throw repositoryError(
        CATALOG_ERROR_CODES.DATABASE_FAILURE,
        'The current catalog event cursor is unavailable.',
      );
    }
    return cursor;
  }

  function ensureOpen() {
    if (closed) {
      throw repositoryError(
        CATALOG_ERROR_CODES.DATABASE_FAILURE,
        'The catalog repository is closed.',
      );
    }
  }

  function runReadTransaction(read) {
    let transactionOpen = false;
    try {
      database.exec('BEGIN;');
      transactionOpen = true;
      const result = read();
      database.exec('COMMIT;');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec('ROLLBACK;');
        } catch {
          // Preserve the original failure. The caller may replace the connection.
        }
      }

      if (error instanceof CatalogRepositoryError) {
        throw error;
      }
      throw repositoryError(
        CATALOG_ERROR_CODES.DATABASE_FAILURE,
        'The catalog read failed.',
        { cause: error },
      );
    }
  }

  function getDeviceSettings(principal) {
    ensureOpen();
    assertAuthenticPrincipal(principal);

    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();
      const table = device.assignedTable;
      const configVersion = Math.max(
        1,
        device.device_updated_at_ms,
        table?.table_updated_at_ms ?? 0,
      );
      const settings = {
        deviceId: device.device_id,
        role: device.role,
        deviceLabel: device.display_name,
        status: device.status,
        configVersion,
        eventEpoch: cursor.event_epoch,
        lastEventId: cursor.last_event_id,
      };

      if (device.role === 'customer') {
        settings.tableId = table.table_id;
        settings.tableLabel = table.table_label;
        settings.tableIsActive = true;
      }

      return deepFreeze(settings);
    });
  }

  function getMenuForPrincipal(principal) {
    ensureOpen();
    assertAuthenticPrincipal(principal);

    return runReadTransaction(() => {
      const device = loadCurrentDevice(principal);
      const cursor = loadEventCursor();

      let categoryRows;
      let itemRows;
      let mapCategory;
      let mapItem;

      if (device.role === 'customer') {
        categoryRows = statements.findVisibleCategories.all();
        itemRows = statements.findCustomerMenuItems.all();
        mapCategory = mapPublicCategory;
        mapItem = mapCustomerMenuItem;
      } else if (device.role === 'kitchen') {
        categoryRows = statements.findVisibleCategories.all();
        itemRows = statements.findKitchenMenuItems.all();
        mapCategory = mapPublicCategory;
        mapItem = mapKitchenMenuItem;
      } else if (device.role === 'admin') {
        categoryRows = statements.findAllCategories.all();
        itemRows = statements.findAdminMenuItems.all();
        mapCategory = mapAdminCategory;
        mapItem = mapAdminMenuItem;
      } else {
        throw repositoryError(
          CATALOG_ERROR_CODES.AUTHORIZATION_FAILED,
          'The device role is not authorized to read the catalog.',
        );
      }

      return deepFreeze({
        audience: device.role,
        eventEpoch: cursor.event_epoch,
        lastEventId: cursor.last_event_id,
        categories: categoryRows.map(mapCategory),
        items: itemRows.map(mapItem),
      });
    });
  }

  return Object.freeze({
    getDeviceSettings,
    getMenuForPrincipal,
    close() {
      closed = true;
    },
  });
}
