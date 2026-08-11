const DB_NAME = "warun-device-credentials";
const DB_VERSION = 1;
const STORE_NAME = "credentials";
const RECORD_KEY = "customer";

function clone(value) {
  return value ? { ...value } : value;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Credential storage failed."));
  });
}

export function createDeviceId(globalObject = globalThis) {
  const uuid = globalObject?.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const bytes = new Uint8Array(16);
  globalObject?.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function createMemoryCredentialStore(initial = null) {
  let record = clone(initial);
  return {
    async load() { return clone(record); },
    async save(value) { record = clone({ ...value, key: RECORD_KEY }); return clone(record); },
    async clear() { record = null; },
  };
}

export function createIndexedDbCredentialStore({ indexedDB: indexedDbApi = globalThis.indexedDB } = {}) {
  let databasePromise;
  const open = () => {
    if (!indexedDbApi) return Promise.reject(new Error("IndexedDB is unavailable."));
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDbApi.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Credential database failed."));
    });
    return databasePromise;
  };
  return {
    async load() {
      const db = await open();
      return clone(await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(RECORD_KEY)));
    },
    async save(value) {
      const db = await open();
      const record = { ...value, key: RECORD_KEY };
      await requestResult(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
      return clone(record);
    },
    async clear() {
      const db = await open();
      await requestResult(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(RECORD_KEY));
    },
  };
}

export async function loadOrCreateCustomerDevice({ store, globalObject = globalThis } = {}) {
  const existing = await store.load();
  if (existing?.deviceId) return existing;
  return store.save({ deviceId: createDeviceId(globalObject), token: null, config: null });
}

export async function claimCustomerDevice({ store, baseUrl, pairingCode, deviceId, displayName, appVersion, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/pairings/claim`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode, deviceId, displayName, appVersion }),
  });
  if (!response.ok) throw new Error("Pairing failed.");
  const body = await response.json();
  if (typeof body?.deviceToken !== "string" || !body.config) throw new Error("Pairing response was invalid.");
  await store.save({ deviceId, token: body.deviceToken, config: body.config });
  return { deviceId, config: body.config };
}

export function runtimeForCustomerCredentials({ globalObject = globalThis, baseUrl, token } = {}) {
  return {
    ...globalObject,
    location: globalObject.location,
    navigator: globalObject.navigator,
    fetch: globalObject.fetch?.bind(globalObject),
    WARUN_ORDER_MODE: "api",
    WARUN_API_BASE: baseUrl,
    WARUN_API_TOKEN: token,
  };
}
