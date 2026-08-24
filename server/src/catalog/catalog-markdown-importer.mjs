import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { normalizeCatalogWriteRequest } from './catalog-repository.mjs';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CATEGORY_NAME_MAX = 80;
const DETAIL_FIELDS = Object.freeze([
  'reading', 'itemType', 'origin', 'producer', 'taste', 'aroma',
  'sweetness', 'finish', 'recommendation', 'description',
]);
const ITEM_FIELDS = new Set([
  'id', 'category_id', 'formal_name', 'kitchen_alias', 'description',
  'price_yen', 'is_sold_out', 'is_active', 'sort_order', 'section_key',
]);
const DETAIL_INPUT_FIELDS = new Set(['enabled', 'image_uri', 'show_image_in_list', ...DETAIL_FIELDS]);

export class CatalogImportError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'CatalogImportError';
    this.code = code;
  }
}

function importError(code, message, options = undefined) {
  return new CatalogImportError(code, message, options);
}

function resultError(error) {
  return {
    status: 'error',
    code: error.code ?? 'IMPORT_FAILED',
    message: error.message,
  };
}

function emptyResult({ targetKind, databasePath, dryRun }) {
  return {
    targetKind,
    databasePath,
    dryRun,
    applied: false,
    backupPath: null,
    changes: [],
    warnings: [],
    errors: [],
  };
}

function parseScalar(value) {
  const text = String(value ?? '').trim();
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseKeyValue(line) {
  const match = line.match(/^\s*(?:-\s*)?([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
  if (!match) return null;
  return { key: match[1], value: parseScalar(match[2]) };
}

function parseTableRow(line) {
  if (!line.trim().startsWith('|')) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => parseScalar(cell));
  return cells;
}

function isTableSeparator(row) {
  return row.every((cell) => typeof cell === 'string' && /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeHeadingId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw importError('INVALID_STABLE_ID', `${label} must use an explicit stable id.`);
  }
  return value;
}

function normalizeImageTarget(value) {
  if (typeof value !== 'string') throw importError('INVALID_STABLE_ID', 'image target must use an explicit stable id.');
  const isDetail = value.endsWith('.detail');
  const itemId = isDetail ? value.slice(0, -'.detail'.length) : value;
  if (!itemId || (value.includes('.') && !isDetail)) throw importError('INVALID_STABLE_ID', 'image target suffix must be .detail when present.');
  normalizeHeadingId(itemId, 'image target');
  return value;
}

function requireField(source, field, label) {
  if (!Object.hasOwn(source, field)) throw importError('REQUIRED_FIELD_MISSING', `${label}.${field} is required.`);
  return source[field];
}

function normalizeCategory(raw) {
  const id = normalizeHeadingId(raw.id, 'category');
  const name = requireField(raw, 'name', `category:${id}`);
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > CATEGORY_NAME_MAX) {
    throw importError('INVALID_CATEGORY', `category:${id}.name is invalid.`);
  }
  const sortOrder = requireField(raw, 'sort_order', `category:${id}`);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw importError('INVALID_CATEGORY', `category:${id}.sort_order is invalid.`);
  const isVisible = requireField(raw, 'is_visible', `category:${id}`);
  if (typeof isVisible !== 'boolean') throw importError('INVALID_CATEGORY', `category:${id}.is_visible is invalid.`);
  return { categoryId: id, name: name.trim(), sortOrder, isVisible };
}

function normalizeDetail(raw, itemId) {
  const source = raw ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) throw importError('INVALID_DETAIL', `item:${itemId}.detail must be an object.`);
  for (const key of Object.keys(source)) {
    if (!DETAIL_INPUT_FIELDS.has(key)) throw importError('UNKNOWN_FIELD', `item:${itemId}.detail.${key} is not supported.`);
  }
  const enabled = source.enabled ?? false;
  if (typeof enabled !== 'boolean') throw importError('INVALID_DETAIL', `item:${itemId}.detail.enabled is invalid.`);
  if (source.show_image_in_list !== undefined && typeof source.show_image_in_list !== 'boolean') throw importError('INVALID_DETAIL', `item:${itemId}.detail.show_image_in_list is invalid.`);
  const detail = { enabled, imageUri: source.image_uri ?? null, showImageInList: source.show_image_in_list };
  for (const field of DETAIL_FIELDS) detail[field] = source[field] ?? '';
  return detail;
}

function normalizeVariantRows(rows, itemId) {
  if (rows.length === 0) return [];
  const ids = new Set();
  const names = new Set();
  return rows.map((row, index) => {
    const id = normalizeHeadingId(row.id, `item:${itemId}.variant[${index}]`);
    if (ids.has(id)) throw importError('DUPLICATE_STABLE_ID', `variant:${id} is duplicated.`);
    ids.add(id);
    const name = requireField(row, 'name', `variant:${id}`);
    const volumeLabel = requireField(row, 'volume_label', `variant:${id}`);
    const priceYen = requireField(row, 'price_yen', `variant:${id}`);
    const sortOrder = requireField(row, 'sort_order', `variant:${id}`);
    const isActive = requireField(row, 'is_active', `variant:${id}`);
    if (typeof name !== 'string' || name.trim() === '') throw importError('INVALID_VARIANT', `variant:${id}.name is invalid.`);
    if (typeof volumeLabel !== 'string') throw importError('INVALID_VARIANT', `variant:${id}.volume_label is invalid.`);
    if (!Number.isSafeInteger(priceYen) || priceYen < 0) throw importError('INVALID_VARIANT', `variant:${id}.price_yen is invalid.`);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw importError('INVALID_VARIANT', `variant:${id}.sort_order is invalid.`);
    if (typeof isActive !== 'boolean') throw importError('INVALID_VARIANT', `variant:${id}.is_active is invalid.`);
    const uniqueName = `${name.trim()}\u0000${volumeLabel.trim()}`;
    if (names.has(uniqueName)) throw importError('DUPLICATE_VARIANT_NAME', `variant:${id} duplicates a name and volume.`);
    names.add(uniqueName);
    const temperatureOptions = row.temperature_options === undefined || row.temperature_options === ''
      ? undefined
      : String(row.temperature_options).split(/\s*[,、/|]\s*/).filter(Boolean);
    return { variantId: id, name: name.trim(), volumeLabel: volumeLabel.trim(), priceYen, sortOrder, isActive, ...(temperatureOptions ? { temperatureOptions } : {}) };
  });
}

function normalizeServingOptionRows(rows, itemId) {
  if (rows.length === 0) return [];
  const ids = new Set();
  const names = new Set();
  return rows.map((row, index) => {
    const id = normalizeHeadingId(row.id, `item:${itemId}.serving_option[${index}]`);
    if (ids.has(id)) throw importError('DUPLICATE_STABLE_ID', `serving_option:${id} is duplicated.`);
    ids.add(id);
    const name = requireField(row, 'name', `serving_option:${id}`);
    const sortOrder = requireField(row, 'sort_order', `serving_option:${id}`);
    const isActive = requireField(row, 'is_active', `serving_option:${id}`);
    if (typeof name !== 'string' || name.trim() === '') throw importError('INVALID_SERVING_OPTION', `serving_option:${id}.name is invalid.`);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw importError('INVALID_SERVING_OPTION', `serving_option:${id}.sort_order is invalid.`);
    if (typeof isActive !== 'boolean') throw importError('INVALID_SERVING_OPTION', `serving_option:${id}.is_active is invalid.`);
    if (names.has(name.trim())) throw importError('DUPLICATE_SERVING_OPTION_NAME', `serving_option:${id} duplicates a name.`);
    names.add(name.trim());
    return { servingOptionId: id, name: name.trim(), sortOrder, isActive };
  });
}

function parseCatalogMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') throw importError('MARKDOWN_EMPTY', 'Markdown input is empty.');
  const categories = [];
  const items = [];
  let current = null;
  let section = null;
  const lines = markdown.split(/\r?\n/);

  const finishCurrent = () => {
    if (!current) return;
    if (current.kind === 'category') categories.push(current.value);
    else items.push(current.value);
    current = null;
    section = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const categoryHeading = line.match(/^##\s+category:\s*(\S+)\s*$/i);
    const itemHeading = line.match(/^##\s+item:\s*(\S+)\s*$/i);
    if (categoryHeading || itemHeading) {
      finishCurrent();
      const kind = categoryHeading ? 'category' : 'item';
      const id = normalizeHeadingId((categoryHeading ?? itemHeading)[1], kind);
      current = {
        kind,
        value: kind === 'category'
          ? { id }
          : { id, detail: {}, variants: [], servingOptions: [] },
      };
      continue;
    }
    const sectionHeading = line.match(/^###\s+(detail|variants|serving_options)\s*$/i);
    if (sectionHeading) {
      if (!current || current.kind !== 'item') throw importError('MARKDOWN_STRUCTURE', 'A product section must belong to an item.');
      section = sectionHeading[1].toLowerCase();
      continue;
    }
    if (!line.trim() || line.trim().startsWith('<!--') || line.trim().startsWith('#')) continue;
    if (!current) throw importError('MARKDOWN_STRUCTURE', `Content outside a category or item at line ${index + 1}.`);

    if (section === 'variants' || section === 'serving_options') {
      const header = parseTableRow(line);
      if (!header) throw importError('MARKDOWN_TABLE_REQUIRED', `A ${section} section must use a Markdown table.`);
      const rows = [];
      if (isTableSeparator(header)) throw importError('MARKDOWN_TABLE_REQUIRED', `A ${section} table header is missing.`);
      const tableHeader = header.map((cell) => String(cell).trim());
      index += 1;
      if (index >= lines.length || !isTableSeparator(parseTableRow(lines[index]) ?? [])) throw importError('MARKDOWN_TABLE_REQUIRED', `A ${section} table separator is missing.`);
      while (index + 1 < lines.length && lines[index + 1].trim().startsWith('|')) {
        index += 1;
        const row = parseTableRow(lines[index]);
        if (row && !isTableSeparator(row)) rows.push(Object.fromEntries(tableHeader.map((key, cellIndex) => [key, row[cellIndex]])));
      }
      const expected = section === 'variants'
        ? ['id', 'name', 'volume_label', 'price_yen', 'sort_order', 'is_active']
        : ['id', 'name', 'sort_order', 'is_active'];
      const expectedWithTemperatures = [...expected, 'temperature_options'];
      const validHeader = section === 'variants'
        ? (tableHeader.length === expected.length && expected.every((key, headerIndex) => tableHeader[headerIndex] === key))
          || (tableHeader.length === expectedWithTemperatures.length && expectedWithTemperatures.every((key, headerIndex) => tableHeader[headerIndex] === key))
        : tableHeader.length === expected.length && expected.every((key, headerIndex) => tableHeader[headerIndex] === key);
      if (!validHeader) {
        const allowed = section === 'variants' ? `${expected.join(', ')} or ${expectedWithTemperatures.join(', ')}` : expected.join(', ');
        throw importError('MARKDOWN_TABLE_SCHEMA', `${section} table columns must be ${allowed}.`);
      }
      current.value[section === 'variants' ? 'variants' : 'servingOptions'].push(...rows);
      continue;
    }

    const pair = parseKeyValue(line);
    if (!pair) throw importError('MARKDOWN_KEY_VALUE_REQUIRED', `Expected a key/value line at line ${index + 1}.`);
    if (section === 'detail') {
      const detailKey = pair.key;
      if (!DETAIL_INPUT_FIELDS.has(detailKey)) throw importError('UNKNOWN_FIELD', `detail.${detailKey} is not supported.`);
      if (Object.hasOwn(current.value.detail, detailKey)) throw importError('DUPLICATE_FIELD', `detail.${detailKey} is duplicated.`);
      current.value.detail[detailKey] = pair.value;
    } else {
      if (current.kind === 'category' && !['id', 'name', 'sort_order', 'is_visible'].includes(pair.key)) throw importError('UNKNOWN_FIELD', `category.${pair.key} is not supported.`);
      if (current.kind === 'item' && !ITEM_FIELDS.has(pair.key)) throw importError('UNKNOWN_FIELD', `item.${pair.key} is not supported.`);
      if (Object.hasOwn(current.value, pair.key)) throw importError('DUPLICATE_FIELD', `${current.kind}.${pair.key} is duplicated.`);
      if (pair.key === 'id' && pair.value !== current.value.id) throw importError('STABLE_ID_MISMATCH', `${current.kind} id does not match its heading.`);
      current.value[pair.key] = pair.value;
    }
  }
  finishCurrent();

  const categoryIds = new Set();
  const itemIds = new Set();
  for (const category of categories) {
    if (categoryIds.has(category.id)) throw importError('DUPLICATE_STABLE_ID', `category:${category.id} is duplicated.`);
    categoryIds.add(category.id);
  }
  for (const item of items) {
    if (itemIds.has(item.id)) throw importError('DUPLICATE_STABLE_ID', `item:${item.id} is duplicated.`);
    itemIds.add(item.id);
  }
  const normalizedCategories = categories.map(normalizeCategory);
  const normalizedItems = items.map((item) => {
    const itemId = normalizeHeadingId(item.id, 'item');
    const categoryId = requireField(item, 'category_id', `item:${itemId}`);
    if (typeof categoryId !== 'string' || !categoryIds.has(categoryId)) throw importError('CATEGORY_REFERENCE_NOT_FOUND', `item:${itemId} references unknown category:${categoryId}.`);
    for (const field of ['formal_name', 'kitchen_alias', 'price_yen', 'sort_order']) requireField(item, field, `item:${itemId}`);
    const detail = normalizeDetail(item.detail, itemId);
    const normalized = normalizeCatalogWriteRequest({
      expectedVersion: 0,
      menuItemId: itemId,
      categoryId,
      formalName: item.formal_name,
      kitchenAlias: item.kitchen_alias,
      description: item.description ?? '',
      priceYen: item.price_yen,
      isSoldOut: item.is_sold_out ?? false,
      isActive: item.is_active ?? true,
      sortOrder: item.sort_order,
      sectionKey: item.section_key ?? null,
      detail: {
        enabled: detail.enabled,
        imageUri: detail.image_uri,
        showImageInList: detail.showImageInList ?? false,
        ...Object.fromEntries(DETAIL_FIELDS.map((field) => [field, detail[field]])),
      },
      variants: normalizeVariantRows(item.variants, itemId),
      servingOptions: normalizeServingOptionRows(item.servingOptions, itemId),
    });
    normalized.detail.showImageInListSpecified = detail.show_image_in_list !== undefined;
    return normalized;
  });

  const globalVariantIds = new Set();
  const globalServingOptionIds = new Set();
  for (const item of normalizedItems) {
    for (const variant of item.variants) {
      if (globalVariantIds.has(variant.variantId)) throw importError('DUPLICATE_STABLE_ID', `variant:${variant.variantId} is duplicated across items.`);
      globalVariantIds.add(variant.variantId);
    }
    for (const option of item.servingOptions) {
      if (globalServingOptionIds.has(option.servingOptionId)) throw importError('DUPLICATE_STABLE_ID', `serving_option:${option.servingOptionId} is duplicated across items.`);
      globalServingOptionIds.add(option.servingOptionId);
    }
  }

  return { categories: normalizedCategories, items: normalizedItems, categoryIds, itemIds };
}

export function parseImageMappingMarkdown(markdown) {
  if (markdown === undefined || markdown === null || String(markdown).trim() === '') return new Map();
  const lines = String(markdown).split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (lines.length < 2) throw importError('IMAGE_TABLE_REQUIRED', 'Image mapping must contain a Markdown table.');
  const header = parseTableRow(lines[0])?.map((cell) => String(cell).trim());
  if (!header || header.length !== 2 || header[0] !== 'target' || header[1] !== 'image_uri') throw importError('IMAGE_TABLE_SCHEMA', 'Image mapping columns must be target, image_uri.');
  if (!isTableSeparator(parseTableRow(lines[1]) ?? [])) throw importError('IMAGE_TABLE_REQUIRED', 'Image mapping table separator is missing.');
  const mappings = new Map();
  for (const line of lines.slice(2)) {
    const row = parseTableRow(line);
    if (!row || row.length !== 2) throw importError('IMAGE_TABLE_SCHEMA', 'Each image mapping row must have target and image_uri.');
    const target = normalizeImageTarget(String(row[0]));
    const imageUri = row[1];
    if (typeof imageUri !== 'string' || imageUri.trim() === '') throw importError('IMAGE_URI_REQUIRED', `image mapping for ${target} is empty.`);
    if (mappings.has(target)) throw importError('DUPLICATE_IMAGE_MAPPING', `image mapping for ${target} is duplicated.`);
    mappings.set(target, imageUri.trim());
  }
  return mappings;
}

function normalizeImageMap(imageMap, imageMappingMarkdown) {
  const mapping = imageMappingMarkdown === undefined
    ? new Map(Object.entries(imageMap ?? {}))
    : parseImageMappingMarkdown(imageMappingMarkdown);
  for (const [target, uri] of mapping) {
    normalizeImageTarget(target);
    if (typeof uri !== 'string' || uri.trim() === '') throw importError('IMAGE_URI_REQUIRED', `image mapping for ${target} is empty.`);
  }
  return new Map([...mapping.entries()].map(([target, uri]) => [target, uri.trim()]));
}

function readDatabaseState(database) {
  const categories = database.prepare(`
    SELECT category_id, name, sort_order, is_visible, version, updated_at_ms
    FROM categories
  `).all();
  const items = database.prepare(`
    SELECT menu_item_id, category_id, formal_name, kitchen_alias, description,
           price_yen, is_sold_out, is_active, sort_order, image_uri, version,
           section_key, updated_at_ms
    FROM menu_items
  `).all();
  const details = database.prepare(`
    SELECT menu_item_id, detail_enabled, detail_image_uri, reading, item_type,
           origin, producer, taste, aroma, sweetness, finish, recommendation,
           detail_description, show_image_in_list, version
    FROM menu_item_details
  `).all();
  const variants = database.prepare(`
    SELECT variant_id, menu_item_id, name, volume_label, price_yen, is_active,
           sort_order, version, temperature_options_json
    FROM menu_item_variants
  `).all();
  const servingOptions = database.prepare(`
    SELECT serving_option_id, menu_item_id, name, is_active, sort_order, version
    FROM menu_item_serving_options
  `).all();
  const variantsByItem = new Map();
  for (const row of variants) {
    const rows = variantsByItem.get(row.menu_item_id) ?? [];
    rows.push(row);
    variantsByItem.set(row.menu_item_id, rows);
  }
  const servingOptionsByItem = new Map();
  for (const row of servingOptions) {
    const rows = servingOptionsByItem.get(row.menu_item_id) ?? [];
    rows.push(row);
    servingOptionsByItem.set(row.menu_item_id, rows);
  }
  return {
    categories: new Map(categories.map((row) => [row.category_id, row])),
    items: new Map(items.map((row) => [row.menu_item_id, row])),
    details: new Map(details.map((row) => [row.menu_item_id, row])),
    variants: variantsByItem,
    servingOptions: servingOptionsByItem,
  };
}

function rowsFor(map, key) {
  return map.get(key) ?? [];
}

function detailMeaningful(detail) {
  return detail.enabled || detail.imageUri !== null || detail.showImageInList || DETAIL_FIELDS.some((field) => detail[field] !== '');
}

function resolveImages(item, state, imageMap, warnings) {
  const current = state.items.get(item.menuItemId);
  const currentDetail = state.details.get(item.menuItemId);
  const itemTarget = item.menuItemId;
  const detailTarget = `${item.menuItemId}.detail`;
  const hasItemImage = imageMap.has(itemTarget);
  const hasDetailImage = imageMap.has(detailTarget);
  if (!hasItemImage) warnings.push({ status: 'warning', code: 'IMAGE_MAPPING_MISSING', target: itemTarget, message: `No image mapping for ${itemTarget}; existing image is preserved.` });
  if (item.detail.enabled && !hasDetailImage) warnings.push({ status: 'warning', code: 'DETAIL_IMAGE_MAPPING_MISSING', target: detailTarget, message: `No detail image mapping for ${detailTarget}; existing image is preserved.` });
  const next = {
    ...item,
    imageUri: hasItemImage ? imageMap.get(itemTarget) : current?.image_uri ?? null,
    detail: {
      ...item.detail,
      imageUri: hasDetailImage ? imageMap.get(detailTarget) : currentDetail?.detail_image_uri ?? item.detail.imageUri ?? null,
      showImageInList: item.detail.showImageInListSpecified
        ? item.detail.showImageInList
        : currentDetail?.show_image_in_list === 1 || item.detail.showImageInList,
    },
  };
  return normalizeCatalogWriteRequest(next);
}

function sameDetail(desired, current) {
  if (!current) return !detailMeaningful(desired);
  return (current.detail_enabled === 1) === desired.enabled
    && (current.show_image_in_list === 1) === desired.showImageInList
    && (current.detail_image_uri ?? null) === desired.imageUri
    && DETAIL_FIELDS.every((field) => {
      const databaseField = field === 'itemType'
        ? 'item_type'
        : field === 'description' ? 'detail_description' : field;
      return (current[databaseField] ?? '') === desired[field];
    });
}

function sameVariants(desired, currentRows) {
  const currentById = new Map(currentRows.map((row) => [row.variant_id, row]));
  if (desired.length !== currentRows.filter((row) => row.is_active === 1).length && desired.some((row) => row.isActive)) return false;
  for (const row of desired) {
    const current = currentById.get(row.variantId);
    const currentTemperatures = current?.temperature_options_json ? JSON.parse(current.temperature_options_json) : undefined;
    const desiredTemperatures = row.temperatureOptions ?? (row.name === 'グラス' ? ['冷酒'] : ['冷酒', '燗酒']);
    if (!current || current.name !== row.name || current.volume_label !== row.volumeLabel || current.price_yen !== row.priceYen || current.sort_order !== row.sortOrder || (current.is_active === 1) !== row.isActive || JSON.stringify(currentTemperatures) !== JSON.stringify(desiredTemperatures)) return false;
  }
  return currentRows.every((row) => desired.some((item) => item.variantId === row.variant_id) || row.is_active === 0);
}

function sameServingOptions(desired, currentRows) {
  const currentById = new Map(currentRows.map((row) => [row.serving_option_id, row]));
  if (desired.length !== currentRows.filter((row) => row.is_active === 1).length && desired.some((row) => row.isActive)) return false;
  for (const row of desired) {
    const current = currentById.get(row.servingOptionId);
    if (!current || current.name !== row.name || current.sort_order !== row.sortOrder || (current.is_active === 1) !== row.isActive) return false;
  }
  return currentRows.every((row) => desired.some((item) => item.servingOptionId === row.serving_option_id) || row.is_active === 0);
}

function sameItem(desired, current, state) {
  if (!current) return false;
  const fieldsSame = current.category_id === desired.categoryId
    && current.formal_name === desired.formalName
    && current.kitchen_alias === desired.kitchenAlias
    && current.description === desired.description
    && current.price_yen === desired.priceYen
    && (current.is_sold_out === 1) === desired.isSoldOut
    && (current.is_active === 1) === desired.isActive
    && current.sort_order === desired.sortOrder
    && (current.image_uri ?? null) === desired.imageUri
    && (current.section_key ?? null) === desired.sectionKey;
  return fieldsSame
    && sameDetail(desired.detail, state.details.get(desired.menuItemId))
    && sameVariants(desired.variants, rowsFor(state.variants, desired.menuItemId))
    && sameServingOptions(desired.servingOptions, rowsFor(state.servingOptions, desired.menuItemId));
}

function planImport({ database, parsed, imageMap }) {
  const state = readDatabaseState(database);
  const changes = [];
  const warnings = [];
  for (const category of parsed.categories) {
    const current = state.categories.get(category.categoryId);
    const unchanged = current
      && current.name === category.name
      && current.sort_order === category.sortOrder
      && (current.is_visible === 1) === category.isVisible;
    changes.push({
      kind: 'category',
      id: category.categoryId,
      status: unchanged ? 'unchanged' : current ? 'update' : 'create',
      expectedVersion: current?.version ?? 0,
      value: category,
    });
  }
  for (const rawItem of parsed.items) {
    const current = state.items.get(rawItem.menuItemId);
    const desired = resolveImages(rawItem, state, imageMap, warnings);
    const unchanged = sameItem(desired, current, state);
    for (const warning of warnings.slice(-2)) {
      if (warning.target === desired.menuItemId || warning.target === `${desired.menuItemId}.detail`) changes.push({ kind: 'item', id: desired.menuItemId, ...warning });
    }
    changes.push({
      kind: 'item',
      id: desired.menuItemId,
      status: unchanged ? 'unchanged' : current ? 'update' : 'create',
      expectedVersion: current?.version ?? 0,
      value: desired,
    });
  }
  return { state, changes, warnings };
}

function assertTarget(targetKind, database, databasePath) {
  if (!['fixture', 'copy'].includes(targetKind)) throw importError('UNSAFE_TARGET', 'Importer targetKind must be fixture or copy; production is not accepted.');
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw importError('DATABASE_REQUIRED', 'A ready SQLite database is required.');
  if (typeof databasePath !== 'string' || databasePath.trim() === '') throw importError('DATABASE_PATH_REQUIRED', 'databasePath is required for safe target and backup handling.');
  const normalizedPath = resolve(databasePath).replaceAll('\\', '/').toLowerCase();
  if (normalizedPath.endsWith('/server/var/warun.sqlite3')) throw importError('UNSAFE_TARGET', 'The operational production database path is not accepted.');
}

function applyCategory(database, change, timestamp) {
  if (change.status === 'create') {
    database.prepare(`
      INSERT INTO categories (category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(change.value.categoryId, change.value.name, change.value.sortOrder, change.value.isVisible ? 1 : 0, timestamp, timestamp);
    return;
  }
  const updated = database.prepare(`
    UPDATE categories
    SET name = ?, sort_order = ?, is_visible = ?, version = version + 1, updated_at_ms = ?
    WHERE category_id = ? AND version = ?
  `).run(change.value.name, change.value.sortOrder, change.value.isVisible ? 1 : 0, timestamp, change.id, change.expectedVersion);
  if (Number(updated.changes) !== 1) throw importError('CONCURRENT_MODIFICATION', `category:${change.id} changed during import.`);
}

function applyItem(database, change, timestamp) {
  const item = change.value;
  if (change.status === 'create') {
    database.prepare(`
      INSERT INTO menu_items (
        menu_item_id, category_id, formal_name, kitchen_alias, description,
        price_yen, is_sold_out, is_active, sort_order, image_uri, version,
        created_at_ms, updated_at_ms, section_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(item.menuItemId, item.categoryId, item.formalName, item.kitchenAlias, item.description, item.priceYen, item.isSoldOut ? 1 : 0, item.isActive ? 1 : 0, item.sortOrder, item.imageUri, timestamp, timestamp, item.sectionKey);
  } else {
    const updated = database.prepare(`
      UPDATE menu_items
      SET category_id = ?, formal_name = ?, kitchen_alias = ?, description = ?, price_yen = ?,
          is_sold_out = ?, is_active = ?, sort_order = ?, image_uri = ?,
          version = version + 1, updated_at_ms = ?, section_key = ?
      WHERE menu_item_id = ? AND version = ?
    `).run(item.categoryId, item.formalName, item.kitchenAlias, item.description, item.priceYen, item.isSoldOut ? 1 : 0, item.isActive ? 1 : 0, item.sortOrder, item.imageUri, timestamp, item.sectionKey, item.menuItemId, change.expectedVersion);
    if (Number(updated.changes) !== 1) throw importError('CONCURRENT_MODIFICATION', `item:${change.id} changed during import.`);
  }

  const currentDetail = database.prepare('SELECT version FROM menu_item_details WHERE menu_item_id = ?').get(item.menuItemId);
  const detailValues = [item.detail.enabled ? 1 : 0, item.detail.showImageInList ? 1 : 0, item.detail.imageUri, ...DETAIL_FIELDS.map((field) => item.detail[field])];
  if (currentDetail) {
    database.prepare(`
      UPDATE menu_item_details
      SET detail_enabled = ?, show_image_in_list = ?, detail_image_uri = ?, reading = ?, item_type = ?, origin = ?, producer = ?,
          taste = ?, aroma = ?, sweetness = ?, finish = ?, recommendation = ?, detail_description = ?,
          version = version + 1, updated_at_ms = ?
      WHERE menu_item_id = ?
    `).run(...detailValues, timestamp, item.menuItemId);
  } else {
    database.prepare(`
      INSERT INTO menu_item_details (
        menu_item_id, detail_enabled, show_image_in_list, detail_image_uri, reading, item_type, origin, producer, taste,
        aroma, sweetness, finish, recommendation, detail_description, version, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(item.menuItemId, ...detailValues, timestamp, timestamp);
  }

  const currentVariants = database.prepare('SELECT variant_id, is_active FROM menu_item_variants WHERE menu_item_id = ?').all(item.menuItemId);
  const currentVariantIds = new Set(currentVariants.map((row) => row.variant_id));
  for (const variant of item.variants) {
    if (currentVariantIds.has(variant.variantId)) {
      database.prepare(`
        UPDATE menu_item_variants
        SET name = ?, volume_label = ?, price_yen = ?, is_active = ?, sort_order = ?, temperature_options_json = ?, version = version + 1, updated_at_ms = ?
        WHERE variant_id = ? AND menu_item_id = ?
      `).run(variant.name, variant.volumeLabel, variant.priceYen, variant.isActive ? 1 : 0, variant.sortOrder, JSON.stringify(variant.temperatureOptions), timestamp, variant.variantId, item.menuItemId);
    } else {
      database.prepare(`
        INSERT INTO menu_item_variants (
          variant_id, menu_item_id, name, volume_label, price_yen, is_active, sort_order, version, temperature_options_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(variant.variantId, item.menuItemId, variant.name, variant.volumeLabel, variant.priceYen, variant.isActive ? 1 : 0, variant.sortOrder, JSON.stringify(variant.temperatureOptions), timestamp, timestamp);
    }
  }
  const submittedVariantIds = new Set(item.variants.map((variant) => variant.variantId));
  for (const row of currentVariants) {
    if (!submittedVariantIds.has(row.variant_id) && row.is_active === 1) {
      database.prepare('UPDATE menu_item_variants SET is_active = 0, version = version + 1, updated_at_ms = ? WHERE variant_id = ? AND menu_item_id = ?').run(timestamp, row.variant_id, item.menuItemId);
    }
  }

  const currentOptions = database.prepare('SELECT serving_option_id, name, is_active, sort_order FROM menu_item_serving_options WHERE menu_item_id = ?').all(item.menuItemId);
  const currentOptionIds = new Set(currentOptions.map((row) => row.serving_option_id));
  for (const option of item.servingOptions) {
    if (currentOptionIds.has(option.servingOptionId)) {
      const current = currentOptions.find((row) => row.serving_option_id === option.servingOptionId);
      if (current.name !== option.name || current.is_active !== (option.isActive ? 1 : 0) || current.sort_order !== option.sortOrder) {
        database.prepare(`
          UPDATE menu_item_serving_options
          SET name = ?, is_active = ?, sort_order = ?, version = version + 1, updated_at_ms = ?
          WHERE serving_option_id = ? AND menu_item_id = ?
        `).run(option.name, option.isActive ? 1 : 0, option.sortOrder, timestamp, option.servingOptionId, item.menuItemId);
      }
    } else {
      database.prepare(`
        INSERT INTO menu_item_serving_options (
          serving_option_id, menu_item_id, name, is_active, sort_order, version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(option.servingOptionId, item.menuItemId, option.name, option.isActive ? 1 : 0, option.sortOrder, timestamp, timestamp);
    }
  }
  const submittedOptionIds = new Set(item.servingOptions.map((option) => option.servingOptionId));
  for (const row of currentOptions) {
    if (!submittedOptionIds.has(row.serving_option_id) && row.is_active === 1) {
      database.prepare('UPDATE menu_item_serving_options SET is_active = 0, version = version + 1, updated_at_ms = ? WHERE serving_option_id = ? AND menu_item_id = ?').run(timestamp, row.serving_option_id, item.menuItemId);
    }
  }
}

function applyPlan(database, plan, now, actorDeviceId = null) {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw importError('INVALID_CLOCK', 'Importer clock returned an invalid timestamp.');
  database.exec('BEGIN IMMEDIATE;');
  let transactionOpen = true;
  try {
    for (const change of plan.changes) {
      if (change.status === 'warning' || change.status === 'unchanged') continue;
      if (change.kind === 'category') applyCategory(database, change, timestamp);
      else applyItem(database, change, timestamp);
      const eventPayload = JSON.stringify({ scope: change.kind, id: change.id, source: 'markdown-import' });
      database.prepare(`
        INSERT INTO event_log (
          event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms
        ) VALUES ((SELECT event_epoch FROM system_state WHERE singleton_id = 1), 'menu.updated', 'menu_item', ?, ?, ?, ?)
      `).run(change.id, actorDeviceId, eventPayload, timestamp);
    }
    database.exec('COMMIT;');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK;'); } catch {}
    }
    throw error instanceof CatalogImportError
      ? error
      : importError('IMPORT_ROLLED_BACK', 'Catalog import failed and was rolled back.', { cause: error });
  }
}

async function createBackup(database, databasePath, backupPath) {
  const source = resolve(databasePath);
  const target = resolve(backupPath);
  if (source === target) throw importError('BACKUP_PATH_INVALID', 'backupPath must be different from databasePath.');
  if (typeof database.serialize !== 'function') throw importError('BACKUP_UNAVAILABLE', 'This SQLite runtime does not provide a consistent serialize backup.');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, database.serialize());
  return target;
}

export async function importCatalogMarkdown({
  database,
  databasePath,
  targetKind,
  markdown,
  imageMap = undefined,
  imageMappingMarkdown = undefined,
  dryRun = true,
  backupPath = undefined,
  now = Date.now,
  actorDeviceId = null,
} = {}) {
  const result = emptyResult({ targetKind, databasePath, dryRun });
  try {
    assertTarget(targetKind, database, databasePath);
    if (typeof now !== 'function') throw importError('INVALID_CLOCK', 'now must be a function.');
    const parsed = parseCatalogMarkdown(markdown);
    const mappings = normalizeImageMap(imageMap, imageMappingMarkdown);
    for (const target of mappings.keys()) {
      const itemId = target.endsWith('.detail') ? target.slice(0, -7) : target;
      if (!parsed.itemIds.has(itemId)) throw importError('IMAGE_REFERENCE_NOT_FOUND', `image mapping references unknown item:${itemId}.`);
    }
    const plan = planImport({ database, parsed, imageMap: mappings });
    result.changes = plan.changes.map((change) => {
      const { value, ...safeChange } = change;
      return safeChange;
    });
    result.warnings = plan.warnings;
    if (dryRun) return result;
    const resolvedBackupPath = backupPath ?? `${resolve(databasePath)}.before-catalog-import-${Date.now()}.sqlite3`;
    result.backupPath = await createBackup(database, databasePath, resolvedBackupPath);
    applyPlan(database, plan, now, actorDeviceId);
    result.applied = true;
    return result;
  } catch (error) {
    const failure = resultError(error);
    result.errors.push(failure);
    result.changes.push(failure);
    return result;
  }
}

export const CATALOG_MARKDOWN_FORMAT = Object.freeze({
  heading: '## category:<stable-id> or ## item:<stable-id>',
  itemFields: 'category_id, formal_name, kitchen_alias, description, price_yen, is_sold_out, is_active, sort_order, section_key',
  detailFields: 'enabled plus optional reading, itemType, origin, producer, taste, aroma, sweetness, finish, recommendation, description',
  variantTable: '| id | name | volume_label | price_yen | sort_order | is_active | temperature_options |',
  servingOptionTable: '| id | name | sort_order | is_active |',
  imageTable: '| target | image_uri |  (target is item-id or item-id.detail)',
});
