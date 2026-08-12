export const CUSTOMER_CATALOG_ERROR_CODES = Object.freeze({
  API_UNCONFIGURED: "CUSTOMER_API_UNCONFIGURED",
  CONFIG_INVALID: "CUSTOMER_CONFIG_INVALID",
  MENU_INVALID: "CUSTOMER_MENU_INVALID",
  MENU_EMPTY: "CUSTOMER_MENU_EMPTY",
  UNAVAILABLE: "CUSTOMER_CATALOG_UNAVAILABLE",
});

export class CustomerCatalogError extends Error {
  constructor(code) {
    super(code);
    this.name = "CustomerCatalogError";
    this.code = code;
  }
}

function apiBase(globalObject) {
  try {
    const configured = typeof globalObject?.WARUN_API_BASE === "string" && globalObject.WARUN_API_BASE.trim()
      ? globalObject.WARUN_API_BASE
      : "/v1";
    return new URL(configured, globalObject.location?.origin).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function token(globalObject) {
  if (typeof globalObject?.WARUN_API_TOKEN === "string") return globalObject.WARUN_API_TOKEN.trim();
  if (typeof globalObject?.WARUN_RUNTIME_CONFIG?.apiToken === "string") return globalObject.WARUN_RUNTIME_CONFIG.apiToken.trim();
  return "";
}

function requestHeaders(globalObject) {
  const value = token(globalObject);
  return value ? { Accept: "application/json", Authorization: `Bearer ${value}` } : null;
}

async function fetchJson({ globalObject, path, fetchImpl }) {
  const base = apiBase(globalObject);
  const headers = requestHeaders(globalObject);
  const fetcher = fetchImpl || globalObject?.fetch;
  if (!base || !headers || typeof fetcher !== "function") {
    throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.API_UNCONFIGURED);
  }
  let response;
  try {
    response = await fetcher(`${base}${path}`, { headers });
  } catch {
    throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.UNAVAILABLE);
  }
  if (!response?.ok) throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.UNAVAILABLE);
  try {
    return await response.json();
  } catch {
    throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.UNAVAILABLE);
  }
}

function mapDeviceConfig(config) {
  if (!config || config.role !== "customer" || config.status !== "active"
    || typeof config.deviceId !== "string" || !Number.isSafeInteger(config.tableId)) {
    throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.CONFIG_INVALID);
  }
  return {
    deviceId: config.deviceId,
    tableId: String(config.tableId),
    tableLabel: typeof config.tableLabel === "string" ? config.tableLabel : `Table ${config.tableId}`,
  };
}

function mapMenu(menu) {
  if (!menu || menu.audience !== "customer" || !Array.isArray(menu.categories) || !Array.isArray(menu.items)) {
    throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.MENU_INVALID);
  }
  if (menu.items.length === 0) throw new CustomerCatalogError(CUSTOMER_CATALOG_ERROR_CODES.MENU_EMPTY);
  return {
    categories: menu.categories.map((category) => ({
      id: category.categoryId,
      name: category.name,
      sortOrder: category.sortOrder,
      isVisible: true,
    })),
    menuItems: menu.items.map((item) => ({
      id: item.menuItemId,
      categoryId: item.categoryId,
      name: item.formalName,
      description: item.description || "",
      isSoldOut: Boolean(item.isSoldOut),
      sortOrder: item.sortOrder,
    })),
  };
}

export async function fetchCustomerCatalog({ globalObject = globalThis, fetchImpl } = {}) {
  const [config, menu] = await Promise.all([
    fetchJson({ globalObject, path: "/device/config", fetchImpl }),
    fetchJson({ globalObject, path: "/menu", fetchImpl }),
  ]);
  return { ...mapDeviceConfig(config), ...mapMenu(menu) };
}

export function customerCatalogErrorCode(error) {
  return error instanceof CustomerCatalogError && Object.values(CUSTOMER_CATALOG_ERROR_CODES).includes(error.code)
    ? error.code
    : CUSTOMER_CATALOG_ERROR_CODES.UNAVAILABLE;
}
