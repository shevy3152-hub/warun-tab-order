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

function base64UrlFromBytes(bytes, globalObject = globalThis) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof globalObject?.btoa === "function"
    ? globalObject.btoa(binary)
    : typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : "";
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createRegistrationSecret(globalObject = globalThis) {
  const bytes = new Uint8Array(32);
  if (typeof globalObject?.crypto?.getRandomValues === "function") {
    globalObject.crypto.getRandomValues(bytes);
  } else {
    throw new Error("Secure random generation is unavailable.");
  }
  return base64UrlFromBytes(bytes, globalObject);
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

function registrationBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

async function jsonResponse(response, fallbackMessage) {
  if (!response.ok) throw new Error(fallbackMessage);
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error(fallbackMessage);
  return body;
}

export async function createCustomerRegistrationRequest({ store, baseUrl, deviceId, displayName, appVersion, role = "customer", globalObject = globalThis, fetchImpl = globalThis.fetch } = {}) {
  const existing = await store.load();
  if (existing?.requestId && existing?.requestSecret) {
    return { requestId: existing.requestId, status: existing.requestStatus || "pending", expiresAtMs: existing.requestExpiresAtMs };
  }
  const requestSecret = existing?.requestSecret || createRegistrationSecret(globalObject);
  await store.save({
    ...existing,
    deviceId,
    token: null,
    config: null,
    requestSecret,
    requestStatus: existing?.requestStatus || "creating",
  });
  const response = await fetchImpl(`${registrationBaseUrl(baseUrl)}/registration-requests`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ requestSecret, deviceId, displayName, appVersion, role }),
  });
  const body = await jsonResponse(response, "Registration request failed.");
  if (typeof body.requestId !== "string" || body.status !== "pending" || !Number.isSafeInteger(body.expiresAtMs)) {
    throw new Error("Registration response was invalid.");
  }
  await store.save({ ...existing, deviceId, token: null, config: null, requestId: body.requestId, requestSecret, requestStatus: body.status, requestExpiresAtMs: body.expiresAtMs });
  return body;
}

export async function fetchCustomerRegistrationStatus({ store, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const current = await store.load();
  if (!current?.requestId || !current?.requestSecret) return null;
  const response = await fetchImpl(`${registrationBaseUrl(baseUrl)}/registration-requests/status`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: current.requestId, requestSecret: current.requestSecret }),
  });
  const body = await jsonResponse(response, "Registration status could not be loaded.");
  if (typeof body.requestId !== "string" || typeof body.status !== "string") throw new Error("Registration status was invalid.");
  await store.save({ ...current, requestStatus: body.status, requestExpiresAtMs: body.expiresAtMs });
  return body;
}

export async function claimCustomerRegistration({ store, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const current = await store.load();
  if (!current?.requestId || !current?.requestSecret) throw new Error("Registration request is unavailable.");
  const response = await fetchImpl(`${registrationBaseUrl(baseUrl)}/registration-requests/claim`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: current.requestId, requestSecret: current.requestSecret }),
  });
  const body = await jsonResponse(response, "Registration claim failed.");
  if (typeof body.deviceToken !== "string" || !body.config) throw new Error("Registration claim response was invalid.");
  await store.save({ deviceId: current.deviceId, token: body.deviceToken, config: body.config, requestStatus: "claimed" });
  return { deviceId: current.deviceId, config: body.config };
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
