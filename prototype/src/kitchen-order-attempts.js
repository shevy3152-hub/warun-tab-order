export const KITCHEN_ORDER_ATTEMPT_PREFIX = "warun-kitchen-order-attempt-v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = (value) => JSON.parse(JSON.stringify(value));

function failure(message, code = "KITCHEN_ORDER_RESULT_UNKNOWN") {
  return Object.assign(new Error(message), { code });
}

function normalize(kind, request) {
  if (kind === "addition") {
    if (!Number.isSafeInteger(Number(request?.tableId)) || Number(request.tableId) < 1 || !UUID.test(request?.sessionId ?? "") || !Array.isArray(request.items) || !request.items.length) throw failure("追加注文の内容を確認してください。", "INVALID_KITCHEN_OPERATION");
    return { tableId: Number(request.tableId), sessionId: request.sessionId, items: request.items.map((item) => {
      if (!Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 99) throw failure("数量を確認してください。", "INVALID_KITCHEN_OPERATION");
      if (typeof item.menuItemId === "string" && item.menuItemId.trim()) return { menuItemId: item.menuItemId.trim(), quantity: Number(item.quantity) };
      if (typeof item.name !== "string" || !item.name.trim() || !Number.isSafeInteger(Number(item.priceYen)) || Number(item.priceYen) < 0) throw failure("商品名と金額を確認してください。", "INVALID_KITCHEN_OPERATION");
      return { name: item.name.trim(), priceYen: Number(item.priceYen), quantity: Number(item.quantity) };
    }) };
  }
  if (kind !== "increase" || (request?.direction !== undefined && request.direction !== "increase") || request?.confirmZero === true || request?.reason != null || !UUID.test(request?.orderId ?? "") || !Number.isSafeInteger(Number(request.orderItemId)) || Number(request.orderItemId) < 1 || !Number.isSafeInteger(request.expectedBillableQuantity) || request.expectedBillableQuantity < 1 || request.expectedBillableQuantity > 99) throw failure("追加する注文行を確認してください。", "INVALID_KITCHEN_OPERATION");
  return { orderId: request.orderId, orderItemId: Number(request.orderItemId), direction: "increase", expectedBillableQuantity: request.expectedBillableQuantity, confirmZero: false, reason: null };
}

// A readwrite transaction owns this store exclusively across IDB connections,
// including other tabs. The localStorage critical section must stay synchronous.
// No HTTP request runs while the transaction is held; the lock DB stores no data.
export function createKitchenOrderStorageLock({ indexedDB: api } = {}) {
  if (api === undefined) { try { api = globalThis.indexedDB; } catch { api = null; } }
  let databasePromise;
  const unavailable = () => failure("追加注文の保存記録を排他処理できません。このブラウザーでの追加注文を停止しています。", "KITCHEN_ORDER_LOCK_UNAVAILABLE");
  const open = () => {
    if (!api?.open) return Promise.reject(unavailable());
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = api.open("warun-kitchen-order-attempt-lock-v1", 1);
      let abandoned = false;
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("storage-lock")) request.result.createObjectStore("storage-lock"); };
      request.onerror = () => reject(unavailable());
      request.onblocked = () => { abandoned = true; reject(unavailable()); };
      request.onsuccess = () => {
        const database = request.result;
        if (abandoned) { database.close(); return; }
        database.onversionchange = () => { database.close(); databasePromise = null; };
        database.onclose = () => { databasePromise = null; };
        resolve(database);
      };
    }).catch(() => { databasePromise = null; throw unavailable(); });
    return databasePromise;
  };
  return (operation) => open().then((database) => new Promise((resolve, reject) => {
    let transaction;
    try { transaction = database.transaction("storage-lock", "readwrite"); }
    catch { databasePromise = null; reject(unavailable()); return; }
    let result;
    let operationError;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(operationError || unavailable());
    transaction.onerror = () => { /* The abort event reports transaction failure. */ };
    const request = transaction.objectStore("storage-lock").get("exclusive");
    request.onsuccess = () => {
      try {
        result = operation();
        if (result && typeof result.then === "function") throw unavailable();
      } catch (error) { operationError = error; transaction.abort(); }
    };
  }));
}

// Keep only unresolved order intents. No credentials or API responses are stored.
export function createKitchenOrderAttempts({ storage, idFactory, sendAddition, sendIncrease, now = Date.now, withStorageLock = createKitchenOrderStorageLock() } = {}) {
  const listeners = new Set();
  let inFlight = null;
  const storageFailure = () => failure("追加注文の確認記録を保存・読出しできません。新しい追加注文を停止しています。", "KITCHEN_ORDER_STORAGE_UNAVAILABLE");
  const sameRequest = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const read = () => {
    try {
      if (!storage || !Number.isSafeInteger(storage.length) || storage.length < 0 || ["key", "getItem", "setItem", "removeItem"].some((method) => typeof storage[method] !== "function")) throw storageFailure();
      const attempts = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(KITCHEN_ORDER_ATTEMPT_PREFIX)) continue;
        const attempt = JSON.parse(storage.getItem(key));
        if (attempt?.version !== 1 || !UUID.test(attempt.id ?? "") || key !== KITCHEN_ORDER_ATTEMPT_PREFIX + attempt.id || !Number.isSafeInteger(attempt.createdAtMs) || (attempt.generation !== undefined && (!Number.isSafeInteger(attempt.generation) || attempt.generation < 1)) || !sameRequest(normalize(attempt.kind, attempt.request), attempt.request)) throw storageFailure();
        attempts.push(attempt);
      }
      return attempts.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
    } catch { throw storageFailure(); }
  };
  const getState = () => {
    try { return { busy: Boolean(inFlight), pending: copy(read()), error: "" }; }
    catch (error) { return { busy: Boolean(inFlight), pending: [], error: error.message }; }
  };
  const publish = () => { const state = getState(); for (const listener of listeners) { try { listener(state); } catch { /* Observers do not control delivery. */ } } };
  const retain = (attempt) => {
    try {
      const key = KITCHEN_ORDER_ATTEMPT_PREFIX + attempt.id;
      const serialized = JSON.stringify(attempt);
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw storageFailure();
    } catch { throw storageFailure(); }
  };
  // Called only inside the same exclusive critical section as the comparison.
  // A newer generation, or a removed record, must never be cleared or recreated.
  const removeIfCurrent = (attempt) => {
    const current = read().find((candidate) => candidate.id === attempt.id);
    if (!current || current.generation !== attempt.generation || current.kind !== attempt.kind || !sameRequest(current.request, attempt.request)) return false;
    try {
      const key = KITCHEN_ORDER_ATTEMPT_PREFIX + attempt.id;
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw storageFailure();
      return true;
    } catch { throw storageFailure(); }
  };
  const inspectPreparation = (operation) => {
    const attempt = operation.preparedAttempt ?? null;
    const result = { attempt: attempt ? copy(attempt) : null, request: operation.request ? copy(operation.request) : null, state: "unknown", canRelease: false,
      inspect() { const next = inspectPreparation(operation); publish(); return next; } };
    let saved;
    try { saved = read(); } catch { return result; }
    const current = attempt ? saved.find((candidate) => candidate.id === attempt.id) : null;
    if (current && (current.kind !== attempt.kind || !sameRequest(current.request, attempt.request))) return { ...result, state: "changed" };
    // Absence after a published intent is not proof that no other window sent
    // it. Only an absence observed while the original lock was still held, an
    // operation that never prepared an ID, or a confirmed rejection can release.
    return { ...result, state: current ? "present" : "absent", attempt: current ? copy(current) : result.attempt,
      canRelease: !current && (operation.rejectionReleased === true || (!operation.deliveryStarted && (!attempt || operation.absentWhileLocked === true))) };
  };
  const reportFailure = (operation) => {
    for (const observer of operation.failureObservers ?? (typeof operation.onFailure === "function" ? [operation.onFailure] : [])) {
      try { observer(inspectPreparation(operation)); } catch { /* Failure observers cannot change the mutation result. */ }
    }
  };
  const prepare = (operation) => {
    const pending = read();
    let attempt = operation.id ? pending.find((candidate) => candidate.id === operation.id) : pending[0];
    if (operation.id && !attempt) throw failure("確認待ちの記録が変わりました。表示を確認してください。", "KITCHEN_ORDER_PENDING_CHANGED");
    const initial = !attempt;
    if (attempt) {
      if (!operation.id && (attempt.kind !== operation.kind || !sameRequest(attempt.request, operation.request))) throw failure("未確認の追加注文があります。先に保存済みの同じ内容で照合・再送してください。", "KITCHEN_ORDER_PENDING");
    } else {
      const id = idFactory();
      if (!UUID.test(id ?? "") || storage.getItem(KITCHEN_ORDER_ATTEMPT_PREFIX + id) !== null) throw storageFailure();
      attempt = { version: 1, id, kind: operation.kind, request: operation.request, createdAtMs: now() };
    }
    const generation = (attempt.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw storageFailure();
    attempt = { ...attempt, generation };
    Object.assign(operation, { id: attempt.id, kind: attempt.kind, request: attempt.request, preparedAttempt: copy(attempt) });
    try {
      // Bind the actual canonical intent to its source before any storage write.
      // This is an identity notification, not permission to send before commit.
      for (const observer of operation.preparationObservers ?? []) observer(copy(attempt));
      retain(attempt);
    } catch (error) {
      if (initial) {
        try { operation.absentWhileLocked = !read().some((candidate) => candidate.id === attempt.id); } catch { /* Unknown storage keeps the source bound. */ }
      }
      throw error;
    }
    return { attempt, initial };
  };
  const deliver = async ({ attempt, initial }, operation) => {
    const sender = attempt.kind === "addition" ? sendAddition : sendIncrease;
    const payload = { ...copy(attempt.request), [attempt.kind === "addition" ? "clientOrderId" : "operationId"]: attempt.id };
    let result;
    try { operation.deliveryStarted = true; result = await sender(payload); }
    catch (error) {
      // A definitive rejection can release only its own first generation.
      // An old response cannot release a later retry, even in another window.
      if (initial && [400, 401, 403, 404, 409, 422].includes(error?.status) && typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) && !error.code.startsWith("HTTP_")) {
        const removed = await withStorageLock(() => removeIfCurrent(attempt));
        if (removed) { operation.rejectionReleased = true; throw error; }
      }
      throw failure("保存結果が未確認です。内容を変更せず「同じ内容で照合・再送」を押してください。");
    }
    // Receiving an acknowledgement is separate from local cleanup. A cleanup
    // failure must not turn that known result into an unknown network outcome.
    try { await withStorageLock(() => removeIfCurrent(attempt)); }
    catch { /* Keep any remaining record for same-ID reconciliation. */ }
    return result;
  };
  const run = (operation) => {
    if (inFlight) {
      if ((operation.id && inFlight.id === operation.id) || (!operation.id && inFlight.kind === operation.kind && sameRequest(inFlight.request, operation.request))) {
        if (typeof operation.onFailure === "function") inFlight.failureObservers.add(operation.onFailure);
        if (typeof operation.onPrepared === "function") {
          if (inFlight.preparedAttempt) operation.onPrepared(copy(inFlight.preparedAttempt));
          else inFlight.preparationObservers.add(operation.onPrepared);
        }
        return inFlight.promise;
      }
      reportFailure(operation);
      return Promise.reject(failure("追加注文の保存を確認しています。", "KITCHEN_ORDER_BUSY"));
    }
    const flight = { ...operation, preparationObservers: new Set(typeof operation.onPrepared === "function" ? [operation.onPrepared] : []), failureObservers: new Set(typeof operation.onFailure === "function" ? [operation.onFailure] : []) };
    // Reserve the instance lock synchronously, before waiting for other windows.
    // Both preparing a generation and conditionally clearing it use the native
    // cross-window lock. HTTP is deliberately outside either critical section.
    const promise = Promise.resolve().then(() => withStorageLock(() => prepare(flight))).then((prepared) => {
      Object.assign(flight, { id: prepared.attempt.id, kind: prepared.attempt.kind, request: prepared.attempt.request });
      publish();
      return deliver(prepared, flight);
    }).catch((error) => { reportFailure(flight); throw error; }).finally(() => { inFlight = null; publish(); });
    flight.promise = promise;
    inFlight = flight;
    publish();
    return promise;
  };
  const submit = (kind, request, options = {}) => {
    try { return run({ kind, request: normalize(kind, request), onPrepared: options.onPrepared, onFailure: options.onFailure }); }
    catch (error) { reportFailure({ onFailure: options.onFailure }); publish(); return Promise.reject(error); }
  };
  return {
    getState,
    refresh() { publish(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submitAddition(request, options) { return submit("addition", request, options); },
    submitIncrease(request) { return submit("increase", request); },
    retry(id) {
      if (!UUID.test(id ?? "")) return Promise.reject(failure("確認待ちの記録が変わりました。表示を確認してください。", "KITCHEN_ORDER_PENDING_CHANGED"));
      return run({ id });
    },
  };
}
