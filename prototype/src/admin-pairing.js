function configuredAdminToken(env) {
  if (typeof env?.WARUN_ADMIN_API_TOKEN === "string") return env.WARUN_ADMIN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.adminToken === "string") return env.WARUN_RUNTIME_CONFIG.adminToken.trim();
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
