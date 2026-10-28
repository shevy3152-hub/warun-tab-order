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

export function checkoutPostResponseDisposition({ checkout, checkoutRequestId, previousCheckoutId, observedCheckout, observationAdvanced } = {}) {
  if (!checkout || checkout.checkoutRequestId !== checkoutRequestId
    || !Number.isSafeInteger(checkout.version) || checkout.version < 1) return "invalid";
  if (!observedCheckout) return "apply";
  if (observedCheckout.checkoutRequestId === checkoutRequestId) {
    if (!Number.isSafeInteger(observedCheckout.version)
      || checkout.version < observedCheckout.version
      || (checkout.version === observedCheckout.version && observationAdvanced)) return "superseded";
    return "apply";
  }
  // A new request may replace the previously observed cancelled request; versions are per ID.
  return observedCheckout.checkoutRequestId === previousCheckoutId ? "apply" : "superseded";
}
