export function configuredAdminToken(env) {
  if (typeof env?.WARUN_ADMIN_API_TOKEN === "string") return env.WARUN_ADMIN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.adminToken === "string") return env.WARUN_RUNTIME_CONFIG.adminToken.trim();
  if (typeof env?.WARUN_API_TOKEN === "string") return env.WARUN_API_TOKEN.trim();
  if (typeof env?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return env.WARUN_RUNTIME_CONFIG.apiToken.trim();
  return "";
}

export class AdminPairingError extends Error {
  constructor(message, { status = 0, code = "PAIRING_REQUEST_FAILED", requestId = "" } = {}) {
    super(message);
    this.name = "AdminPairingError";
    this.status = status;
    this.code = code;
    this.requestId = typeof requestId === "string" ? requestId : "";
  }
}

function normalizePairingCode(value) {
  return typeof value === "string" ? value.replace(/[\s-]/g, "").toUpperCase() : "";
}

export function pairingRegistrationUrl(code, origin) {
  const normalizedCode = normalizePairingCode(code);
  if (!normalizedCode) throw new Error("A pairing code is required.");
  const url = new URL("/pairing.html", origin);
  url.hash = `p=${encodeURIComponent(normalizedCode)}`;
  return url.toString();
}

export function pairingCodeFromLocation(location) {
  const hash = typeof location?.hash === "string" ? location.hash.replace(/^#/, "") : "";
  if (!hash) return "";
  const params = new URLSearchParams(hash);
  const value = params.get("p") ?? params.get("pairing") ?? (hash.includes("=") ? "" : hash);
  return normalizePairingCode(value);
}

function apiBase(env) {
  const configured = typeof env?.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  try { return new URL(configured || "/v1", env.location?.origin).toString().replace(/\/+$/, ""); } catch { return null; }
}

function errorCodeForStatus(status, fallback = "PAIRING_REQUEST_FAILED") {
  if (status === 401) return "AUTH_TOKEN_MISMATCH";
  if (status === 409) return "TABLE_CONFLICT";
  if (status === 503) return "API_UNAVAILABLE";
  return fallback;
}

async function responseError(response, fallbackMessage = "管理APIの応答を確認できませんでした。") {
  let body;
  try { body = await response.json(); } catch { /* Keep the status-based error. */ }
  const serverCode = body?.error?.code;
  const code = errorCodeForStatus(response.status, serverCode || undefined);
  const requestId = response.headers?.get?.("x-request-id") || body?.error?.requestId || "";
  throw new AdminPairingError(fallbackMessage, { status: response.status, code, requestId });
}

function assertAdminTransport({ env, fetchImpl }) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token) throw new AdminPairingError("管理者tokenが設定されていません。", { status: 401, code: "AUTH_TOKEN_MISMATCH" });
  if (!base || typeof fetchImpl !== "function") throw new AdminPairingError("管理APIへ接続できません。", { status: 503, code: "API_UNAVAILABLE" });
  return { token, base, fetchImpl };
}

export async function fetchAdminPairingPreflight({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const { token, base, fetchImpl: request } = assertAdminTransport({ env, fetchImpl });
  let response;
  try {
    response = await request(`${base}/admin/pairing-preflight`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AdminPairingError("管理APIへ接続できません。", { status: 503, code: "API_UNAVAILABLE" });
  }
  if (!response.ok) await responseError(response);
  const body = await response.json();
  if (
    body?.authentication?.status !== "valid"
    || body.authentication.role !== "admin"
    || !body.database
    || !body.server
    || !body.tables
    || !body.pairing
  ) {
    throw new AdminPairingError("管理APIのpreflight応答が不正です。", { status: 503, code: "API_UNAVAILABLE" });
  }
  return body;
}

export async function fetchAdminDiagnostics({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const { token, base, fetchImpl: request } = assertAdminTransport({ env, fetchImpl });
  let response;
  try {
    response = await request(`${base}/admin/diagnostics`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AdminPairingError("通信診断APIへ接続できません。", { status: 503, code: "API_UNAVAILABLE" });
  }
  if (!response.ok) await responseError(response, "通信診断を取得できません。");
  const body = await response.json();
  if (!body?.runtime || !body?.authentication || !body?.tables || !body?.storage) {
    throw new AdminPairingError("通信診断の応答が不正です。", { status: 503, code: "API_UNAVAILABLE" });
  }
  return body;
}

export async function issueCustomerPairingCode({ env = globalThis, tableId, expiresAtMs, fetchImpl = env.fetch } = {}) {
  const { token, base, fetchImpl: request } = assertAdminTransport({ env, fetchImpl });
  let response;
  try {
    response = await request(`${base}/admin/pairing-codes`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: "customer", tableId, expiresAtMs }),
    });
  } catch {
    throw new AdminPairingError("管理APIへ接続できません。", { status: 503, code: "API_UNAVAILABLE" });
  }
  if (response.status !== 201) await responseError(response, "ペアリングコードを発行できません。");
  const body = await response.json();
  if (typeof body?.code !== "string" || body.role !== "customer" || body.tableId !== tableId || typeof body.pairingUrl !== "string") {
    throw new AdminPairingError("ペアリング応答に現在のLAN URLがありません。", { status: 503, code: "PAIRING_URL_INVALID" });
  }
  return { code: body.code, tableId: body.tableId, expiresAtMs: body.expiresAtMs, pairingUrl: body.pairingUrl };
}

export async function revokeAdminDevice({ env = globalThis, deviceId, fetchImpl = env.fetch } = {}) {
  const { token, base, fetchImpl: request } = assertAdminTransport({ env, fetchImpl });
  let response;
  try {
    response = await request(`${base}/admin/devices/revoke`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId }),
    });
  } catch {
    throw new AdminPairingError("管理APIへ接続できません。", { status: 503, code: "API_UNAVAILABLE" });
  }
  if (response.status !== 200) await responseError(response, "端末の接続解除に失敗しました。");
  const body = await response.json();
  if (body?.deviceId !== deviceId || body.status !== "revoked") {
    throw new AdminPairingError("端末の接続解除応答が不正です。", { status: 503, code: "API_UNAVAILABLE" });
  }
  return body;
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

export async function fetchAdminMenu({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin catalog is not configured.");
  const response = await fetchImpl(`${base}/menu`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Admin catalog could not be loaded.");
  const body = await response.json();
  if (body?.audience !== "admin" || !Array.isArray(body.categories) || !Array.isArray(body.items)) {
    throw new Error("Admin catalog response was invalid.");
  }
  return body;
}

export async function saveAdminMenuItem({ env = globalThis, item, expectedVersion = item?.version ?? 0, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin catalog is not configured.");
  const response = await fetchImpl(`${base}/admin/catalog/menu-item`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      expectedVersion,
      menuItemId: item.id,
      categoryId: item.categoryId,
      formalName: item.name,
      kitchenAlias: item.kitchenAlias || item.name,
      description: item.description || "",
      priceYen: item.price,
      isSoldOut: Boolean(item.isSoldOut),
      isActive: item.isActive !== false,
      sortOrder: item.sortOrder ?? 0,
      imageUri: item.imageUri ?? null,
      sectionKey: item.sectionKey ?? null,
      detail: {
        enabled: Boolean(item.detail?.enabled),
        showImageInList: Boolean(item.detail?.showImageInList),
        imageUri: item.detail?.imageUri ?? null,
        reading: item.detail?.reading ?? "",
        itemType: item.detail?.itemType ?? "",
        origin: item.detail?.origin ?? "",
        producer: item.detail?.producer ?? "",
        taste: item.detail?.taste ?? "",
        aroma: item.detail?.aroma ?? "",
        sweetness: item.detail?.sweetness ?? "",
        finish: item.detail?.finish ?? "",
        recommendation: item.detail?.recommendation ?? "",
        description: item.detail?.description ?? "",
      },
      variants: (item.variants ?? []).map((variant, index) => ({
        variantId: variant.variantId,
        name: variant.name,
        volumeLabel: variant.volumeLabel ?? "",
        priceYen: variant.priceYen,
        isActive: variant.isActive !== false,
        sortOrder: variant.sortOrder ?? index + 1,
        temperatureOptions: Array.isArray(variant.temperatureOptions) ? [...variant.temperatureOptions] : undefined,
      })),
      servingOptions: (item.servingOptions ?? []).map((option, index) => ({
        servingOptionId: option.servingOptionId,
        name: option.name,
        isActive: option.isActive !== false,
        sortOrder: option.sortOrder ?? index + 1,
      })),
    }),
  });
  if (!response.ok) await responseError(response, "管理カタログを保存できません。");
  const body = await response.json();
  if (body?.menuItemId !== item.id || !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new Error("Admin catalog write response was invalid.");
  }
  return body;
}

async function saveAdminCatalogResource({ env = globalThis, path, body, fetchImpl = env.fetch, invalidMessage }) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin catalog is not configured.");
  const response = await fetchImpl(`${base}${path}`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) await responseError(response, "管理カタログを保存できません。");
  const result = await response.json();
  if (!result || typeof result.categoryId !== "string" || !Number.isSafeInteger(result.version)) throw new Error(invalidMessage);
  return result;
}

export function saveAdminCategory({ env = globalThis, category = {}, expectedVersion = category.version ?? 0, fetchImpl = env.fetch } = {}) {
  return saveAdminCatalogResource({
    env, fetchImpl, path: "/admin/catalog/category", invalidMessage: "Admin category write response was invalid.",
    body: { categoryId: category.id ?? null, expectedVersion, name: category.name, sectionKey: category.sectionKey, sortOrder: category.sortOrder ?? 0, isVisible: category.isVisible === true },
  });
}

export function saveAdminMenuOrdering({ env = globalThis, categoryId, menuItemIds, expectedVersion = 0, fetchImpl = env.fetch } = {}) {
  return saveAdminCatalogResource({
    env, fetchImpl, path: "/admin/catalog/menu-order", invalidMessage: "Admin menu ordering response was invalid.",
    body: { categoryId, menuItemIds, expectedVersion },
  });
}

export async function saveAdminImageLayouts({ env = globalThis, menuItemId, expectedVersion, layouts, fetchImpl = env.fetch } = {}) {
  const token = configuredAdminToken(env);
  const base = apiBase(env);
  if (!token || !base || typeof fetchImpl !== "function") throw new Error("Admin catalog is not configured.");
  const response = await fetchImpl(`${base}/admin/catalog/menu-item/image-layouts`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ expectedVersion, menuItemId, layouts }),
  });
  if (!response.ok) await responseError(response, "画像構図を保存できません。");
  const body = await response.json();
  if (body?.menuItemId !== menuItemId || !Number.isSafeInteger(body.version)) throw new Error("Image layout response was invalid.");
  return body;
}
