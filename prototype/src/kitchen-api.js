function kitchenToken(env) {
  if (typeof env?.WARUN_KITCHEN_API_TOKEN === "string") return env.WARUN_KITCHEN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.kitchenToken === "string") return env.WARUN_RUNTIME_CONFIG.kitchenToken.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return env.WARUN_RUNTIME_CONFIG.apiToken.trim();
  const metaToken = env?.document?.querySelector?.('meta[name="warun-kitchen-token"]')?.getAttribute?.("content");
  if (typeof metaToken === "string") return metaToken.trim();
  return "";
}

function apiBase(env) {
  try {
    return new URL(typeof env?.WARUN_API_BASE === "string" && env.WARUN_API_BASE.trim() ? env.WARUN_API_BASE : "/v1", env.location?.origin).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function headers(env) {
  const token = kitchenToken(env);
  return token ? { Accept: "application/json", Authorization: `Bearer ${token}` } : null;
}

export class KitchenApiError extends Error {
  constructor(message, { status = 0, code = "KITCHEN_API_ERROR" } = {}) {
    super(message);
    this.name = "KitchenApiError";
    this.status = status;
    this.code = code;
  }
}

async function responseError(response, fallback) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON errors retain the HTTP status */ }
  const code = typeof body?.error?.code === "string" ? body.error.code : `HTTP_${response.status}`;
  return new KitchenApiError(fallback, { status: response.status, code });
}

function checkoutBase(env, fetchImpl) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new KitchenApiError("Kitchen API is not configured.", { code: "API_UNAVAILABLE" });
  return { base, requestHeaders };
}

function mapCheckout(checkout) {
  return {
    ...checkout,
    tableId: checkout.tableId == null ? null : String(checkout.tableId),
    requestedAt: checkout.requestedAtMs ? new Date(checkout.requestedAtMs).toISOString() : null,
    readyAt: checkout.readyAtMs ? new Date(checkout.readyAtMs).toISOString() : null,
    updatedAt: checkout.updatedAtMs ? new Date(checkout.updatedAtMs).toISOString() : null,
    adjustments: Array.isArray(checkout.adjustments) ? checkout.adjustments.map((item) => ({ ...item })) : [],
  };
}

export function kitchenApiConfigured(env = globalThis) {
  return Boolean(kitchenToken(env) && apiBase(env));
}

export async function fetchKitchenCheckoutRequests({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const { base, requestHeaders } = checkoutBase(env, fetchImpl);
  const response = await fetchImpl(`${base}/kitchen/checkout-requests`, { headers: requestHeaders });
  if (!response.ok) throw await responseError(response, "会計依頼を取得できません。");
  const body = await response.json();
  if (!Array.isArray(body?.checkouts)) throw new KitchenApiError("会計依頼レスポンスが不正です。", { code: "INVALID_RESPONSE" });
  return body.checkouts.map(mapCheckout);
}

async function checkoutMutation({ env = globalThis, checkoutRequestId, operation, body, fetchImpl = env.fetch } = {}) {
  const { base, requestHeaders } = checkoutBase(env, fetchImpl);
  const response = await fetchImpl(`${base}/kitchen/checkout-requests/${encodeURIComponent(checkoutRequestId)}/${operation}`, {
    method: operation === "adjustments" ? "PUT" : "POST",
    headers: { ...requestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response, operation === "ready" ? "会計確定に失敗しました。" : operation === "cancel" ? "会計依頼の取消に失敗しました。" : "追加料金の保存に失敗しました。");
  const result = await response.json();
  if (!result?.checkoutRequestId || !result?.status) throw new KitchenApiError("会計更新レスポンスが不正です。", { code: "INVALID_RESPONSE" });
  return mapCheckout(result);
}

export function saveKitchenCheckoutAdjustments({ checkoutRequestId, expectedVersion, adjustments, ...options } = {}) {
  return checkoutMutation({ ...options, checkoutRequestId, operation: "adjustments", body: { expectedVersion, adjustments } });
}

export function readyKitchenCheckout({ checkoutRequestId, expectedVersion, ...options } = {}) {
  return checkoutMutation({ ...options, checkoutRequestId, operation: "ready", body: { expectedVersion } });
}

export function cancelKitchenCheckout({ checkoutRequestId, expectedVersion, ...options } = {}) {
  return checkoutMutation({ ...options, checkoutRequestId, operation: "cancel", body: { expectedVersion } });
}

export function subscribeKitchenInvalidations({ env = globalThis, fetchImpl = env.fetch, onEvent } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function" || typeof onEvent !== "function") return () => {};
  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let eventEpoch = null;
  let lastEventId = 0;
  const schedule = () => {
    if (!stopped && retryTimer === null) retryTimer = (env.setTimeout || setTimeout)(() => { retryTimer = null; void connect(); }, 1000);
  };
  const connect = async () => {
    if (stopped) return;
    controller = typeof AbortController === "function" ? new AbortController() : null;
    const eventHeaders = { ...requestHeaders, Accept: "text/event-stream" };
    if (eventEpoch) { eventHeaders["X-Event-Epoch"] = eventEpoch; eventHeaders["Last-Event-ID"] = String(lastEventId); }
    try {
      const response = await fetchImpl(`${base}/events`, { headers: eventHeaders, ...(controller ? { signal: controller.signal } : {}) });
      if (response.status === 410) { eventEpoch = null; lastEventId = 0; }
      if (response.ok && response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            const id = frame.split(/\r?\n/).find((line) => line.startsWith("id:"))?.slice(3).trim();
            if (id && /^\d+$/.test(id)) lastEventId = Number(id);
            try {
              const event = JSON.parse(data);
              if (typeof event?.eventEpoch === "string") eventEpoch = event.eventEpoch;
              onEvent(event);
            } catch { /* ignore keep-alive and malformed frames */ }
          }
        }
      }
    } catch { /* reconnect below */ }
    finally { controller = null; schedule(); }
  };
  void connect();
  return () => {
    stopped = true;
    if (retryTimer !== null) (env.clearTimeout || clearTimeout)(retryTimer);
    retryTimer = null;
    controller?.abort?.();
  };
}

export async function fetchKitchenSnapshot({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new Error("Kitchen API is not configured.");
  const response = await fetchImpl(`${base}/snapshot`, { headers: requestHeaders });
  if (!response.ok) throw new Error("Kitchen orders could not be loaded.");
  const body = await response.json();
  if (!Array.isArray(body?.activeOrders)) throw new Error("Kitchen order response was invalid.");
  return {
    orders: body.activeOrders.map((order) => ({
      id: order.orderId,
      tableId: String(order.tableId),
      sessionId: order.sessionId,
      createdAt: new Date(order.acceptedAtMs).toISOString(),
      status: order.status,
      totalAmount: order.totalAmountYen,
      items: order.items.map((item) => ({
        id: String(item.orderItemId),
        menuItemId: item.menuItemId,
        nameSnapshot: item.formalNameSnapshot,
        kitchenAlias: item.kitchenAliasSnapshot,
        variantId: item.variantId,
        variantNameSnapshot: item.variantNameSnapshot,
        variantVolumeSnapshot: item.variantVolumeSnapshot,
        temperatureSnapshot: item.temperatureSnapshot,
        servingOptionId: item.servingOptionId,
        servingOptionNameSnapshot: item.servingOptionNameSnapshot,
        quantity: item.quantity,
        isServed: item.isServed,
        servedAt: item.servedAtMs ? new Date(item.servedAtMs).toISOString() : null,
      })),
    })),
    sessions: (Array.isArray(body.openSessions) ? body.openSessions : []).map((session) => ({
      sessionId: session.sessionId,
      tableId: String(session.tableId),
      openedAt: new Date(session.openedAtMs).toISOString(),
      version: session.version,
    })),
  };
}

export async function fetchKitchenOrders(options = {}) {
  return (await fetchKitchenSnapshot(options)).orders;
}

export async function fetchKitchenOrderHistory({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new Error("Kitchen API is not configured.");
  const response = await fetchImpl(`${base}/kitchen/order-history`, { headers: requestHeaders });
  if (!response.ok) throw new Error("Kitchen order history could not be loaded.");
  const body = await response.json();
  if (!Array.isArray(body?.orders)) throw new Error("Kitchen order history response was invalid.");
  return body.orders;
}

export async function markKitchenItemServed({ env = globalThis, orderId, orderItemId, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new Error("Kitchen API is not configured.");
  const response = await fetchImpl(`${base}/kitchen/order-items/serve`, {
    method: "POST",
    headers: { ...requestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, orderItemId: Number(orderItemId) }),
  });
  if (!response.ok) throw new Error("Serving update failed.");
}

export async function closeKitchenTableSession({ env = globalThis, tableId, sessionId, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new Error("Kitchen API is not configured.");
  const response = await fetchImpl(`${base}/tables/sessions/close`, {
    method: "POST",
    headers: { ...requestHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ tableId: Number(tableId), sessionId }),
  });
  if (!response.ok) throw new Error("Table session close failed.");
  const body = await response.json();
  if (!body || body.tableId !== Number(tableId) || body.sessionId !== sessionId) throw new Error("Table session close response was invalid.");
  return body;
}
