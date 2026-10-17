export const CUSTOMER_STAFF_CALL_COOLDOWN_MS = 30_000;

export function customerStaffCallCooldownKey(deviceId, visitContextId) {
  if (typeof deviceId !== "string" || !deviceId || typeof visitContextId !== "string" || !visitContextId) return null;
  return `warun-staff-call-cooldown:${deviceId}:${visitContextId}`;
}

export function parseCustomerStaffCallCooldown(value, now = Date.now()) {
  try {
    const record = JSON.parse(value);
    if (typeof record?.staffCallId !== "string" || !record.staffCallId
      || !Number.isSafeInteger(record.untilAtMs) || record.untilAtMs <= now) return null;
    return record;
  } catch {
    return null;
  }
}

export function customerStaffCallCooldownSeconds(record, now = Date.now()) {
  return record ? Math.max(0, Math.ceil((record.untilAtMs - now) / 1000)) : 0;
}

export function isCustomerStaffCallSuccessNotice(notice, staffCallId) {
  return notice?.kind === "success" && typeof staffCallId === "string" && notice.staffCallId === staffCallId;
}

export function isMatchingCustomerStaffCallResolution(event, { staffCallId, visitContextId } = {}) {
  const eventType = event?.payload?.type ?? event?.type;
  const eventCallId = event?.payload?.staffCallId ?? event?.staffCallId ?? event?.aggregateId;
  const eventVisitContextId = event?.payload?.visitContextId ?? event?.visitContextId;
  return eventType === "staff_call.resolved"
    && typeof staffCallId === "string" && eventCallId === staffCallId
    && typeof visitContextId === "string"
    && (!eventVisitContextId || eventVisitContextId === visitContextId);
}
