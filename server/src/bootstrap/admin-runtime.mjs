import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isCanonicalToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function readTokenFile(tokenFilePath) {
  try {
    const value = readFileSync(tokenFilePath, 'utf8').trim();
    return isCanonicalToken(value) ? value : '';
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function writeTokenFile(tokenFilePath, token) {
  mkdirSync(dirname(tokenFilePath), { recursive: true });
  const temporaryPath = `${tokenFilePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      unlinkSync(tokenFilePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    renameSync(temporaryPath, tokenFilePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Cleanup failure must not hide the original startup error.
    }
    throw error;
  }
}

function findAdminByTokenHash(database, hash) {
  return database.prepare(`
    SELECT device_id
    FROM devices
    WHERE role = 'admin' AND status = 'active' AND token_hash = ?
    LIMIT 1
  `).get(hash);
}

function ensureDefaultTables(database, now) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO tables
      (table_id, label, is_active, version, created_at_ms, updated_at_ms)
    VALUES (?, ?, 1, 1, ?, ?)
  `);
  for (let tableId = 1; tableId <= 4; tableId += 1) {
    insert.run(tableId, `テーブル ${tableId}`, now, now);
  }
}

function insertAdmin(database, token, now) {
  const deviceId = randomUUID();
  const timestamp = now();
  database.prepare(`
    INSERT INTO devices
      (device_id, role, display_name, token_hash, status, paired_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, 'admin', '店舗管理端末', ?, 'active', ?, ?, ?)
  `).run(deviceId, tokenHash(token), timestamp, timestamp, timestamp);
  return deviceId;
}

function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Prepare the local admin credential used only for the admin HTML runtime.
 *
 * Callers can preserve the existing token contract with autoProvision:false.
 * The generated raw token is written only to the ignored runtime file and
 * returned to the caller; it is never logged.
 */
export function ensureAdminRuntime({
  database,
  tokenFilePath,
  configuredToken = '',
  now = Date.now,
  autoProvision = false,
} = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }

  const explicitToken = typeof configuredToken === 'string' ? configuredToken : '';
  if (!autoProvision) {
    if (explicitToken && !isCanonicalToken(explicitToken)) {
      throw new Error('WARUN_ADMIN_API_TOKEN must be a canonical 43-character token.');
    }
    return Object.freeze({ token: explicitToken, deviceId: null, provisioned: false });
  }

  if (typeof tokenFilePath !== 'string' || tokenFilePath.trim() === '') {
    throw new TypeError('tokenFilePath is required when admin auto-provisioning is enabled.');
  }

  if (explicitToken && !isCanonicalToken(explicitToken)) {
    throw new Error('WARUN_ADMIN_API_TOKEN must be a canonical 43-character token.');
  }

  let token = isCanonicalToken(explicitToken) ? explicitToken : '';
  if (!token) token = readTokenFile(tokenFilePath);
  if (!token) token = generateToken();

  let deviceId;
  let inserted = false;
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = findAdminByTokenHash(database, tokenHash(token));
    deviceId = existing?.device_id || insertAdmin(database, token, now);
    inserted = !existing;
    ensureDefaultTables(database, now());
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }

  // Persist only after the DB transaction succeeds. A later start can reuse
  // the same credential without creating another admin device.
  if (!readTokenFile(tokenFilePath) || readTokenFile(tokenFilePath) !== token) {
    writeTokenFile(tokenFilePath, token);
  }

  return Object.freeze({ token, deviceId, provisioned: inserted });
}

export { isCanonicalToken, tokenHash };
