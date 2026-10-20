export function beginCheckoutRead(current, visitContextId) {
  if (current.loaded && current.visitContextId === visitContextId) return current;
  return { ...current, loading: true, error: false, errorDetails: null, visitContextId };
}

export function isPassiveMissingCheckoutSession(error, { explicitlyOpened = false } = {}) {
  return explicitlyOpened !== true
    && Number(error?.status) === 404
    && error?.code === "CHECKOUT_SESSION_NOT_FOUND";
}

export function isCheckoutModalForCurrentVisit({ modal, openedForVisitContextId, currentVisitContextId } = {}) {
  return modal === "checkout" && openedForVisitContextId === currentVisitContextId;
}
