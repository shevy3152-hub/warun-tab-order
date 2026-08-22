const DB_NAME = "warun-device-credentials";
const DB_VERSION = 1;
const STORE_NAME = "credentials";
const RECORD_KEY = "customer";

export class PairingClaimError extends Error {
  constructor(message, { status = 0, code = "PAIRING_REQUEST_FAILED" } = {}) {
    super(message);
    this.name = "PairingClaimError";
    this.status = status;
    this.code = code;
  }
}

export function pairingClaimErrorMessage(error) {
  if (error?.status === 410 || error?.code === "PAIRING_EXPIRED") return "コード期限切れ：管理画面で新しいQRを発行してください。";
  if (error?.status === 409 || error?.code === "PAIRING_CONFLICT" || error?.code === "DEVICE_CONFLICT") return "既存端末競合：この端末は登録済みです。管理画面で状態を確認してください。";
  if (error?.status === 400 || error?.code === "PAIRING_INVALID") return "入力内容またはQRのコードが不正です。新しいQRを読み取ってください。";
  if (error?.status === 404) return "登録APIが見つかりません。表示中のURLを確認してください。";
  if (error?.status === 401) return "登録APIの認証に失敗しました。管理画面のsafe-copy設定を確認してください。";
  return "登録に失敗しました。コードの有効期限、入力内容、接続先を確認してください。";
}

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
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { /* Keep the status-based error. */ }
    throw new PairingClaimError("Pairing failed.", { status: response.status, code: body?.error?.code });
  }
  const body = await response.json();
  if (typeof body?.deviceToken !== "string" || !body.config) throw new PairingClaimError("Pairing response was invalid.", { status: 503, code: "PAIRING_RESPONSE_INVALID" });
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
