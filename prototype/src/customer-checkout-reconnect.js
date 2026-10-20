const VISIT_CONTEXT_ID_PATTERN = /^v1_[0-9a-f]{64}$/;

export function isMatchingCustomerCheckoutReconnectVisit({ refreshedVisitContextId, currentVisitContextId } = {}) {
  return typeof refreshedVisitContextId === "string"
    && VISIT_CONTEXT_ID_PATTERN.test(refreshedVisitContextId)
    && refreshedVisitContextId === currentVisitContextId;
}

export function createCustomerCheckoutReconnectHandler({ refreshVisitState, onRefreshReady } = {}) {
  if (typeof refreshVisitState !== "function") throw new TypeError("refreshVisitState must be a function.");
  if (typeof onRefreshReady !== "function") throw new TypeError("onRefreshReady must be a function.");
  let latestAttempt = 0;

  return async function refreshCheckoutAfterReconnect() {
    const attempt = ++latestAttempt;
    let config;
    try {
      config = await refreshVisitState();
    } catch {
      return false;
    }
    if (attempt !== latestAttempt
      || config?.role !== "customer"
      || !VISIT_CONTEXT_ID_PATTERN.test(config.visitContextId || "")) return false;
    onRefreshReady(config.visitContextId);
    return true;
  };
}
