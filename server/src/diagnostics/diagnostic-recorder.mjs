import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_MAX_ENTRIES = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATALOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTERNAL_CODE_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const DIAGNOSTIC_ROUTES = new Set([
  'POST /v1/orders',
  'POST /v1/pairings/claim',
  'POST /v1/admin/pairing-codes',
  'POST /v1/admin/devices/revoke',
  'PUT /v1/admin/catalog/menu-item',
  'GET /v1/admin/pairing-preflight',
  'GET /v1/admin/order-history',
  'GET /v1/kitchen/order-history',
  'GET /v1/snapshot',
]);

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeRequestId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function safeCatalogId(value) {
  return typeof value === 'string' && CATALOG_ID_PATTERN.test(value) ? value : null;
}

function safeSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function safeInternalCode(value) {
  return typeof value === 'string' && INTERNAL_CODE_PATTERN.test(value) ? value : null;
}

function safeEndpoint(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const endpoint = `${method.toUpperCase()} ${path}`;
  return DIAGNOSTIC_ROUTES.has(endpoint) ? endpoint : null;
}

export function diagnosticEndpoint(method, path) {
  return safeEndpoint(method, path);
}

export function diagnosticClassification({ endpoint, status, stage, errorCode = null } = {}) {
  if (typeof status !== 'number') return 'unclassified';
  if (status >= 200 && status < 300) {
    if (endpoint === 'POST /v1/orders' && (stage === 'saved' || stage === 'response')) return 'saved';
    if (endpoint?.includes('order-history') || endpoint === 'GET /v1/snapshot') return 'retrieval_success';
    return 'accepted';
  }
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 409) return 'conflict_rejected';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'payload_rejected';
  if (status === 410) return 'expired_or_unavailable';
  if (status >= 500 && status < 600) return 'server_error';
  if (errorCode) return 'public_error_rejected';
  return 'unclassified_http';
}

function normalizeEntry(entry, now) {
  const endpoint = safeEndpoint(entry?.method, entry?.path) ?? (DIAGNOSTIC_ROUTES.has(entry?.endpoint) ? entry.endpoint : null);
  if (!endpoint) return null;
  const status = Number.isSafeInteger(entry.status) ? entry.status : null;
  const stage = typeof entry.stage === 'string' && entry.stage ? entry.stage : 'unknown';
  const normalized = {
    timestamp: new Date(now()).toISOString(),
    requestId: safeRequestId(entry.requestId),
    endpoint,
    status,
    errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : null,
    durationMs: nonNegativeInteger(entry.durationMs),
    stage,
    classification: typeof entry.classification === 'string' && entry.classification
      ? entry.classification
      : diagnosticClassification({ endpoint, status, stage, errorCode: entry.errorCode }),
  };
  if (Number.isSafeInteger(entry.resultCount) && entry.resultCount >= 0) normalized.resultCount = entry.resultCount;
  if (Number.isSafeInteger(entry.activeOrderCount) && entry.activeOrderCount >= 0) normalized.activeOrderCount = entry.activeOrderCount;
  if (Number.isSafeInteger(entry.openSessionCount) && entry.openSessionCount >= 0) normalized.openSessionCount = entry.openSessionCount;
  const menuItemId = safeCatalogId(entry.menuItemId);
  const payloadHash = safeSha256(entry.payloadHash);
  const internalCode = safeInternalCode(entry.internalCode);
  const causeCode = safeInternalCode(entry.causeCode);
  if (menuItemId) normalized.menuItemId = menuItemId;
  if (Number.isSafeInteger(entry.expectedVersion) && entry.expectedVersion >= 0) normalized.expectedVersion = entry.expectedVersion;
  if (Number.isSafeInteger(entry.actualVersion) && entry.actualVersion >= 0) normalized.actualVersion = entry.actualVersion;
  if (payloadHash) normalized.payloadHash = payloadHash;
  if (internalCode) normalized.internalCode = internalCode;
  if (causeCode) normalized.causeCode = causeCode;
  return Object.freeze(normalized);
}

function loadPersistedEntry(entry) {
  const endpoint = safeEndpoint(entry?.method, entry?.path) ?? (DIAGNOSTIC_ROUTES.has(entry?.endpoint) ? entry.endpoint : null);
  if (!endpoint || typeof entry?.timestamp !== 'string' || !entry.timestamp) return null;
  const normalized = {
    timestamp: entry.timestamp,
    requestId: safeRequestId(entry.requestId),
    endpoint,
    status: Number.isSafeInteger(entry.status) ? entry.status : null,
    errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : null,
    durationMs: nonNegativeInteger(entry.durationMs),
    stage: typeof entry.stage === 'string' && entry.stage ? entry.stage : 'unknown',
    classification: typeof entry.classification === 'string' && entry.classification ? entry.classification : 'unclassified',
  };
  for (const key of ['resultCount', 'activeOrderCount', 'openSessionCount']) {
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) normalized[key] = entry[key];
  }
  const menuItemId = safeCatalogId(entry.menuItemId);
  const payloadHash = safeSha256(entry.payloadHash);
  const internalCode = safeInternalCode(entry.internalCode);
  const causeCode = safeInternalCode(entry.causeCode);
  if (menuItemId) normalized.menuItemId = menuItemId;
  if (Number.isSafeInteger(entry.expectedVersion) && entry.expectedVersion >= 0) normalized.expectedVersion = entry.expectedVersion;
  if (Number.isSafeInteger(entry.actualVersion) && entry.actualVersion >= 0) normalized.actualVersion = entry.actualVersion;
  if (payloadHash) normalized.payloadHash = payloadHash;
  if (internalCode) normalized.internalCode = internalCode;
  if (causeCode) normalized.causeCode = causeCode;
  return Object.freeze(normalized);
}

export function createDiagnosticRecorder({ logPath = '', maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const resolvedLogPath = typeof logPath === 'string' && logPath.trim() ? resolve(logPath) : '';
  let entries = [];
  if (resolvedLogPath) {
    try {
      entries = readFileSync(resolvedLogPath, 'utf8')
        .split(/\r?\n/)
        .reverse()
        .map((line) => {
          try { return loadPersistedEntry(JSON.parse(line)); } catch { return null; }
        })
        .filter(Boolean)
        .slice(0, limit);
    } catch {
      entries = [];
    }
  }

  function persist(entry) {
    if (!resolvedLogPath) return;
    try {
      mkdirSync(dirname(resolvedLogPath), { recursive: true });
      appendFileSync(resolvedLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } catch {
      // Diagnostics are best effort and must never alter the API result.
    }
  }

  function record(entry = {}) {
    const normalized = normalizeEntry(entry, now);
    if (!normalized) return null;
    entries = [normalized, ...entries].slice(0, limit);
    persist(normalized);
    return normalized;
  }

  function list() {
    return entries.slice();
  }

  return Object.freeze({ record, list });
}
