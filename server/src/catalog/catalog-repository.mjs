import {
  authorizeDeviceRole,
} from '../auth/device-auth.mjs';
import { isDeviceAuthError } from '../auth/auth-errors.mjs';
import {
  CATALOG_ERROR_CODES,
  CatalogRepositoryError,
} from './catalog-errors.mjs';

const DEVICE_ROLES = Object.freeze(['customer', 'kitchen', 'admin']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PRICE_YEN = 10_000_000;
const TEMPERATURES = Object.freeze(['冷酒', '燗酒']);
const DETAIL_TEXT_FIELDS = Object.freeze([
  'reading', 'itemType', 'origin', 'producer', 'taste', 'aroma',
  'sweetness', 'finish', 'recommendation', 'description',
]);
const IMAGE_LAYOUT_USAGES = Object.freeze(['thumbnail', 'detail']);

function normalizeImageLayout(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidWrite(`${fieldName} must be an object.`);
  const number = (key, min, max) => {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw invalidWrite(`${fieldName}.${key} is outside the supported range.`);
    return n;
  };
  const fit = value.fit ?? 'contain';
  if (fit !== 'contain' && fit !== 'cover') throw invalidWrite(`${fieldName}.fit must be contain or cover.`);
  return { scale: number('scale', 0.5, 4), positionX: number('positionX', -1, 1), positionY: number('positionY', -1, 1), rotation: number('rotation', -15, 15), fit };
}

export function normalizeImageLayoutWriteRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw invalidWrite('Image layout request must be an object.');
  const expectedVersion = normalizeNonNegativeInteger(request.expectedVersion ?? 0, 'expectedVersion');
  const menuItemId = normalizeOpaqueId(request.menuItemId, 'menuItemId');
  if (request.layouts === null || typeof request.layouts !== 'object' || Array.isArray(request.layouts)) throw invalidWrite('layouts must be an object.');
  const layouts = {};
  for (const usage of IMAGE_LAYOUT_USAGES) layouts[usage] = normalizeImageLayout(request.layouts[usage], `layouts.${usage}`);
  return { expectedVersion, menuItemId, layouts };
}

function repositoryError(code, message, options = undefined) {
  return new CatalogRepositoryError(code, message, options);
}

function invalidWrite(message) {
  return repositoryError(CATALOG_ERROR_CODES.INVALID_WRITE_REQUEST, message);
}

function normalizeOpaqueId(value, fieldName) {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
    throw invalidWrite(`${fieldName} must be an opaque catalog id.`);
  }
  return value;
}

function normalizeText(value, fieldName, maximum, { empty = true } = {}) {
  if (typeof value !== 'string') throw invalidWrite(`${fieldName} must be text.`);
  const normalized = value.trim();
  if ((!empty && normalized === '') || normalized.length > maximum) {
    throw invalidWrite(`${fieldName} is outside the supported length.`);
  }
  return normalized;
}

function normalizeOptionalText(value, fieldName, maximum) {
  if (value === undefined || value === null) return '';
  return normalizeText(value, fieldName, maximum);
}

function normalizeOptionalImage(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeText(value, fieldName, 2_048, { empty: false });
}

function normalizeNonNegativeInteger(value, fieldName, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw invalidWrite(`${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function normalizeTemperatureOptions(value, fieldName, variantName) {
  const source = value === undefined
    ? (variantName === 'グラス' ? ['冷酒'] : [...TEMPERATURES])
    : value;
  if (!Array.isArray(source) || source.length === 0 || source.length > TEMPERATURES.length) {
    throw invalidWrite(`${fieldName} must contain at least one supported temperature.`);
  }
  const options = [...new Set(source)];
  if (options.length !== source.length || options.some((temperature) => !TEMPERATURES.includes(temperature))) {
    throw invalidWrite(`${fieldName} must contain only 冷酒 and/or 燗酒.`);
  }
  return options;
}

export function normalizeCatalogWriteRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw invalidWrite('Catalog write request must be an object.');
  }

  const expectedVersion = normalizeNonNegativeInteger(
    request.expectedVersion ?? 0,
    'expectedVersion',
  );
  const menuItemId = normalizeOpaqueId(request.menuItemId, 'menuItemId');
  const categoryId = normalizeOpaqueId(request.categoryId, 'categoryId');
  const formalName = normalizeText(request.formalName, 'formalName', 120, { empty: false });
  const kitchenAlias = normalizeText(request.kitchenAlias, 'kitchenAlias', 40, { empty: false });
  const description = normalizeText(request.description ?? '', 'description', 2_000);
  const priceYen = normalizeNonNegativeInteger(request.priceYen, 'priceYen', MAX_PRICE_YEN);
  const isSoldOut = request.isSoldOut ?? false;
  const isActive = request.isActive ?? true;
  if (typeof isSoldOut !== 'boolean' || typeof isActive !== 'boolean') {
    throw invalidWrite('isSoldOut and isActive must be boolean values.');
  }
  const sortOrder = normalizeNonNegativeInteger(request.sortOrder ?? 0, 'sortOrder');
  const imageUri = normalizeOptionalImage(request.imageUri, 'imageUri');
  const sectionKey = request.sectionKey === undefined || request.sectionKey === null || request.sectionKey === ''
    ? null
    : normalizeText(request.sectionKey, 'sectionKey', 40, { empty: false });

  const rawDetail = request.detail ?? { enabled: false };
  if (rawDetail === null || typeof rawDetail !== 'object' || Array.isArray(rawDetail)) {
    throw invalidWrite('detail must be an object.');
  }
  if (typeof (rawDetail.enabled ?? false) !== 'boolean') throw invalidWrite('detail.enabled must be boolean.');
  const detail = {
    enabled: rawDetail.enabled ?? false,
    imageUri: normalizeOptionalImage(rawDetail.imageUri, 'detail.imageUri'),
    showImageInList: rawDetail.showImageInList ?? false,
  };
  if (typeof detail.showImageInList !== 'boolean') throw invalidWrite('detail.showImageInList must be boolean.');
  for (const field of DETAIL_TEXT_FIELDS) {
    detail[field] = normalizeOptionalText(rawDetail[field], `detail.${field}`, 2_000);
  }

  const rawVariants = request.variants ?? [];
  const rawServingOptions = request.servingOptions ?? [];
  if (!Array.isArray(rawVariants) || rawVariants.length > 20) throw invalidWrite('variants must be an array of at most 20 items.');
  if (!Array.isArray(rawServingOptions) || rawServingOptions.length > 20) throw invalidWrite('servingOptions must be an array of at most 20 items.');

  const variantIds = new Set();
  const variantNames = new Set();
  const variants = rawVariants.map((variant, index) => {
    if (variant === null || typeof variant !== 'object' || Array.isArray(variant)) throw invalidWrite(`variants[${index}] must be an object.`);
    const variantId = normalizeOpaqueId(variant.variantId, `variants[${index}].variantId`);
    const name = normalizeText(variant.name, `variants[${index}].name`, 80, { empty: false });
    const volumeLabel = normalizeText(variant.volumeLabel ?? '', `variants[${index}].volumeLabel`, 40);
    const price = normalizeNonNegativeInteger(variant.priceYen, `variants[${index}].priceYen`, MAX_PRICE_YEN);
    const active = variant.isActive ?? true;
    if (typeof active !== 'boolean') throw invalidWrite(`variants[${index}].isActive must be boolean.`);
    const order = normalizeNonNegativeInteger(variant.sortOrder ?? index + 1, `variants[${index}].sortOrder`);
    const uniqueName = `${name}\u0000${volumeLabel}`;
    if (variantIds.has(variantId) || variantNames.has(uniqueName)) throw invalidWrite('Variant ids and names must be unique within a menu item.');
    variantIds.add(variantId);
    variantNames.add(uniqueName);
    const temperatureOptions = normalizeTemperatureOptions(
      variant.temperatureOptions,
      `variants[${index}].temperatureOptions`,
      name,
    );
    return { variantId, name, volumeLabel, priceYen: price, isActive: active, sortOrder: order, temperatureOptions };
  });

  const servingOptionIds = new Set();
  const servingOptionNames = new Set();
  const servingOptions = rawServingOptions.map((option, index) => {
    if (option === null || typeof option !== 'object' || Array.isArray(option)) throw invalidWrite(`servingOptions[${index}] must be an object.`);
    const servingOptionId = normalizeOpaqueId(option.servingOptionId, `servingOptions[${index}].servingOptionId`);
    const name = normalizeText(option.name, `servingOptions[${index}].name`, 80, { empty: false });
    const active = option.isActive ?? true;
    if (typeof active !== 'boolean') throw invalidWrite(`servingOptions[${index}].isActive must be boolean.`);
    const order = normalizeNonNegativeInteger(option.sortOrder ?? index + 1, `servingOptions[${index}].sortOrder`);
    if (servingOptionIds.has(servingOptionId) || servingOptionNames.has(name)) throw invalidWrite('Serving option ids and names must be unique within a menu item.');
    servingOptionIds.add(servingOptionId);
    servingOptionNames.add(name);
    return { servingOptionId, name, isActive: active, sortOrder: order };
  });

  return {
    expectedVersion,
    menuItemId,
    categoryId,
    formalName,
    kitchenAlias,
    description,
    priceYen,
    isSoldOut,
    isActive,
    sortOrder,
    imageUri,
    sectionKey,
    detail,
    variants,
    servingOptions,
  };
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

function optionalText(target, key, value) {
  if (typeof value === 'string' && value !== '') target[key] = value;
  return target;
}

function mapDetail(row, includeDisabled = false, includeListSetting = false) {
  if (!row) return undefined;
  const hasListImageSetting = Object.hasOwn(row, 'show_image_in_list');
  const showImageInList = row.show_image_in_list === 1;
  if (row.detail_enabled !== 1 && !includeDisabled && !showImageInList) return undefined;
  const detail = { enabled: row.detail_enabled === 1 };
  optionalText(detail, 'imageUri', row.detail_image_uri);
  if (includeListSetting && hasListImageSetting && (includeDisabled || showImageInList)) detail.showImageInList = showImageInList;
  optionalText(detail, 'reading', row.reading);
  optionalText(detail, 'itemType', row.item_type);
  optionalText(detail, 'origin', row.origin);
  optionalText(detail, 'producer', row.producer);
  optionalText(detail, 'taste', row.taste);
  optionalText(detail, 'aroma', row.aroma);
  optionalText(detail, 'sweetness', row.sweetness);
  optionalText(detail, 'finish', row.finish);
  optionalText(detail, 'recommendation', row.recommendation);
  optionalText(detail, 'description', row.detail_description);
  return detail;
}

function mapVariant(row) {
  let temperatureOptions = ['冷酒', '燗酒'];
  try {
    const parsed = JSON.parse(row.temperature_options_json ?? '[]');
    if (Array.isArray(parsed) && parsed.length > 0) temperatureOptions = parsed;
  } catch {
    // A malformed legacy value is kept safe by exposing cold service only.
    temperatureOptions = ['冷酒'];
  }
  return {
    variantId: row.variant_id,
    name: row.name,
    volumeLabel: row.volume_label,
    priceYen: row.price_yen,
    sortOrder: row.sort_order,
    temperatureOptions,
  };
}

function mapServingOption(row) {
  return {
    servingOptionId: row.serving_option_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

function mapImageLayouts(value) {
  if (typeof value !== 'string' || value === '{}') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch { return undefined; }
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
  const item = optionalImage({
    menuItemId: row.menu_item_id,
    categoryId: row.category_id,
    formalName: row.formal_name,
    description: row.description,
    priceYen: row.price_yen,
    isSoldOut: row.is_sold_out === 1,
    sortOrder: row.sort_order,
    version: row.version,
  }, row.image_uri);
  optionalText(item, 'sectionKey', row.section_key);
  const detail = mapDetail(row, false, true);
  if (detail) item.detail = detail;
  const imageLayouts = mapImageLayouts(row.image_layouts);
  if (imageLayouts) item.imageLayouts = imageLayouts;
  return item;
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
  const item = optionalImage({
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
  optionalText(item, 'sectionKey', row.section_key);
  item.detail = mapDetail(row, true, true) ?? { enabled: false };
  const imageLayouts = mapImageLayouts(row.image_layouts);
  if (imageLayouts) item.imageLayouts = imageLayouts;
  return item;
}

export function createCatalogRepository({ database, now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw repositoryError(
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
      'A ready node:sqlite database connection is required.',
      );
  }
  if (typeof now !== 'function') {
    throw repositoryError(
      CATALOG_ERROR_CODES.DATABASE_FAILURE,
      'A clock function is required for catalog writes.',
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
      findSystemState: database.prepare(`
        SELECT event_epoch
        FROM system_state
        WHERE singleton_id = 1
      `),
      findWriteCategory: database.prepare(`
        SELECT category_id
        FROM categories
        WHERE category_id = ?
      `),
      findWriteMenuItem: database.prepare(`
        SELECT menu_item_id, version
        FROM menu_items
        WHERE menu_item_id = ?
      `),
      findWriteDetail: database.prepare(`
        SELECT version
        FROM menu_item_details
        WHERE menu_item_id = ?
      `),
      findWriteVariants: database.prepare(`
        SELECT variant_id, menu_item_id, name, volume_label, price_yen, is_active, sort_order, version, temperature_options_json
        FROM menu_item_variants
        WHERE menu_item_id = ?
      `),
      findWriteVariantOwner: database.prepare(`
        SELECT menu_item_id
        FROM menu_item_variants
        WHERE variant_id = ?
      `),
      findWriteServingOptions: database.prepare(`
        SELECT serving_option_id, menu_item_id, name, is_active, sort_order, version
        FROM menu_item_serving_options
        WHERE menu_item_id = ?
      `),
      findWriteServingOptionOwner: database.prepare(`
        SELECT menu_item_id
        FROM menu_item_serving_options
        WHERE serving_option_id = ?
      `),
      insertMenuItem: database.prepare(`
        INSERT INTO menu_items (
          menu_item_id, category_id, formal_name, kitchen_alias, description,
          price_yen, is_sold_out, is_active, sort_order, image_uri, version,
          created_at_ms, updated_at_ms, section_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `),
      updateMenuItem: database.prepare(`
        UPDATE menu_items
        SET category_id = ?, formal_name = ?, kitchen_alias = ?, description = ?,
            price_yen = ?, is_sold_out = ?, is_active = ?, sort_order = ?,
            image_uri = ?, version = version + 1, updated_at_ms = ?, section_key = ?
        WHERE menu_item_id = ? AND version = ?
      `),
      insertDetail: database.prepare(`
        INSERT INTO menu_item_details (
          menu_item_id, detail_enabled, show_image_in_list, detail_image_uri, reading, item_type,
          origin, producer, taste, aroma, sweetness, finish, recommendation,
          detail_description, version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `),
      updateDetail: database.prepare(`
        UPDATE menu_item_details
        SET detail_enabled = ?, show_image_in_list = ?, detail_image_uri = ?, reading = ?, item_type = ?,
            origin = ?, producer = ?, taste = ?, aroma = ?, sweetness = ?,
            finish = ?, recommendation = ?, detail_description = ?,
            version = version + 1, updated_at_ms = ?
        WHERE menu_item_id = ?
      `),
      insertVariant: database.prepare(`
        INSERT INTO menu_item_variants (
          variant_id, menu_item_id, name, volume_label, price_yen, is_active,
          sort_order, version, temperature_options_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `),
      updateVariant: database.prepare(`
        UPDATE menu_item_variants
        SET name = ?, volume_label = ?, price_yen = ?, is_active = ?,
            sort_order = ?, temperature_options_json = ?, version = version + 1, updated_at_ms = ?
        WHERE variant_id = ? AND menu_item_id = ?
      `),
      deactivateVariant: database.prepare(`
        UPDATE menu_item_variants
        SET is_active = 0, version = version + 1, updated_at_ms = ?
        WHERE variant_id = ? AND menu_item_id = ? AND is_active = 1
      `),
      insertServingOption: database.prepare(`
        INSERT INTO menu_item_serving_options (
          serving_option_id, menu_item_id, name, is_active, sort_order,
          version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `),
      updateServingOption: database.prepare(`
        UPDATE menu_item_serving_options
        SET name = ?, is_active = ?, sort_order = ?, version = version + 1, updated_at_ms = ?
        WHERE serving_option_id = ? AND menu_item_id = ?
      `),
      deactivateServingOption: database.prepare(`
        UPDATE menu_item_serving_options
        SET is_active = 0, version = version + 1, updated_at_ms = ?
        WHERE serving_option_id = ? AND menu_item_id = ? AND is_active = 1
      `),
      insertMenuEvent: database.prepare(`
        INSERT INTO event_log (
          event_epoch, event_type, aggregate_type, aggregate_id,
          actor_device_id, payload_json, created_at_ms
        ) VALUES (?, 'menu.updated', 'menu_item', ?, ?, ?, ?)
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
          m.price_yen,
          m.is_sold_out,
          m.sort_order,
          m.image_uri,
          m.version,
          m.section_key,
          d.detail_enabled,
          d.show_image_in_list,
          d.detail_image_uri,
          d.reading,
          d.item_type,
          d.origin,
          d.producer,
          d.taste,
          d.aroma,
          d.sweetness,
          d.finish,
          d.recommendation,
          d.detail_description
          ,(SELECT json_group_object(usage, json_object('scale', scale, 'positionX', position_x, 'positionY', position_y, 'rotation', rotation, 'fit', fit)) FROM menu_item_image_layouts l WHERE l.menu_item_id = m.menu_item_id) AS image_layouts
        FROM menu_items AS m
        JOIN categories AS c
          ON c.category_id = m.category_id
        LEFT JOIN menu_item_details AS d
          ON d.menu_item_id = m.menu_item_id
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
          ,m.section_key
          ,d.detail_enabled
          ,d.show_image_in_list
          ,d.detail_image_uri
          ,d.reading
          ,d.item_type
          ,d.origin
          ,d.producer
          ,d.taste
          ,d.aroma
          ,d.sweetness
          ,d.finish
          ,d.recommendation
          ,d.detail_description
          ,(SELECT json_group_object(usage, json_object('scale', scale, 'positionX', position_x, 'positionY', position_y, 'rotation', rotation, 'fit', fit)) FROM menu_item_image_layouts l WHERE l.menu_item_id = m.menu_item_id) AS image_layouts
        FROM menu_items AS m
        JOIN categories AS c
          ON c.category_id = m.category_id
        LEFT JOIN menu_item_details AS d
          ON d.menu_item_id = m.menu_item_id
        ORDER BY c.sort_order, m.sort_order, m.menu_item_id
      `),
      findImageLayouts: database.prepare('SELECT usage, scale, position_x, position_y, rotation, fit FROM menu_item_image_layouts WHERE menu_item_id = ? ORDER BY usage'),
      findImageLayoutItem: database.prepare('SELECT version FROM menu_items WHERE menu_item_id = ?'),
      updateImageLayoutVersion: database.prepare('UPDATE menu_items SET version = version + 1, updated_at_ms = ? WHERE menu_item_id = ? AND version = ?'),
      deleteImageLayouts: database.prepare('DELETE FROM menu_item_image_layouts WHERE menu_item_id = ?'),
      upsertImageLayout: database.prepare(`INSERT INTO menu_item_image_layouts (menu_item_id, usage, scale, position_x, position_y, rotation, fit, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(menu_item_id, usage) DO UPDATE SET scale=excluded.scale, position_x=excluded.position_x, position_y=excluded.position_y, rotation=excluded.rotation, fit=excluded.fit, updated_at_ms=excluded.updated_at_ms`),
      insertImageLayoutEvent: database.prepare('INSERT INTO event_log (event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms) VALUES (?, \'menu.updated\', \'menu_item\', ?, ?, ?, ?)'),
      findActiveVariants: database.prepare(`
        SELECT variant_id, menu_item_id, name, volume_label, price_yen, sort_order, temperature_options_json
        FROM menu_item_variants
        WHERE menu_item_id = ? AND is_active = 1
        ORDER BY sort_order, variant_id
      `),
      findAllVariants: database.prepare(`
        SELECT variant_id, menu_item_id, name, volume_label, price_yen, is_active, sort_order, version, temperature_options_json
        FROM menu_item_variants
        WHERE menu_item_id = ?
        ORDER BY sort_order, variant_id
      `),
      findActiveServingOptions: database.prepare(`
        SELECT serving_option_id, menu_item_id, name, sort_order
        FROM menu_item_serving_options
        WHERE menu_item_id = ? AND is_active = 1
        ORDER BY sort_order, serving_option_id
      `),
      findAllServingOptions: database.prepare(`
        SELECT serving_option_id, menu_item_id, name, is_active, sort_order, version
        FROM menu_item_serving_options
        WHERE menu_item_id = ?
        ORDER BY sort_order, serving_option_id
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

  function runWriteTransaction(write) {
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const result = write();
      database.exec('COMMIT;');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof CatalogRepositoryError) throw error;
      throw repositoryError(
        CATALOG_ERROR_CODES.DATABASE_FAILURE,
        'The catalog write failed.',
        { cause: error },
      );
    }
  }

  function authorizeCatalogWriter(principal) {
    assertAuthenticPrincipal(principal);
    try {
      authorizeDeviceRole(principal, ['admin']);
    } catch (error) {
      if (isDeviceAuthError(error)) {
        if (error.code === 'AUTHORIZATION_FAILED') {
          throw repositoryError(
            CATALOG_ERROR_CODES.AUTHORIZATION_FAILED,
            'The device role is not authorized to write the catalog.',
          );
        }
        throw repositoryError(
          CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED,
          'An authenticated admin device is required.',
        );
      }
      throw error;
    }
    const device = loadCurrentDevice(principal);
    if (device.role !== 'admin') {
      throw repositoryError(
        CATALOG_ERROR_CODES.AUTHORIZATION_FAILED,
        'The current device role is not authorized to write the catalog.',
      );
    }
  }

  function writeMenuItem(principal, request) {
    ensureOpen();
    authorizeCatalogWriter(principal);
    const normalized = normalizeCatalogWriteRequest(request);

    return runWriteTransaction(() => {
      if (!statements.findWriteCategory.get(normalized.categoryId)) {
        throw repositoryError(
          CATALOG_ERROR_CODES.CATEGORY_NOT_FOUND,
          'The catalog category was not found.',
        );
      }

      const current = statements.findWriteMenuItem.get(normalized.menuItemId);
      const creating = !current;
      if (creating && normalized.expectedVersion !== 0) {
        throw repositoryError(
          CATALOG_ERROR_CODES.VERSION_CONFLICT,
          'The catalog item was created after the supplied version.',
        );
      }
      if (!creating && current.version !== normalized.expectedVersion) {
        throw repositoryError(
          CATALOG_ERROR_CODES.VERSION_CONFLICT,
          'The catalog item has changed since it was read.',
        );
      }

      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw repositoryError(
          CATALOG_ERROR_CODES.DATABASE_FAILURE,
          'The catalog write clock returned an invalid timestamp.',
        );
      }

      const nextVersion = creating ? 1 : current.version + 1;
      if (creating) {
        statements.insertMenuItem.run(
          normalized.menuItemId,
          normalized.categoryId,
          normalized.formalName,
          normalized.kitchenAlias,
          normalized.description,
          normalized.priceYen,
          normalized.isSoldOut ? 1 : 0,
          normalized.isActive ? 1 : 0,
          normalized.sortOrder,
          normalized.imageUri,
          timestamp,
          timestamp,
          normalized.sectionKey,
        );
      } else {
        const update = statements.updateMenuItem.run(
          normalized.categoryId,
          normalized.formalName,
          normalized.kitchenAlias,
          normalized.description,
          normalized.priceYen,
          normalized.isSoldOut ? 1 : 0,
          normalized.isActive ? 1 : 0,
          normalized.sortOrder,
          normalized.imageUri,
          timestamp,
          normalized.sectionKey,
          normalized.menuItemId,
          normalized.expectedVersion,
        );
        if (Number(update.changes) !== 1) {
          throw repositoryError(
            CATALOG_ERROR_CODES.VERSION_CONFLICT,
            'The catalog item has changed since it was read.',
          );
        }
      }

      const currentDetail = statements.findWriteDetail.get(normalized.menuItemId);
      const detailValues = [
        normalized.detail.enabled ? 1 : 0,
        normalized.detail.showImageInList ? 1 : 0,
        normalized.detail.imageUri,
        ...DETAIL_TEXT_FIELDS.map((field) => normalized.detail[field]),
      ];
      if (currentDetail) {
        statements.updateDetail.run(...detailValues, timestamp, normalized.menuItemId);
      } else {
        statements.insertDetail.run(
          normalized.menuItemId,
          ...detailValues,
          timestamp,
          timestamp,
        );
      }

      const currentVariants = statements.findWriteVariants.all(normalized.menuItemId);
      const currentVariantsById = new Map(currentVariants.map((variant) => [variant.variant_id, variant]));
      const submittedVariantIds = new Set();
      for (const variant of normalized.variants) {
        const owner = statements.findWriteVariantOwner.get(variant.variantId);
        if (owner && owner.menu_item_id !== normalized.menuItemId) {
          throw repositoryError(
            CATALOG_ERROR_CODES.ID_CONFLICT,
            'The catalog variant id belongs to another menu item.',
          );
        }
        const currentVariant = currentVariantsById.get(variant.variantId);
        if (currentVariant) {
          statements.updateVariant.run(
            variant.name,
            variant.volumeLabel,
            variant.priceYen,
            variant.isActive ? 1 : 0,
            variant.sortOrder,
            JSON.stringify(variant.temperatureOptions),
            timestamp,
            variant.variantId,
            normalized.menuItemId,
          );
        } else {
          statements.insertVariant.run(
            variant.variantId,
            normalized.menuItemId,
            variant.name,
            variant.volumeLabel,
            variant.priceYen,
            variant.isActive ? 1 : 0,
            variant.sortOrder,
            JSON.stringify(variant.temperatureOptions),
            timestamp,
            timestamp,
          );
        }
        submittedVariantIds.add(variant.variantId);
      }
      for (const variant of currentVariants) {
        if (!submittedVariantIds.has(variant.variant_id)) {
          statements.deactivateVariant.run(timestamp, variant.variant_id, normalized.menuItemId);
        }
      }

      const currentServingOptions = statements.findWriteServingOptions.all(normalized.menuItemId);
      const currentServingOptionsById = new Map(currentServingOptions.map((option) => [option.serving_option_id, option]));
      const submittedServingOptionIds = new Set();
      for (const option of normalized.servingOptions) {
        const owner = statements.findWriteServingOptionOwner.get(option.servingOptionId);
        if (owner && owner.menu_item_id !== normalized.menuItemId) {
          throw repositoryError(
            CATALOG_ERROR_CODES.ID_CONFLICT,
            'The catalog serving option id belongs to another menu item.',
          );
        }
        const currentOption = currentServingOptionsById.get(option.servingOptionId);
        if (currentOption) {
          statements.updateServingOption.run(
            option.name,
            option.isActive ? 1 : 0,
            option.sortOrder,
            timestamp,
            option.servingOptionId,
            normalized.menuItemId,
          );
        } else {
          statements.insertServingOption.run(
            option.servingOptionId,
            normalized.menuItemId,
            option.name,
            option.isActive ? 1 : 0,
            option.sortOrder,
            timestamp,
            timestamp,
          );
        }
        submittedServingOptionIds.add(option.servingOptionId);
      }
      for (const option of currentServingOptions) {
        if (!submittedServingOptionIds.has(option.serving_option_id)) {
          statements.deactivateServingOption.run(timestamp, option.serving_option_id, normalized.menuItemId);
        }
      }

      const systemState = statements.findSystemState.get();
      if (typeof systemState?.event_epoch !== 'string') {
        throw repositoryError(
          CATALOG_ERROR_CODES.DATABASE_FAILURE,
          'The current catalog event epoch is unavailable.',
        );
      }
      const payloadJson = JSON.stringify({
        menuItemId: normalized.menuItemId,
        version: nextVersion,
        operation: creating ? 'created' : 'updated',
      });
      const eventInsertion = statements.insertMenuEvent.run(
        systemState.event_epoch,
        normalized.menuItemId,
        principal.deviceId,
        payloadJson,
        timestamp,
      );

      return {
        idempotencyResult: 'created',
        menuItemId: normalized.menuItemId,
        version: nextVersion,
        event: {
          eventEpoch: systemState.event_epoch,
          eventId: Number(eventInsertion.lastInsertRowid),
          eventType: 'menu.updated',
          payloadJson,
          createdAtMs: timestamp,
        },
      };
    });
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

  function writeImageLayouts(principal, request) {
    ensureOpen();
    authorizeCatalogWriter(principal);
    const normalized = normalizeImageLayoutWriteRequest(request);
    return runWriteTransaction(() => {
      const current = statements.findImageLayoutItem.get(normalized.menuItemId);
      if (!current) throw repositoryError(CATALOG_ERROR_CODES.MENU_ITEM_NOT_FOUND, 'The catalog item was not found.');
      if (current.version !== normalized.expectedVersion) throw repositoryError(CATALOG_ERROR_CODES.VERSION_CONFLICT, 'The catalog item has changed since it was read.');
      const timestamp = now();
      const update = statements.updateImageLayoutVersion.run(timestamp, normalized.menuItemId, normalized.expectedVersion);
      if (Number(update.changes) !== 1) throw repositoryError(CATALOG_ERROR_CODES.VERSION_CONFLICT, 'The catalog item has changed since it was read.');
      for (const usage of IMAGE_LAYOUT_USAGES) {
        const layout = normalized.layouts[usage];
        statements.upsertImageLayout.run(normalized.menuItemId, usage, layout.scale, layout.positionX, layout.positionY, layout.rotation, layout.fit, timestamp);
      }
      const systemState = statements.findSystemState.get();
      const payloadJson = JSON.stringify({ menuItemId: normalized.menuItemId, version: current.version + 1, operation: 'image-layout-updated' });
      const event = statements.insertImageLayoutEvent.run(systemState.event_epoch, normalized.menuItemId, principal.deviceId, payloadJson, timestamp);
      return { menuItemId: normalized.menuItemId, version: current.version + 1, eventId: Number(event.lastInsertRowid), eventEpoch: systemState.event_epoch };
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

      const items = itemRows.map((row) => {
        const item = mapItem(row);
        if (device.role === 'customer' || device.role === 'admin') {
          const variantRows = device.role === 'admin'
            ? statements.findAllVariants.all(row.menu_item_id)
            : statements.findActiveVariants.all(row.menu_item_id);
          const optionRows = device.role === 'admin'
            ? statements.findAllServingOptions.all(row.menu_item_id)
            : statements.findActiveServingOptions.all(row.menu_item_id);
          item.variants = variantRows.map((variant) => ({
            ...mapVariant(variant),
            ...(device.role === 'admin' ? { isActive: variant.is_active === 1, version: variant.version } : {}),
          }));
          item.servingOptions = optionRows.map((option) => ({
            ...mapServingOption(option),
            ...(device.role === 'admin' ? { isActive: option.is_active === 1, version: option.version } : {}),
          }));
        }
        return item;
      });
      return deepFreeze({
        audience: device.role,
        eventEpoch: cursor.event_epoch,
        lastEventId: cursor.last_event_id,
        categories: categoryRows.map(mapCategory),
        items,
      });
    });
  }

  return Object.freeze({
    getDeviceSettings,
    getMenuForPrincipal,
    writeMenuItem,
    writeImageLayouts,
    close() {
      closed = true;
    },
  });
}
