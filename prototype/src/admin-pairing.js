export function configuredAdminToken(env) {
  if (typeof env?.WARUN_ADMIN_API_TOKEN === "string") return env.WARUN_ADMIN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.adminToken === "string") return env.WARUN_RUNTIME_CONFIG.adminToken.trim();
  if (typeof env?.WARUN_API_TOKEN === "string") return env.WARUN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return env.WARUN_RUNTIME_CONFIG.apiToken.trim();
  return "";
}

function apiBase(env) {
  const configured = typeof env?.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  try { return new URL(configured || "/v1", env.location?.origin).toString().replace(/\/+$/, ""); } catch { return null; }
}

export async function issueCustomerPairingCode({ env = globalThis, tableId, expiresAtMs, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin pairing is not configured.");
  const response = await fetchImpl(`${base}/admin/pairing-codes`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "customer", tableId, expiresAtMs }),
  });
  if (!response.ok) throw new Error("Pairing code could not be issued.");
  const body = await response.json();
  if (typeof body?.code !== "string" || body.role !== "customer" || body.tableId !== tableId) throw new Error("Pairing response was invalid.");
  return { code: body.code, tableId: body.tableId, expiresAtMs: body.expiresAtMs };
}

export async function fetchAdminOrderHistory({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin history is not configured.");
  const response = await fetchImpl(`${base}/admin/order-history`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Order history could not be loaded.");
  const body = await response.json();
  if (!Array.isArray(body?.orders)) throw new Error("Order history response was invalid.");
  return body.orders;
}

export async function fetchAdminRegistrationRequests({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin registration is not configured.");
  const response = await fetchImpl(`${base}/admin/registration-requests`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Registration requests could not be loaded.");
  const body = await response.json();
  if (!Array.isArray(body?.requests)) throw new Error("Registration request response was invalid.");
  return body.requests;
}

export async function approveAdminRegistrationRequest({ env = globalThis, requestId, tableId, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin registration is not configured.");
  const response = await fetchImpl(`${base}/admin/registration-requests/approve`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId, tableId }),
  });
  if (!response.ok) throw new Error("Registration approval failed.");
  return response.json();
}
