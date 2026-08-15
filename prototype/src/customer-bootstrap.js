import { createCustomerOrderClient } from "./order-outbox.js";
import { createIndexedDbCredentialStore, runtimeForCustomerCredentials } from "./device-credentials.js";

export async function bootstrapCustomerOrderClient({ globalObject = globalThis, credentialStore, createClient = createCustomerOrderClient, onConfig } = {}) {
  if (globalObject?.WARUN_ORDER_MODE === "demo") {
    return createClient({ global: globalObject });
  }

  const store = credentialStore || createIndexedDbCredentialStore({ indexedDB: globalObject?.indexedDB });
  const credentials = await store.load();
  if (typeof credentials?.token !== "string" || credentials.token.trim() === "") return null;

  onConfig?.(credentials.config ?? null);
  const baseUrl = new URL("/v1", globalObject.location.origin).toString().replace(/\/+$/, "");
  const runtime = runtimeForCustomerCredentials({ globalObject, baseUrl, token: credentials.token });
  return createClient({ global: runtime, indexedDB: globalObject.indexedDB });
}
