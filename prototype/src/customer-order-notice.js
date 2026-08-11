const NOTICE_MESSAGES = Object.freeze({
  sending: "\u9001\u4fe1\u4e2d\u3067\u3059\u3002\u6ce8\u6587\u3092\u4fdd\u5b58\u3057\u3066\u3044\u307e\u3059\u3002",
  retrying: "\u518d\u9001\u4e2d\u3067\u3059\u3002",
  synced: "\u9001\u4fe1\u6e08\u307f\u3067\u3059\u3002\u3054\u6ce8\u6587\u3092\u627f\u308a\u307e\u3057\u305f\u3002",
  businessError: "\u696d\u52d9\u30a8\u30e9\u30fc\u306e\u305f\u3081\u9001\u4fe1\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u5185\u5bb9\u3092\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002",
  failed: "\u9001\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u901a\u4fe1\u304c\u623b\u308b\u307e\u3067\u9001\u4fe1\u5f85\u3061\u3067\u3059\u3002",
  pending: "\u9001\u4fe1\u5f85\u3061\u3067\u3059\u3002\u901a\u4fe1\u304c\u623b\u308b\u3068\u81ea\u52d5\u3067\u518d\u9001\u3057\u307e\u3059\u3002",
});

export function customerOrderNoticeFromOutboxEvent(event) {
  if (!event?.clientOrderId) return null;
  const displayState = event.displayState || event.state;
  if (displayState === "synced" || event.state === "synced") {
    return { kind: "success", message: NOTICE_MESSAGES.synced };
  }
  if (displayState === "business_error" || event.state === "rejected") {
    return { kind: "error", message: NOTICE_MESSAGES.businessError };
  }
  if (displayState === "retrying") {
    return { kind: "pending", message: NOTICE_MESSAGES.retrying };
  }
  if (displayState === "failed") {
    return { kind: "failed", message: NOTICE_MESSAGES.failed };
  }
  if (displayState === "sending") {
    return { kind: "sending", message: NOTICE_MESSAGES.sending };
  }
  if (displayState === "pending" || event.state === "pending") {
    return { kind: "pending", message: NOTICE_MESSAGES.pending };
  }
  return null;
}
