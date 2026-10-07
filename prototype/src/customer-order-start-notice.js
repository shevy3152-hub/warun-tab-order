const ACKNOWLEDGEMENT_PREFIX = "warun:customer-order-start-notice:v1:";

export const DEFAULT_CUSTOMER_ORDER_START_NOTICE = Object.freeze({
  heading: "ご注文の前にご確認ください",
  body: [
    "20歳未満の入店禁止",
    "飲酒運転しません・させません",
    "SNS投稿・LIVE配信禁止",
    "お支払いは現金のみ",
  ].join("\n"),
});

function devicePrefix(deviceId) {
  return `${ACKNOWLEDGEMENT_PREFIX}${encodeURIComponent(String(deviceId))}:`;
}

export function createCustomerOrderStartNoticeScopeKey({ deviceId, tableId, visitContextId } = {}) {
  const normalizedTableId = Number(tableId);
  if (
    typeof deviceId !== "string" || !deviceId.trim()
    || !Number.isSafeInteger(normalizedTableId) || normalizedTableId < 1
    || typeof visitContextId !== "string" || !visitContextId.trim()
  ) return null;
  return `${devicePrefix(deviceId)}${normalizedTableId}:${encodeURIComponent(visitContextId)}`;
}

export function hasCustomerOrderStartNoticeAcknowledgement({ scopeKey, storage } = {}) {
  if (typeof scopeKey !== "string" || !scopeKey.startsWith(ACKNOWLEDGEMENT_PREFIX)) return false;
  try {
    const store = storage ?? globalThis.localStorage;
    return store?.getItem(scopeKey) === "confirmed";
  } catch {
    return false;
  }
}

export function acknowledgeCustomerOrderStartNotice({ scopeKey, storage } = {}) {
  if (typeof scopeKey !== "string" || !scopeKey.startsWith(ACKNOWLEDGEMENT_PREFIX)) return false;
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(scopeKey, "confirmed");
    return true;
  } catch {
    return false;
  }
}

export function clearCustomerOrderStartNoticeAcknowledgements({ deviceId, storage } = {}) {
  if (typeof deviceId !== "string" || !deviceId.trim()) return 0;
  try {
    const store = storage ?? globalThis.localStorage;
    if (!store) return 0;
    const prefix = devicePrefix(deviceId);
    const matchingKeys = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (typeof key === "string" && key.startsWith(prefix)) matchingKeys.push(key);
    }
    matchingKeys.forEach((key) => store.removeItem(key));
    return matchingKeys.length;
  } catch {
    return 0;
  }
}
