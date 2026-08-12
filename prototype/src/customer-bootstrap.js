import { createCustomerOrderClient } from "./order-outbox.js";
import { createIndexedDbCredentialStore, runtimeForCustomerCredentials } from "./device-credentials.js";
import { customerCatalogErrorCode } from "./customer-catalog.js";

export async function bootstrapCustomerOrderSession({
  globalObject = globalThis,
  credentialStore,
  createClient = createCustomerOrderClient,
  loadCatalog,
} = {}) {
  if (globalObject?.WARUN_ORDER_MODE === "demo") {
    return { client: createClient({ global: globalObject }), mode: "demo", catalog: null, catalogErrorCode: null };
  }

  const store = credentialStore || createIndexedDbCredentialStore({ indexedDB: globalObject?.indexedDB });
  const credentials = await store.load();
  if (typeof credentials?.token !== "string" || credentials.token.trim() === "") {
    return { client: null, mode: "pairing", catalog: null, catalogErrorCode: null };
  }

  const baseUrl = new URL("/v1", globalObject.location.origin).toString().replace(/\/+$/, "");
  const runtime = runtimeForCustomerCredentials({ globalObject, baseUrl, token: credentials.token });
  const client = createClient({ global: runtime, indexedDB: globalObject.indexedDB });
  if (typeof loadCatalog !== "function") return { client, mode: "api", catalog: null, catalogErrorCode: null };
  try {
    return { client, mode: "api", catalog: await loadCatalog({ globalObject: runtime }), catalogErrorCode: null };
  } catch (error) {
    return { client, mode: "api", catalog: null, catalogErrorCode: customerCatalogErrorCode(error) };
  }
}

export async function bootstrapCustomerOrderClient(options = {}) {
  return (await bootstrapCustomerOrderSession(options)).client;
}
