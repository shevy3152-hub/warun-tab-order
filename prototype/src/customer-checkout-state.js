export function beginCheckoutRead(current, visitContextId) {
  if (current.loaded && current.visitContextId === visitContextId) return current;
  return { ...current, loading: true, error: false, errorDetails: null, visitContextId };
}
