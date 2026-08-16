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

export function kitchenApiConfigured(env = globalThis) {
  return Boolean(kitchenToken(env) && apiBase(env));
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
