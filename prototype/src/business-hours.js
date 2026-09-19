export const DEFAULT_BUSINESS_HOURS = Object.freeze({
  openTime: "17:00",
  closeTime: "24:00",
  lastOrderTime: "23:30",
  isVisible: true,
  version: 0,
  updatedAtMs: 0,
  displayText: "17:00－24:00（ラストオーダー23:30）",
});

const TIME_PATTERN = /^(?:[01][0-9]|2[0-9]):[0-5][0-9]$/;

function validTime(value) {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

export function normalizeBusinessHours(value, { includeVersion = false } = {}) {
  if (!value || typeof value !== "object"
    || !validTime(value.openTime)
    || !validTime(value.closeTime)
    || !validTime(value.lastOrderTime)
    || typeof value.isVisible !== "boolean"
    || (includeVersion && (!Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.updatedAtMs)))) {
    throw new Error("営業時間APIの応答が不正です。");
  }
  const openTime = value.openTime;
  const closeTime = value.closeTime;
  const lastOrderTime = value.lastOrderTime;
  return Object.freeze({
    openTime,
    closeTime,
    lastOrderTime,
    isVisible: value.isVisible,
    version: includeVersion ? value.version : Number.isSafeInteger(value.version) ? value.version : 0,
    updatedAtMs: includeVersion ? value.updatedAtMs : Number.isSafeInteger(value.updatedAtMs) ? value.updatedAtMs : 0,
    displayText: typeof value.displayText === "string"
      ? value.displayText
      : `${openTime}－${closeTime}（ラストオーダー${lastOrderTime}）`,
  });
}

export function splitBusinessHoursTime(value) {
  const [hour, minute] = String(value ?? "17:00").split(":");
  return { hour: hour.padStart(2, "0"), minute: minute?.padStart(2, "0") ?? "00" };
}

export function combineBusinessHoursTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function businessHoursHourLabel(hour) {
  const numericHour = Number(hour);
  return numericHour >= 24 ? `翌日 ${numericHour}時` : `${numericHour}時`;
}

export function businessHoursDisplay(settings) {
  const normalized = normalizeBusinessHours(settings);
  return {
    range: `${normalized.openTime} — ${normalized.closeTime}`,
    lastOrder: `（ラストオーダー ${normalized.lastOrderTime}）`,
  };
}

function apiBase(env) {
  const configured = typeof env?.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  try { return new URL(configured || "/v1", env.location?.origin).toString().replace(/\/+$/, ""); } catch { return null; }
}

export async function fetchPublicBusinessHours({ env = globalThis, fetchImpl = env.fetch } = {}) {
  const base = apiBase(env);
  if (!base || typeof fetchImpl !== "function") return DEFAULT_BUSINESS_HOURS;
  try {
    const response = await fetchImpl(`${base}/business-hours`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeBusinessHours(await response.json());
  } catch {
    return DEFAULT_BUSINESS_HOURS;
  }
}
