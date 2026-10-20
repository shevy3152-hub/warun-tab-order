import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import {
  CUSTOMER_THEME_ERROR_CODES,
  CustomerThemeRepositoryError,
} from './customer-theme-errors.mjs';
import { CUSTOMER_THEME_DEFINITIONS, CUSTOMER_THEME_KEYS, isSupportedCustomerTheme } from '../../../shared/customer-theme-definitions.mjs';

const CUSTOMER_THEME_VALUES = new Set(Object.values(CUSTOMER_THEME_KEYS));
const DEFAULT_SETTINGS = Object.freeze({ theme: CUSTOMER_THEME_KEYS.standard, version: 0, updatedAtMs: 0 });
const DEFAULT_POSITION_X = 0.5;
const DEFAULT_POSITION_Y = 0.5;
const DEFAULT_ZOOM = 1;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_NOTES_LENGTH = 4_000;
const DEFAULT_VARIANTS = Object.freeze(Object.fromEntries(Object.entries(CUSTOMER_THEME_DEFINITIONS).map(([theme, definition]) => [theme, Object.freeze({
  prompt: definition.prompt,
  notes: definition.notes,
  positionX: definition.initialPositionX ?? DEFAULT_POSITION_X,
  positionY: DEFAULT_POSITION_Y,
  zoom: DEFAULT_ZOOM,
})])));

const THEME_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function repositoryError(code, message, options = undefined) {
  return new CustomerThemeRepositoryError(code, message, options);
}

export function normalizeCustomerThemeKey(value) {
  return isSupportedCustomerTheme(value) && CUSTOMER_THEME_VALUES.has(value) ? value : CUSTOMER_THEME_KEYS.standard;
}

function requireExpectedVersion(request) {
  if (!Object.hasOwn(request, 'expectedVersion')
    || !Number.isSafeInteger(request.expectedVersion)
    || request.expectedVersion < 0) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'expectedVersion is required.');
  }
  return request.expectedVersion;
}

function normalizedUnit(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, `${fieldName} must be a number between 0 and 1.`);
  }
  return Number(value.toFixed(4));
}

function normalizedZoom(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 3) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'zoom must be a number between 0.5 and 3.');
  }
  return Number(value.toFixed(4));
}

function normalizedText(value, fieldName, maxLength) {
  if (typeof value !== 'string' || [...value].length > maxLength) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, `${fieldName} must be a string of at most ${maxLength} characters.`);
  }
  return value;
}

function rejectUnknownKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw repositoryError(
      CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST,
      `${label} contains unsupported field(s): ${unknown.join(', ')}.`,
    );
  }
}

function defaultVariant(theme) {
  return { ...DEFAULT_VARIANTS[theme] };
}

function mapVariant(theme, row) {
  const fallback = defaultVariant(theme);
  return {
    prompt: typeof row?.prompt_text === 'string' ? row.prompt_text : fallback.prompt,
    notes: typeof row?.production_notes === 'string' ? row.production_notes : fallback.notes,
    positionX: typeof row?.position_x === 'number' ? row.position_x : fallback.positionX,
    positionY: typeof row?.position_y === 'number' ? row.position_y : fallback.positionY,
    zoom: typeof row?.zoom === 'number' ? row.zoom : fallback.zoom,
  };
}

function normalizeVariant(theme, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, `${theme} theme metadata must be an object.`);
  }
  rejectUnknownKeys(value, ['prompt', 'notes', 'positionX', 'positionY', 'zoom'], `${theme} theme metadata`);
  return {
    prompt: normalizedText(value.prompt, `${theme}.prompt`, MAX_PROMPT_LENGTH),
    notes: normalizedText(value.notes, `${theme}.notes`, MAX_NOTES_LENGTH),
    positionX: normalizedUnit(value.positionX, `${theme}.positionX`),
    positionY: normalizedUnit(value.positionY, `${theme}.positionY`),
    zoom: normalizedZoom(value.zoom),
  };
}

function normalizeThemeVariants(request, themeKeys) {
  if (request.themes === null || typeof request.themes !== 'object' || Array.isArray(request.themes)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'themes must be an object.');
  }
  rejectUnknownKeys(request.themes, themeKeys, 'themes');
  return Object.fromEntries(themeKeys.map((theme) => [
    theme,
    normalizeVariant(theme, request.themes[theme]),
  ]));
}

export function normalizeCustomerThemeWriteRequest(request, { includeThemes = false, allowedThemes = [...CUSTOMER_THEME_VALUES] } = {}) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'Customer theme request must be an object.');
  }
  rejectUnknownKeys(
    request,
    includeThemes ? ['expectedVersion', 'theme', 'themes'] : ['expectedVersion', 'theme'],
    'Customer theme request',
  );
  const expectedVersion = requireExpectedVersion(request);
  if (!allowedThemes.includes(request.theme)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'theme must be a supported customer theme.');
  }
  return { expectedVersion, theme: request.theme };
}

function mapSettings(row) {
  return {
    theme: normalizeCustomerThemeKey(row?.theme_key),
    version: Number.isSafeInteger(row?.version) ? row.version : DEFAULT_SETTINGS.version,
    updatedAtMs: Number.isSafeInteger(row?.updated_at_ms) ? row.updated_at_ms : DEFAULT_SETTINGS.updatedAtMs,
  };
}

function mapFullConfig(settings, rows, themeKeys = [...CUSTOMER_THEME_VALUES]) {
  return {
    ...settings,
    themes: Object.fromEntries(themeKeys.map((theme) => [theme, mapVariant(theme, rows.get(theme))])),
  };
}

function themeSseNotification(database, occurredAtMs) {
  const state = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
  if (typeof state?.event_epoch !== 'string') throw new Error('Current event epoch is unavailable.');
  return {
    eventEpoch: state.event_epoch,
    type: 'customer_theme.updated',
    aggregateId: 'customer-theme',
    occurredAtMs,
    payload: { resource: 'customerTheme', refreshRequired: true },
  };
}

export function createCustomerThemeRepository({ database, now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function' || typeof now !== 'function') {
    throw new TypeError('A database and clock are required.');
  }

  let closed = false;
  const findRow = () => database.prepare(`
    SELECT theme_key, version, updated_at_ms
    FROM customer_theme_settings
    WHERE singleton_id = 1
  `).get();
  const findVariantRows = () => database.prepare(`
    SELECT theme_key, prompt_text, production_notes, position_x, position_y, zoom
    FROM customer_theme_variants
    ORDER BY theme_key
  `).all();
  const findAssetRows = () => database.prepare('SELECT theme_key, label, asset_filename, image_width, image_height FROM customer_theme_assets ORDER BY theme_key').all();

  function getDefinitions() {
    const definitions = Object.fromEntries(Object.entries(CUSTOMER_THEME_DEFINITIONS));
    for (const row of findAssetRows()) {
      if (!THEME_KEY_PATTERN.test(row.theme_key)) continue;
      CUSTOMER_THEME_VALUES.add(row.theme_key);
      const base = definitions[row.theme_key] ?? {};
      definitions[row.theme_key] = {
        ...base,
        id: row.theme_key,
        label: row.label,
        assetPath: `/v1/customer-theme-images/${row.asset_filename}`,
        image: { width: row.image_width, height: row.image_height },
        available: true,
      };
      CUSTOMER_THEME_DEFINITIONS[row.theme_key] = Object.freeze({ ...definitions[row.theme_key], image: Object.freeze({ ...definitions[row.theme_key].image }) });
    }
    return definitions;
  }

  function normalizeThemeLabel(value) {
    if (typeof value !== 'string' || [...value.trim()].length < 1 || [...value.trim()].length > 80) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'theme name must be between 1 and 80 characters.');
    }
    return value.trim();
  }

  function registerThemeAsset(principal, { themeKey, label, filename, width, height, nowMs = now() } = {}) {
    ensureOpen();
    try { authorizeDeviceRole(principal, ['admin']); }
    catch (error) { throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.', { cause: error }); }
    const normalizedLabel = normalizeThemeLabel(label);
    if (themeKey !== undefined && (!THEME_KEY_PATTERN.test(themeKey) || !CUSTOMER_THEME_VALUES.has(themeKey))) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'theme key is invalid.');
    }
    if (typeof filename !== 'string' || !/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(filename)
      || !Number.isSafeInteger(width) || width < 1 || width > 12000
      || !Number.isSafeInteger(height) || height < 1 || height > 24000
      || width * height > 100_000_000 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'image metadata is invalid.');
    }
    let key = themeKey;
    if (!key) {
      key = normalizedLabel.toLocaleLowerCase('en').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
      if (!key) key = 'theme';
      const baseKey = key;
      let suffix = 2;
      while (CUSTOMER_THEME_VALUES.has(key) || database.prepare('SELECT 1 FROM customer_theme_assets WHERE theme_key = ?').get(key)) key = `${baseKey.slice(0, 55)}-${suffix++}`;
    }
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const existing = database.prepare('SELECT created_at_ms FROM customer_theme_assets WHERE theme_key = ?').get(key);
      database.prepare(`INSERT INTO customer_theme_assets (theme_key,label,asset_filename,image_width,image_height,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(theme_key) DO UPDATE SET label=excluded.label, asset_filename=excluded.asset_filename,
        image_width=excluded.image_width,image_height=excluded.image_height,updated_at_ms=excluded.updated_at_ms`)
        .run(key, normalizedLabel, filename, width, height, existing?.created_at_ms ?? nowMs, nowMs);
      if (!existing) {
        const definition = CUSTOMER_THEME_DEFINITIONS[key] ?? {};
        const fallback = { prompt: definition.prompt ?? '', notes: definition.notes ?? '', positionX: definition.initialPositionX ?? 0.5, positionY: 0.5, zoom: 1 };
        database.prepare(`INSERT OR IGNORE INTO customer_theme_variants (theme_key,prompt_text,production_notes,position_x,position_y,zoom,created_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?)`).run(key, fallback.prompt, fallback.notes, fallback.positionX, fallback.positionY, fallback.zoom, nowMs, nowMs);
      }
      database.exec('COMMIT;');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) { try { database.exec('ROLLBACK;'); } catch {} }
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme image registration failed.', { cause: error });
    }
    CUSTOMER_THEME_VALUES.add(key);
    return { themeKey: key, definition: getDefinitions()[key], sseNotification: themeSseNotification(database, nowMs) };
  }

  const ensureOpen = () => {
    if (closed) throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme repository is closed.');
  };

  function getCustomerTheme() {
    ensureOpen();
    try {
      getDefinitions();
      return mapSettings(findRow());
    } catch (error) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme read failed.', { cause: error });
    }
  }

  function getPublicCustomerTheme() {
    return { theme: getCustomerTheme().theme };
  }

  function getCustomerThemeConfig() {
    ensureOpen();
    try {
      const definitions = getDefinitions();
      const settings = mapSettings(findRow());
      const rows = new Map(findVariantRows().map((row) => [row.theme_key, row]));
      const themeKeys = Object.keys(definitions);
      return { ...mapFullConfig(settings, rows, themeKeys), definitions };
    } catch (error) {
      if (error instanceof CustomerThemeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme config read failed.', { cause: error });
    }
  }

  function getPublicCustomerThemeConfig() {
    const config = getCustomerThemeConfig();
    const variant = config.themes[config.theme] ?? DEFAULT_VARIANTS.standard;
    return {
      theme: config.theme,
      definitions: config.definitions,
      positionX: variant.positionX,
      positionY: variant.positionY,
      zoom: variant.zoom,
    };
  }

  function writeCustomerTheme(principal, request) {
    ensureOpen();
    const normalized = normalizeCustomerThemeWriteRequest(request);
    try {
      authorizeDeviceRole(principal, ['admin']);
    } catch (error) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.', { cause: error });
    }

    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const current = findRow();
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== normalized.expectedVersion) {
        throw repositoryError(CUSTOMER_THEME_ERROR_CODES.VERSION_CONFLICT, 'The customer theme has changed since it was read.');
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme write clock returned an invalid timestamp.');
      }
      const nextVersion = currentVersion + 1;
      if (current) {
        const result = database.prepare(`
          UPDATE customer_theme_settings
          SET theme_key = ?, version = ?, updated_at_ms = ?
          WHERE singleton_id = 1 AND version = ?
        `).run(normalized.theme, nextVersion, timestamp, normalized.expectedVersion);
        if (Number(result.changes) !== 1) {
          throw repositoryError(CUSTOMER_THEME_ERROR_CODES.VERSION_CONFLICT, 'The customer theme has changed since it was read.');
        }
      } else {
        if (normalized.expectedVersion !== 0) {
          throw repositoryError(CUSTOMER_THEME_ERROR_CODES.VERSION_CONFLICT, 'The customer theme was created after it was read.');
        }
        database.prepare(`
          INSERT INTO customer_theme_settings
            (singleton_id, theme_key, version, created_at_ms, updated_at_ms)
          VALUES (1, ?, ?, ?, ?)
        `).run(normalized.theme, nextVersion, timestamp, timestamp);
      }

      const sseNotification = themeSseNotification(database, timestamp);
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        theme: normalized.theme,
        version: nextVersion,
        updatedAtMs: timestamp,
        idempotencyResult: 'created',
        sseNotification,
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof CustomerThemeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme write failed.', { cause: error });
    }
  }

  function writeCustomerThemeConfig(principal, request) {
    ensureOpen();
    const definitions = getDefinitions();
    const themeKeys = Object.keys(definitions);
    const normalizedRequest = normalizeCustomerThemeWriteRequest(request, { includeThemes: true, allowedThemes: themeKeys });
    const themes = normalizeThemeVariants(request, themeKeys);
    try {
      authorizeDeviceRole(principal, ['admin']);
    } catch (error) {
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'An authenticated admin device is required.', { cause: error });
    }

    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      const current = findRow();
      const currentVersion = current ? Number(current.version) : 0;
      if (currentVersion !== normalizedRequest.expectedVersion) {
        throw repositoryError(CUSTOMER_THEME_ERROR_CODES.VERSION_CONFLICT, 'The customer theme has changed since it was read.');
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme write clock returned an invalid timestamp.');
      }
      const nextVersion = currentVersion + 1;
      if (current) {
        const result = database.prepare(`
          UPDATE customer_theme_settings
          SET theme_key = ?, version = ?, updated_at_ms = ?
          WHERE singleton_id = 1 AND version = ?
        `).run(normalizedRequest.theme, nextVersion, timestamp, normalizedRequest.expectedVersion);
        if (Number(result.changes) !== 1) {
          throw repositoryError(CUSTOMER_THEME_ERROR_CODES.VERSION_CONFLICT, 'The customer theme has changed since it was read.');
        }
      } else {
        database.prepare(`
          INSERT INTO customer_theme_settings
            (singleton_id, theme_key, version, created_at_ms, updated_at_ms)
          VALUES (1, ?, ?, ?, ?)
        `).run(normalizedRequest.theme, nextVersion, timestamp, timestamp);
      }

      const upsertVariant = database.prepare(`
        INSERT INTO customer_theme_variants (
          theme_key, prompt_text, production_notes, position_x, position_y, zoom,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(theme_key) DO UPDATE SET
          prompt_text = excluded.prompt_text,
          production_notes = excluded.production_notes,
          position_x = excluded.position_x,
          position_y = excluded.position_y,
          zoom = excluded.zoom,
          updated_at_ms = excluded.updated_at_ms
      `);
      for (const theme of themeKeys) {
        const variant = themes[theme];
        upsertVariant.run(theme, variant.prompt, variant.notes, variant.positionX, variant.positionY, variant.zoom, timestamp, timestamp);
      }

      const sseNotification = themeSseNotification(database, timestamp);
      database.exec('COMMIT;');
      transactionOpen = false;
      return {
        ...mapFullConfig({ theme: normalizedRequest.theme, version: nextVersion, updatedAtMs: timestamp }, new Map(Object.entries(themes).map(([theme, value]) => [theme, {
          theme_key: theme,
          prompt_text: value.prompt,
          production_notes: value.notes,
          position_x: value.positionX,
          position_y: value.positionY,
          zoom: value.zoom,
        }])), themeKeys),
        definitions,
        idempotencyResult: 'created',
        sseNotification,
      };
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK;'); } catch {}
      }
      if (error instanceof CustomerThemeRepositoryError) throw error;
      throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme config write failed.', { cause: error });
    }
  }

  return Object.freeze({
    getCustomerTheme,
    getPublicCustomerTheme,
    getCustomerThemeConfig,
    getDefinitions,
    registerThemeAsset,
    getPublicCustomerThemeConfig,
    writeCustomerTheme,
    writeCustomerThemeConfig,
    close() { closed = true; },
  });
}
