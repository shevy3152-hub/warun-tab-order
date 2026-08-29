import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_MAX_ENTRIES = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTH_CLASSIFICATIONS = new Set([
  'missing',
  'authentication_pending',
  'authentication_rejected',
  'authenticated',
  'authorization_rejected',
]);
const COMPLETIONS = new Set(['completed', 'interrupted']);

function safeText(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, maxLength);
}

function safeRequestId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 999 ? value : null;
}

function safeDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeEntry(entry, timestamp) {
  if (!entry || entry.method !== 'GET' || entry.pathname !== '/v1/menu') return null;
  const completion = COMPLETIONS.has(entry.completion) ? entry.completion : null;
  if (!completion) return null;
  const authClassification = AUTH_CLASSIFICATIONS.has(entry.authClassification)
    ? entry.authClassification
    : 'authentication_pending';
  return Object.freeze({
    timestamp: safeText(entry.timestamp, 64) ?? new Date(timestamp()).toISOString(),
    requestId: safeRequestId(entry.requestId),
    sourceIp: safeText(entry.sourceIp, 255),
    host: safeText(entry.host, 255),
    method: 'GET',
    pathname: '/v1/menu',
    authorizationPresent: entry.authorizationPresent === true,
    authClassification,
    status: safeStatus(entry.status),
    durationMs: safeDuration(entry.durationMs),
    completion,
  });
}

function loadPersistedEntry(entry) {
  if (!entry || typeof entry.timestamp !== 'string' || entry.method !== 'GET' || entry.pathname !== '/v1/menu') {
    return null;
  }
  return normalizeEntry(entry, () => Date.parse(entry.timestamp));
}

export function createMenuRequestDiagnosticRecorder({
  enabled = false,
  logPath = '',
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const resolvedLogPath = enabled && typeof logPath === 'string' && logPath.trim() ? resolve(logPath) : '';
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
      // A diagnostic failure must never alter the API response.
    }
  }

  function record(entry = {}) {
    if (!enabled) return null;
    const normalized = normalizeEntry(entry, now);
    if (!normalized) return null;
    entries = [normalized, ...entries].slice(0, limit);
    persist(normalized);
    return normalized;
  }

  return Object.freeze({ record, list: () => entries.slice() });
}
