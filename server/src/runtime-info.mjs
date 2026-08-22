import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { relative, resolve, sep } from 'node:path';

function isWithinPath(targetPath, parentPath) {
  const relativePath = relative(parentPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`));
}

function isIpv4(entry) {
  return entry?.family === 'IPv4' || entry?.family === 4;
}

export function lanIPv4Addresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((entries) => entries || [])
    .filter((entry) => isIpv4(entry) && !entry.internal && !String(entry.address).startsWith('169.254.'))
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index)
    .sort();
}

export function classifyDatabaseTarget({ databasePath, repositoryRoot } = {}) {
  const targetPath = resolve(databasePath);
  const root = resolve(repositoryRoot);
  const productionPath = resolve(root, 'server', 'var', 'warun.sqlite3');
  const safeCopiesRoot = resolve(root, 'server', 'var', 'safe-copies');
  if (targetPath.toLowerCase() === productionPath.toLowerCase()) return 'production';
  if (isWithinPath(targetPath, safeCopiesRoot)) return 'safe-copy';
  return 'other';
}

function origin(host, port) {
  return `http://${host}:${port}`;
}

function databaseIdentity(databasePath) {
  return createHash('sha256').update(databasePath, 'utf8').digest('hex').slice(0, 16);
}

export function createRuntimeInfo({
  databasePath,
  repositoryRoot,
  environment = 'development',
  host = '0.0.0.0',
  apiPort,
  webPort,
  processId = undefined,
  addresses = lanIPv4Addresses(),
} = {}) {
  const resolvedDatabasePath = resolve(databasePath);
  const lanAddresses = [...new Set(addresses)].sort();
  const localWebOrigin = origin('127.0.0.1', webPort);
  const localApiOrigin = origin('127.0.0.1', apiPort);
  const lanWebOrigins = lanAddresses.map((address) => origin(address, webPort));
  const pairingUrlOrigin = lanWebOrigins[0] || localWebOrigin;
  const databaseTarget = classifyDatabaseTarget({ databasePath: resolvedDatabasePath, repositoryRoot });
  return Object.freeze({
    environment,
    host,
    databasePath: resolvedDatabasePath,
    databaseIdentity: databaseIdentity(resolvedDatabasePath),
    databaseTarget,
    isProduction: environment === 'production' || databaseTarget === 'production',
    apiPort,
    webPort,
    processId,
    lanIPv4: Object.freeze(lanAddresses),
    localApiUrl: `${localApiOrigin}/v1`,
    localWebUrl: `${localWebOrigin}/`,
    webOrigins: Object.freeze([localWebOrigin, ...lanWebOrigins]),
    lanWebOrigins: Object.freeze(lanWebOrigins),
    pairingUrlOrigin,
    pairingUrlTemplate: `${pairingUrlOrigin}/pairing.html#p=<code>`,
  });
}

export function isSafeCopyRuntime(runtimeInfo) {
  return runtimeInfo?.databaseTarget === 'safe-copy' && runtimeInfo?.isProduction === false;
}
