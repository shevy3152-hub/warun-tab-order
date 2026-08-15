export const OUTBOX_DB_NAME = "warun-customer-order-outbox";
export const OUTBOX_DB_VERSION = 1;
export const OUTBOX_STORE_NAME = "orders";

export const OUTBOX_STATES = Object.freeze({
  PENDING: "pending",
  SENDING: "sending",
  SYNCED: "synced",
  REJECTED: "rejected",
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const ONLINE_FLUSH_DEBOUNCE_MS = 1_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for runtimes that expose structuredClone but cannot clone a value.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function createClientOrderId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeErrorCode(value, fallback = "UNKNOWN_ERROR") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_:-]/g, "_").slice(0, 64);
  return normalized || fallback;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError("Order items are required.");
  }
  const seen = new Set();
  return items.map((item) => {
    const menuItemId = typeof item?.menuItemId === "string" ? item.menuItemId : "";
    const quantity = Number(item?.quantity);
    if (!menuItemId || !Number.isSafeInteger(quantity) || quantity < 1 || seen.has(menuItemId)) {
      throw new TypeError("Order items are invalid.");
    }
    seen.add(menuItemId);
    return { menuItemId, quantity };
  });
}

export function createOrderPayload({ clientOrderId, items }) {
  if (typeof clientOrderId !== "string" || !clientOrderId || !UUID_V4_PATTERN.test(clientOrderId)) {
    throw new TypeError("clientOrderId must be a UUID v4.");
  }
  return {
    schemaVersion: 1,
    clientOrderId,
    items: normalizeItems(items),
  };
}

function makeRecord(payload, now) {
  return {
    clientOrderId: payload.clientOrderId,
    payload: clone(payload),
    state: OUTBOX_STATES.PENDING,
    attemptCount: 0,
    createdAt: now,
    lastAttemptAt: null,
    lastErrorCode: null,
  };
}

export function retryDelayForAttempt(attemptCount, baseMs = DEFAULT_RETRY_BASE_MS, maxMs = DEFAULT_RETRY_MAX_MS) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  return Math.min(maxMs, baseMs * (2 ** Math.min(attempt - 1, 16)));
}

function retryIsDue(record, now, baseMs, maxMs) {
  if (!record.lastAttemptAt) return true;
  return now - record.lastAttemptAt >= retryDelayForAttempt(record.attemptCount, baseMs, maxMs);
}

export function createMemoryOutbox(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.clientOrderId, clone(record)]));

  return {
    async put(record) {
      if (!records.has(record.clientOrderId)) records.set(record.clientOrderId, clone(record));
      return clone(records.get(record.clientOrderId));
    },
    async get(clientOrderId) {
      const record = records.get(clientOrderId);
      return record ? clone(record) : null;
    },
    async list() {
      return [...records.values()].map(clone);
    },
    async update(clientOrderId, patch) {
      const current = records.get(clientOrderId);
      if (!current) return null;
      const updated = { ...current, ...clone(patch) };
      records.set(clientOrderId, updated);
      return clone(updated);
    },
    async claim(clientOrderId, now) {
      const current = records.get(clientOrderId);
      if (!current || current.state !== OUTBOX_STATES.PENDING) return null;
      const claimed = {
        ...current,
        state: OUTBOX_STATES.SENDING,
        attemptCount: current.attemptCount + 1,
        lastAttemptAt: now,
      };
      records.set(clientOrderId, claimed);
      return clone(claimed);
    },
    async recoverSending() {
      for (const [clientOrderId, record] of records) {
        if (record.state === OUTBOX_STATES.SENDING) {
          records.set(clientOrderId, { ...record, state: OUTBOX_STATES.PENDING, lastErrorCode: "INTERRUPTED_SEND" });
        }
      }
    },
    async close() {},
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionResult(transaction, resultPromise) {
  return new Promise((resolve, reject) => {
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    resultPromise.then((value) => { result = value; }, reject);
  });
}

export function createIndexedDbOutbox({ indexedDB: indexedDbApi = globalThis.indexedDB } = {}) {
  let databasePromise;
  const openDatabase = () => {
    if (!indexedDbApi) return Promise.reject(new Error("IndexedDB is unavailable."));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDbApi.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          const store = database.objectStoreNames.contains(OUTBOX_STORE_NAME)
            ? request.transaction.objectStore(OUTBOX_STORE_NAME)
            : database.createObjectStore(OUTBOX_STORE_NAME, { keyPath: "clientOrderId" });
          if (!store.indexNames.contains("state")) store.createIndex("state", "state", { unique: false });
          if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
      });
    }
    return databasePromise;
  };

  const withTransaction = async (mode, callback) => {
    const database = await openDatabase();
    const transaction = database.transaction(OUTBOX_STORE_NAME, mode);
    const store = transaction.objectStore(OUTBOX_STORE_NAME);
    return transactionResult(transaction, callback(store, transaction));
  };

  return {
    async put(record) {
      return withTransaction("readwrite", async (store) => {
        const existing = await requestResult(store.get(record.clientOrderId));
        if (!existing) await requestResult(store.put(clone(record)));
        return clone(existing || record);
      });
    },
    async get(clientOrderId) {
      const database = await openDatabase();
      const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
      return requestResult(transaction.objectStore(OUTBOX_STORE_NAME).get(clientOrderId)).then((record) => record ? clone(record) : null);
    },
    async list() {
      const database = await openDatabase();
      const transaction = database.transaction(OUTBOX_STORE_NAME, "readonly");
      return requestResult(transaction.objectStore(OUTBOX_STORE_NAME).getAll()).then((records) => records.map(clone));
    },
    async update(clientOrderId, patch) {
      return withTransaction("readwrite", async (store) => {
        const current = await requestResult(store.get(clientOrderId));
        if (!current) return null;
        const updated = { ...current, ...clone(patch) };
        await requestResult(store.put(updated));
        return clone(updated);
      });
    },
    async claim(clientOrderId, now) {
      return withTransaction("readwrite", async (store) => {
        const current = await requestResult(store.get(clientOrderId));
        if (!current || current.state !== OUTBOX_STATES.PENDING) return null;
        const claimed = {
          ...current,
          state: OUTBOX_STATES.SENDING,
          attemptCount: current.attemptCount + 1,
          lastAttemptAt: now,
        };
        await requestResult(store.put(claimed));
        return clone(claimed);
      });
    },
    async recoverSending() {
      return withTransaction("readwrite", async (store) => {
        const records = await requestResult(store.getAll());
        for (const record of records) {
          if (record.state === OUTBOX_STATES.SENDING) {
            await requestResult(store.put({ ...record, state: OUTBOX_STATES.PENDING, lastErrorCode: "INTERRUPTED_SEND" }));
          }
        }
      });
    },
    async close() {
      const database = await databasePromise?.catch(() => null);
      database?.close();
    },
  };
}

function defaultApiBase(env) {
  const origin = env?.location?.origin;
  return origin ? new URL("/v1", origin).toString().replace(/\/+$/, "") : null;
}

function configuredRuntimeToken(env) {
  if (typeof env?.WARUN_API_TOKEN === "string") return env.WARUN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return env.WARUN_RUNTIME_CONFIG.apiToken.trim();
  return "";
}

export function resolveOrderApiConfig(env = globalThis) {
  if (env?.WARUN_ORDER_MODE !== "api") {
    return { mode: "demo", enabled: false, reason: "DEMO_MODE" };
  }
  const configuredBase = typeof env.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  let baseUrl = defaultApiBase(env);
  if (configuredBase) {
    try {
      baseUrl = new URL(configuredBase, env.location?.origin || undefined).toString();
    } catch {
      baseUrl = null;
    }
  }
  baseUrl = baseUrl?.replace(/\/+$/, "") || null;
  const token = configuredRuntimeToken(env);
  if (!baseUrl) return { mode: "api", enabled: false, reason: "API_BASE_UNCONFIGURED", token: "" };
  if (!token) return { mode: "api", enabled: false, reason: "API_TOKEN_UNCONFIGURED", baseUrl, token: "" };
  return { mode: "api", enabled: true, reason: null, baseUrl, token };
}

export function createApiOrderTransport({
  config,
  env = globalThis,
  fetchImpl = env.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const endpoint = config?.baseUrl ? `${config.baseUrl}/orders` : null;
  const canAttempt = () => Boolean(config?.enabled && endpoint && typeof fetchImpl === "function" && env?.navigator?.onLine !== false);

  return {
    kind: "api",
    enabled: Boolean(config?.enabled),
    unavailableCode: safeErrorCode(config?.reason, "API_UNCONFIGURED"),
    canAttempt,
    async send(payload) {
      if (!config?.enabled || !endpoint || typeof fetchImpl !== "function") {
        return { kind: "retry", errorCode: safeErrorCode(config?.reason, "API_UNCONFIGURED") };
      }
      if (env?.navigator?.onLine === false) return { kind: "retry", errorCode: "OFFLINE" };
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timeoutHandle;
      if (controller && typeof setTimeoutImpl === "function") {
        timeoutHandle = setTimeoutImpl(() => controller.abort(), timeoutMs);
      }
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(payload),
          ...(controller ? { signal: controller.signal } : {}),
        });
        const idempotencyResult = response.headers?.get?.("Idempotency-Result")?.toLowerCase();
        if ((response.status === 200 || response.status === 201) && (idempotencyResult === "created" || idempotencyResult === "replayed")) {
          return { kind: "success", idempotencyResult };
        }
        if (response.status >= 500) return { kind: "retry", errorCode: `HTTP_${response.status}` };
        if (response.status >= 400) return { kind: "rejected", errorCode: `HTTP_${response.status}` };
        return { kind: "retry", errorCode: "INVALID_API_RESPONSE" };
      } catch (error) {
        return { kind: "retry", errorCode: controller?.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR" };
      } finally {
        if (timeoutHandle !== undefined && typeof clearTimeoutImpl === "function") clearTimeoutImpl(timeoutHandle);
      }
    },
  };
}

export async function fetchCustomerOrderHistory({
  config,
  env = globalThis,
  fetchImpl = env.fetch,
} = {}) {
  const endpoint = config?.baseUrl ? `${config.baseUrl}/customer/order-history` : null;
  if (!config?.enabled || !endpoint || typeof fetchImpl !== "function") {
    throw new Error("Customer order history API is not configured.");
  }
  if (env?.navigator?.onLine === false) {
    throw new Error("Customer order history API is offline.");
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      },
    });
  } catch {
    throw new Error("Customer order history request failed.");
  }
  if (response.status !== 200) {
    throw new Error("Customer order history request failed.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Customer order history response is invalid.");
  }
  if (!body || !Array.isArray(body.orders)) {
    throw new Error("Customer order history response is invalid.");
  }
  return body.orders;
}

export function createLocalDemoTransport() {
  return {
    kind: "demo",
    enabled: true,
    canAttempt: () => true,
    async send() {
      return { kind: "success", idempotencyResult: "created" };
    },
  };
}

export function createOrderOutbox({
  store,
  transport,
  idFactory = createClientOrderId,
  now = () => Date.now(),
  eventTarget = globalThis,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  autoRetry = true,
} = {}) {
  if (!store || typeof store.put !== "function" || typeof store.claim !== "function") throw new TypeError("An outbox store is required.");
  if (!transport || typeof transport.send !== "function") throw new TypeError("An order transport is required.");
  const listeners = new Set();
  let flushPromise = null;
  let retryTimer = null;
  let started = false;
  let stopped = false;
  let lastOnlineFlushAt = 0;

  const emit = (record, extra = {}) => {
    const event = {
      clientOrderId: record.clientOrderId,
      state: record.state,
      attemptCount: record.attemptCount,
      lastAttemptAt: record.lastAttemptAt,
      lastErrorCode: record.lastErrorCode || null,
      ...extra,
    };
    for (const listener of listeners) {
      try { listener(event); } catch { /* Observers must not break delivery. */ }
    }
    return event;
  };

  const scheduleRetry = (record) => {
    if (!autoRetry || stopped || retryTimer || typeof setTimeoutImpl !== "function") return;
    const delay = retryDelayForAttempt(record.attemptCount, retryBaseMs, retryMaxMs);
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      void flush();
    }, delay);
    if (typeof retryTimer?.unref === "function") retryTimer.unref();
  };

  const recordsForFlush = async (clientOrderId) => {
    if (clientOrderId) {
      const record = await store.get(clientOrderId);
      return record ? [record] : [];
    }
    return store.list();
  };

  const flushInternal = async ({ clientOrderId = null, force = false } = {}) => {
    if (stopped) return { state: "stopped", clientOrderId };
    const records = await recordsForFlush(clientOrderId);
    if (!records.length) return { state: "not_found", clientOrderId };
    if (typeof transport.canAttempt === "function" && !transport.canAttempt()) {
      const result = { state: OUTBOX_STATES.PENDING, clientOrderId: records[0].clientOrderId, errorCode: transport.unavailableCode || "OFFLINE" };
      emit({ ...records[0], lastErrorCode: result.errorCode }, { result: "not_attempted" });
      return result;
    }

    let lastResult = { state: OUTBOX_STATES.PENDING, clientOrderId: records[0].clientOrderId };
    for (const record of records) {
      if (record.state !== OUTBOX_STATES.PENDING) continue;
      if (!force && !retryIsDue(record, now(), retryBaseMs, retryMaxMs)) continue;
      const claimed = await store.claim(record.clientOrderId, now());
      if (!claimed) continue;
      const retrying = claimed.attemptCount > 1;
      emit(claimed, { displayState: retrying ? "retrying" : "sending" });
      let result;
      try {
        result = await transport.send(claimed.payload);
      } catch {
        result = { kind: "retry", errorCode: "NETWORK_ERROR" };
      }
      if (result?.kind === "success" && (result.idempotencyResult === "created" || result.idempotencyResult === "replayed")) {
        const synced = await store.update(record.clientOrderId, {
          state: OUTBOX_STATES.SYNCED,
          lastErrorCode: null,
        });
        emit(synced, { idempotencyResult: result.idempotencyResult, displayState: "synced" });
        lastResult = { state: OUTBOX_STATES.SYNCED, clientOrderId: record.clientOrderId, idempotencyResult: result.idempotencyResult };
      } else if (result?.kind === "rejected") {
        const rejected = await store.update(record.clientOrderId, {
          state: OUTBOX_STATES.REJECTED,
          lastErrorCode: safeErrorCode(result.errorCode, "BUSINESS_ERROR"),
        });
        emit(rejected, { displayState: "business_error" });
        lastResult = { state: OUTBOX_STATES.REJECTED, clientOrderId: record.clientOrderId, errorCode: rejected.lastErrorCode };
      } else {
        const pending = await store.update(record.clientOrderId, {
          state: OUTBOX_STATES.PENDING,
          lastErrorCode: safeErrorCode(result?.errorCode, "NETWORK_ERROR"),
        });
        emit(pending, { displayState: "failed" });
        scheduleRetry(pending);
        lastResult = { state: OUTBOX_STATES.PENDING, clientOrderId: record.clientOrderId, errorCode: pending.lastErrorCode };
      }
    }
    return lastResult;
  };

  const flush = (options = {}) => {
    if (flushPromise) return flushPromise;
    flushPromise = flushInternal(options).finally(() => { flushPromise = null; });
    return flushPromise;
  };

  const onOnline = () => {
    const currentTime = Date.now();
    if (currentTime - lastOnlineFlushAt < ONLINE_FLUSH_DEBOUNCE_MS) return;
    lastOnlineFlushAt = currentTime;
    void flush({ force: true });
  };

  return {
    async enqueue({ items }) {
      const clientOrderId = idFactory();
      const payload = createOrderPayload({ clientOrderId, items });
      const record = await store.put(makeRecord(payload, now()));
      emit(record, { displayState: "pending" });
      return record;
    },
    flush,
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      await store.recoverSending?.();
      if (typeof eventTarget?.addEventListener === "function") eventTarget.addEventListener("online", onOnline);
      if (transport.enabled !== false) await flush();
    },
    async stop() {
      stopped = true;
      started = false;
      if (typeof eventTarget?.removeEventListener === "function") eventTarget.removeEventListener("online", onOnline);
      if (retryTimer !== null && typeof clearTimeoutImpl === "function") clearTimeoutImpl(retryTimer);
      retryTimer = null;
      await store.close?.();
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(clientOrderId) {
      return store.get(clientOrderId);
    },
    list() {
      return store.list();
    },
  };
}

export function createCustomerOrderClient({
  global = globalThis,
  indexedDB: indexedDbApi = global.indexedDB,
  store,
  eventTarget = global,
  ...options
} = {}) {
  const config = resolveOrderApiConfig(global);
  if (config.mode === "demo") {
    const transport = createLocalDemoTransport();
    return {
      mode: "demo",
      configured: true,
      enqueue: async ({ items }) => {
        const clientOrderId = (options.idFactory || createClientOrderId)();
        const payload = createOrderPayload({ clientOrderId, items });
        const result = await transport.send(payload);
        return { clientOrderId, payload, state: result.idempotencyResult === "created" ? OUTBOX_STATES.SYNCED : OUTBOX_STATES.PENDING };
      },
      async flush({ clientOrderId } = {}) { return { state: OUTBOX_STATES.SYNCED, clientOrderId, idempotencyResult: "created" }; },
      async start() {},
      async stop() {},
      subscribe() { return () => {}; },
      get() { return Promise.resolve(null); },
      getHistory() { return Promise.resolve([]); },
      list() { return Promise.resolve([]); },
    };
  }

  const usableStore = store || (indexedDbApi ? createIndexedDbOutbox({ indexedDB: indexedDbApi }) : createMemoryOutbox());
  const hasDurableStore = Boolean(store || indexedDbApi);
  const transport = createApiOrderTransport({
    config: hasDurableStore ? config : { ...config, enabled: false, reason: "INDEXEDDB_UNAVAILABLE", token: "" },
    env: global,
    eventTarget,
    ...options,
  });
  const service = createOrderOutbox({ store: usableStore, transport, eventTarget, ...options });
  return {
    ...service,
    mode: "api",
    configured: Boolean(config.enabled && hasDurableStore),
    configReason: hasDurableStore ? config.reason : "INDEXEDDB_UNAVAILABLE",
    getHistory() {
      return fetchCustomerOrderHistory({
        config,
        env: global,
        fetchImpl: options.fetchImpl || global.fetch,
      });
    },
  };
}
