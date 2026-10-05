import { authorizeDeviceRole } from '../auth/device-auth.mjs';
import {
  CUSTOMER_THEME_ERROR_CODES,
  CustomerThemeRepositoryError,
} from './customer-theme-errors.mjs';

export const CUSTOMER_THEME_KEYS = Object.freeze({
  standard: 'standard',
  camellia: 'camellia',
});

const CUSTOMER_THEME_VALUES = new Set(Object.values(CUSTOMER_THEME_KEYS));
const DEFAULT_SETTINGS = Object.freeze({ theme: CUSTOMER_THEME_KEYS.standard, version: 0, updatedAtMs: 0 });
const DEFAULT_POSITION_X = 0.5;
const DEFAULT_POSITION_Y = 0.5;
const DEFAULT_ZOOM = 1;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_NOTES_LENGTH = 4_000;
const DEFAULT_VARIANTS = Object.freeze({
  standard: Object.freeze({
    prompt: '画像は使用しない標準の赤レール。文字やロゴを画像に描かず、UIが重なる領域に重要な絵柄を置かない。',
    notes: '未設定・画像読込失敗時のfallback。客席レールは従来の赤表示。',
    positionX: DEFAULT_POSITION_X,
    positionY: DEFAULT_POSITION_Y,
    zoom: DEFAULT_ZOOM,
  }),
  camellia: Object.freeze({
    prompt: '和紙に描いた椿の縦長模様。文字・ロゴを画像に描かない。UIが重なる領域に重要な絵柄を置かない。客席端末の展開時レールに使う背景素材。',
    notes: '既存asset: 426×1587 px、縦長比率 426:1587（約0.268:1、縦が横の約3.73倍）。展開時のみ表示し、折り畳み時は赤レールへ戻す。',
    positionX: DEFAULT_POSITION_X,
    positionY: DEFAULT_POSITION_Y,
    zoom: DEFAULT_ZOOM,
  }),
});

function repositoryError(code, message, options = undefined) {
  return new CustomerThemeRepositoryError(code, message, options);
}

export function normalizeCustomerThemeKey(value) {
  return CUSTOMER_THEME_VALUES.has(value) ? value : CUSTOMER_THEME_KEYS.standard;
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

function normalizeThemeVariants(request) {
  if (request.themes === null || typeof request.themes !== 'object' || Array.isArray(request.themes)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'themes must be an object.');
  }
  rejectUnknownKeys(request.themes, [...CUSTOMER_THEME_VALUES], 'themes');
  return Object.fromEntries([...CUSTOMER_THEME_VALUES].map((theme) => [
    theme,
    normalizeVariant(theme, request.themes[theme]),
  ]));
}

export function normalizeCustomerThemeWriteRequest(request, { includeThemes = false } = {}) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw repositoryError(CUSTOMER_THEME_ERROR_CODES.INVALID_WRITE_REQUEST, 'Customer theme request must be an object.');
  }
  rejectUnknownKeys(
    request,
    includeThemes ? ['expectedVersion', 'theme', 'themes'] : ['expectedVersion', 'theme'],
    'Customer theme request',
  );
  const expectedVersion = requireExpectedVersion(request);
  if (!CUSTOMER_THEME_VALUES.has(request.theme)) {
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

function mapFullConfig(settings, rows) {
  return {
    ...settings,
    themes: Object.fromEntries([...CUSTOMER_THEME_VALUES].map((theme) => [theme, mapVariant(theme, rows.get(theme))])),
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

  const ensureOpen = () => {
    if (closed) throw repositoryError(CUSTOMER_THEME_ERROR_CODES.DATABASE_FAILURE, 'The customer-theme repository is closed.');
  };

  function getCustomerTheme() {
    ensureOpen();
    try {
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
      const settings = mapSettings(findRow());
      const rows = new Map(findVariantRows().map((row) => [row.theme_key, row]));
      return mapFullConfig(settings, rows);
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
    const normalizedRequest = normalizeCustomerThemeWriteRequest(request, { includeThemes: true });
    const themes = normalizeThemeVariants(request);
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
      for (const theme of Object.values(CUSTOMER_THEME_KEYS)) {
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
        }]))),
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
    getPublicCustomerThemeConfig,
    writeCustomerTheme,
    writeCustomerThemeConfig,
    close() { closed = true; },
  });
}
