import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("kitchen checkout panel exposes the staff workflow without internal values", () => {
  assert.match(appSource, /KitchenCheckoutPanel/);
  assert.match(appSource, /const active = checkouts\.filter/);
  assert.match(appSource, /手書き領収書希望/);
  assert.match(appSource, /注文済み商品合計/);
  assert.match(appSource, /追加料金を保存/);
  assert.match(appSource, /合計金額を確定/);
  assert.match(appSource, /会計依頼を取り消す/);
  assert.match(appSource, /confirmAction === "ready"/);
});

test("checkout panel keeps the order area independently usable and compact", () => {
  assert.match(styles, /\.checkout-panel \{[\s\S]*max-height: 300px/);
  assert.match(styles, /\.checkout-list__cards \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.table-scroll \{[\s\S]*overflow-x: auto/);
  assert.match(styles, /\.checkout-adjustment-row \.checkout-amount-input \{[\s\S]*text-align: right/);
});

test("kitchen history starts with today's completed orders and can reveal past orders", () => {
  assert.match(appSource, /function isSameLocalDate\(value, reference = new Date\(\)\)/);
  assert.match(appSource, /showPastOrders, setShowPastOrders\] = useState\(false\)/);
  assert.match(appSource, /const historyOrders = sourceOrders\.filter\(\(order\) => order\.status === "completed" \|\| order\.status === "cancelled"\)/);
  assert.match(appSource, /const completedToday = completed\.filter\(\(order\) => isSameLocalDate\(order\.completedAt \?\? order\.createdAt\)\)/);
  assert.match(appSource, /const visibleOrders = showPastOrders \? historyOrders : visibleToday/);
  assert.match(appSource, /本日の注文商品合計/);
  assert.match(appSource, /過去の注文も表示/);
  assert.match(appSource, /本日の注文だけ表示/);
  assert.match(appSource, /本日完了・キャンセルになった注文はありません/);
  assert.match(appSource, /sessionGroups/);
  assert.match(appSource, /history-session-divider/);
  assert.match(appSource, /会計済み/);
  assert.match(appSource, /終了・会計記録なし/);
  assert.match(appSource, /会計前/);
  assert.match(appSource, /record\.status === "paid"/);
  assert.match(styles, /\.history-past-notice/);
  assert.match(styles, /\.history-session-divider/);
});

test("history item operations fail closed until checkout state is known and lock ready, paid, and closed sessions", () => {
  assert.match(appSource, /loadCheckoutRequests=\{loadCheckoutRequests\}/);
  assert.match(appSource, /const readySessionIds = new Set\(checkoutRemoteState\.checkouts\.filter\(\(checkout\) => checkout\.status === "ready"\)/);
  assert.match(appSource, /const paidSessionIds = new Set\(paymentRemoteState\.payments\.filter\(\(payment\) => payment\.status === "paid"\)/);
  assert.match(appSource, /order\.sessionClosedAtMs != null\s*\|\|\s*readySessionIds\.has\(order\.sessionId\)\s*\|\|\s*paidSessionIds\.has\(order\.sessionId\)/);
  assert.match(appSource, /disabled=\{historyOperationLocked\(order\)\}/);
  assert.match(appSource, /!checkoutState \|\| checkoutState\.loading \|\| checkoutState\.error/);
});

test("cancellation confirmation keeps accepted copy and shows the current billable quantity and amount", () => {
  assert.match(appSource, /\$\{cancellationProductName\} \$\{cancellationQuantity\}点をキャンセルし、今回の会計から外します。注文の記録は残ります。提供済みの場合、提供した記録も残ります。/);
  assert.match(appSource, /今回の会計から外す金額：\{yen\(cancellationUnitPrice\)\} × \{cancellationQuantity\}点/);
  assert.match(appSource, /function cancelledQuantityForDisplay\(item\)/);
  assert.match(appSource, /会計から除外 \{cancelledQuantity\}点／\{yen\(excludedAmount\)\}/);
  assert.match(appSource, /数量0点化によるキャンセル/);
});
