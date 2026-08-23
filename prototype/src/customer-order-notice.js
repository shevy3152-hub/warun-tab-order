const NOTICE_MESSAGES = Object.freeze({
  sending: "送信中です。注文を保存しています。",
  retrying: "再送中です。",
  synced: "送信済みです。ご注文を承りました。",
  auth: "認証切れのため送信できませんでした。再接続を確認してください。",
  order: "注文内容エラーのため送信できませんでした。内容を確認してください。",
  conflict: "送信競合のため注文を保存できませんでした。注文履歴を確認してください。",
  server: "サーバーエラーのため送信できませんでした。時間をおいてください。",
  unknown: "注文を受け付けられませんでした。内容を確認してください。",
  failed: "送信に失敗しました。通信が戻るまで送信待ちです。",
  pending: "送信待ちです。通信が戻ると自動で再送します。",
});

const AUTH_ERROR_CODES = new Set(["AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED", "HTTP_401", "HTTP_403"]);
const ORDER_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "INVALID_ORDER_REQUEST",
  "MENU_ITEM_NOT_FOUND",
  "MENU_ITEM_SOLD_OUT",
  "HTTP_400",
  "HTTP_422",
]);
const CONFLICT_ERROR_CODES = new Set([
  "ORDER_CONFLICT",
  "SESSION_CONFLICT",
  "SESSION_HAS_ACTIVE_ORDERS",
  "HTTP_409",
]);
const SERVER_ERROR_CODES = new Set(["INTERNAL_ERROR", "SERVICE_UNAVAILABLE"]);

function normalizedErrorCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function customerOrderErrorCategory(errorCode) {
  const code = normalizedErrorCode(errorCode);
  if (AUTH_ERROR_CODES.has(code)) return { key: "auth", label: "認証切れ", message: NOTICE_MESSAGES.auth };
  if (CONFLICT_ERROR_CODES.has(code)) return { key: "conflict", label: "送信競合", message: NOTICE_MESSAGES.conflict };
  if (SERVER_ERROR_CODES.has(code) || /^HTTP_5\d\d$/.test(code)) {
    return { key: "server", label: "サーバーエラー", message: NOTICE_MESSAGES.server };
  }
  if (ORDER_ERROR_CODES.has(code)) return { key: "order", label: "注文内容エラー", message: NOTICE_MESSAGES.order };
  return { key: "unknown", label: "注文受付エラー", message: NOTICE_MESSAGES.unknown };
}

export function customerOrderNoticeFromOutboxEvent(event) {
  if (!event?.clientOrderId) return null;
  const displayState = event.displayState || event.state;
  if (displayState === "synced" || event.state === "synced") {
    return { kind: "success", message: NOTICE_MESSAGES.synced };
  }
  if (displayState === "business_error" || event.state === "rejected") {
    return { kind: "error", message: customerOrderErrorCategory(event.lastErrorCode).message };
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
