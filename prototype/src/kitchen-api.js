function kitchenToken(env) {
  if (typeof env?.WARUN_KITCHEN_API_TOKEN === "string") return env.WARUN_KITCHEN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.kitchenToken === "string") return env.WARUN_RUNTIME_CONFIG.kitchenToken.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return env.WARUN_RUNTIME_CONFIG.apiToken.trim();
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

export async function fetchKitchenOrders({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  const requestHeaders = headers(env);
  if (!base || !requestHeaders || typeof fetchImpl !== "function") throw new Error("Kitchen API is not configured.");
  const response = await fetchImpl(`${base}/snapshot`, { headers: requestHeaders });
  if (!response.ok) throw new Error("Kitchen orders could not be loaded.");
  const body = await response.json();
  if (!Array.isArray(body?.activeOrders)) throw new Error("Kitchen order response was invalid.");
  return body.activeOrders.map((order) => ({
    id: order.orderId,
    tableId: String(order.tableId),
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
  }));
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
