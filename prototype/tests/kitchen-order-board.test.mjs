import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildKitchenTableGroups } from "../src/kitchen-order-board.js";

const menuItems = [
  { id: "food", categoryId: "food-ready" },
  { id: "beer", categoryId: "beer" },
];
const drinkCategoryIds = new Set(["beer"]);
const order = (id, tableId, items, createdAt, sessionId = `s${tableId}`) => ({ id, tableId, items, createdAt, sessionId, status: "active", totalAmount: 1000 });
const row = (id, menuItemId, isServed = false) => ({ id, menuItemId, isServed, quantity: 1 });

test("kitchen board places drink add-on orders first and keeps unserved items ahead of served ones", () => {
  const groups = buildKitchenTableGroups({
    orders: [
      order("food-1", "2", [row("food-unserved", "food"), row("food-served", "food", true)], "2026-09-23T10:00:00Z"),
      order("drink-2", "2", [row("drink-unserved", "beer")], "2026-09-23T10:05:00Z"),
      order("food-older", "2", [row("food-older-row", "food")], "2026-09-23T09:55:00Z"),
      order("fully-served", "2", [row("fully-served-row", "food", true)], "2026-09-23T10:10:00Z"),
    ],
    sessions: [{ tableId: "2", sessionId: "s2", openedAt: "2026-09-23T09:50:00Z" }],
    menuItems,
    drinkCategoryIds,
  });

  assert.deepEqual(groups[0].orders.map((entry) => entry.id), ["drink-2", "food-1", "food-older", "fully-served"]);
  assert.equal(groups[0].orders[0].isDrinkOrder, true);
  assert.equal(groups[0].orders[1].hasUnservedItems, true);
  assert.equal(groups[0].orders[1].items[0].isServed, false);
  assert.equal(groups[0].orders[1].items[1].isServed, true);
  assert.equal(groups[0].orders[3].hasUnservedItems, false);
});

test("tables with active work come before completed sessions and later orders restore the same session", () => {
  const sessions = [
    { tableId: "1", sessionId: "session-1", openedAt: "2026-09-23T09:00:00Z" },
    { tableId: "2", sessionId: "session-2", openedAt: "2026-09-23T09:30:00Z" },
    { tableId: "3", sessionId: "session-3", openedAt: "2026-09-23T09:40:00Z" },
  ];
  const completedOrder = order("finished-1", "1", [row("served-1", "food", true)], "2026-09-23T09:05:00Z", "session-1");
  completedOrder.status = "completed";
  const activeNextTable = order("active-2", "2", [row("active-2-row", "food")], "2026-09-23T09:35:00Z", "session-2");
  const first = buildKitchenTableGroups({ orders: [completedOrder, activeNextTable], sessions, menuItems, drinkCategoryIds });
  assert.deepEqual(first.map((group) => group.tableId), ["2", "1", "3"]);
  assert.equal(first[0].hasUnservedOrders, true);
  assert.ok(first.slice(1).every((group) => group.isCompletedSide));
  assert.equal(first[1].session.sessionId, "session-1");

  const laterOrder = order("later-1", "1", [row("later-row", "food")], "2026-09-23T10:00:00Z", "session-1");
  const second = buildKitchenTableGroups({ orders: [completedOrder, activeNextTable, laterOrder], sessions, menuItems, drinkCategoryIds });
  const restored = second.find((group) => group.tableId === "1");
  assert.equal(restored.isCompletedSide, false);
  assert.equal(restored.session.sessionId, "session-1");
  assert.deepEqual(restored.orders.map((entry) => entry.id), ["later-1"]);
  assert.equal(completedOrder.status, "completed");
  assert.equal(completedOrder.items[0].isServed, true);
});

test("a fully served order stays available to a requested checkout and is restored under a later order", () => {
  const sessions = [{ tableId: "1", sessionId: "session-1", openedAt: "2026-09-23T09:00:00Z" }];
  const completed = order("finished-1", "1", [row("served-1", "food", true)], "2026-09-23T09:05:00Z", "session-1");
  completed.status = "completed";
  const checkout = { tableSessionId: "session-1", status: "requested" };
  const waiting = buildKitchenTableGroups({ orders: [completed], sessions, menuItems, drinkCategoryIds, checkouts: [checkout] });
  assert.equal(waiting[0].orders[0].id, "finished-1");
  assert.equal(waiting[0].orders[0].hasUnservedItems, false);
  assert.equal(waiting[0].isCompletedSide, true);
  assert.equal(waiting[0].session.sessionId, "session-1");

  const later = order("later-1", "1", [row("later-row", "beer")], "2026-09-23T10:00:00Z", "session-1");
  const restored = buildKitchenTableGroups({ orders: [completed, later], sessions, menuItems, drinkCategoryIds, checkouts: [checkout] })[0];
  assert.deepEqual(restored.orders.map((entry) => entry.id), ["later-1", "finished-1"]);
  assert.equal(restored.hasUnservedOrders, true);
  assert.equal(restored.session.sessionId, "session-1");
});

test("simultaneous requested checkouts get side-by-side table slots before other tables", () => {
  const sessions = [
    { tableId: "1", sessionId: "session-1", openedAt: "2026-09-23T09:00:00Z" },
    { tableId: "2", sessionId: "session-2", openedAt: "2026-09-23T09:10:00Z" },
    { tableId: "3", sessionId: "session-3", openedAt: "2026-09-23T09:20:00Z" },
  ];
  const checkouts = [
    { tableSessionId: "session-1", status: "requested" },
    { tableSessionId: "session-2", status: "requested" },
  ];
  const groups = buildKitchenTableGroups({
    orders: [order("active-3", "3", [row("item-3", "food")], "2026-09-23T09:25:00Z", "session-3")],
    sessions,
    menuItems,
    drinkCategoryIds,
    checkouts,
  });

  assert.deepEqual(groups.map((group) => group.tableId), ["1", "2", "3"]);
  assert.deepEqual(groups.slice(0, 2).map((group) => group.hasRequestedCheckout), [true, true]);
  assert.equal(groups[2].hasRequestedCheckout, false);
});

test("more tables remain in the horizontally scrollable board without dropping sessions", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({ tableId: String(index + 1), sessionId: `s${index + 1}`, openedAt: "2026-09-23T09:00:00Z" }));
  const groups = buildKitchenTableGroups({ orders: [], sessions, menuItems, drinkCategoryIds });
  assert.equal(groups.length, 7);
  assert.deepEqual(groups.map((group) => group.session.sessionId), sessions.map((session) => session.sessionId));
});

test("kitchen markup prioritizes live horizontal table slots and keeps histories on their own screen", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const screen = app.slice(app.indexOf("function KitchenScreen"), app.indexOf("function HistoryScreen"));
  const historyScreen = app.slice(app.indexOf("function HistoryScreen"), app.indexOf("const adminTabs"));
  const historyRoute = app.slice(app.indexOf('if (route === "/history")'), app.indexOf('if (route.startsWith("/admin/"))'));
  const liveLayout = styles.slice(styles.lastIndexOf("/* Kitchen: one independently scrollable receipt slot per table, side by side. */"));
  assert.match(screen, /tables\.map\(\(table\)/);
  assert.match(screen, /className="table-panel__orders"/);
  assert.match(screen, /className="table-panel__receipt"/);
  assert.match(screen, /is-drink-order/);
  assert.match(screen, /ドリンク注文/);
  assert.match(screen, /注文内容を\{expanded \? "非表示" : "表示"\}/);
  assert.doesNotMatch(screen, /className="kitchen-history/);
  assert.doesNotMatch(screen, /fetchKitchenPaymentHistory/);
  assert.match(screen, /const boardOrders = \[\.\.\.liveOrders, \.\.\.historyOrders\]/);
  assert.match(historyScreen, /className="history-table-wrap"/);
  assert.match(historyScreen, /className="payment-history"/);
  assert.match(historyRoute, /new URLSearchParams\(window\.location\.search\)\.get\("demo"\) === "1"/);
  assert.match(app, /route: "\/history", label: "注文・会計履歴"/);
  assert.doesNotMatch(screen, /席をリセット/);
  assert.doesNotMatch(screen, /onCloseSession/);
  assert.match(screen, /toggleServed\(order\.id \?\? order\.orderId, item\.id\)/);
  assert.match(styles, /\.staff-app--kitchen \.table-scroll \{ display: grid;/);
  assert.match(styles, /grid-auto-flow: column;[\s\S]*?grid-auto-columns: calc\(50vw - 160px\)/);
  assert.match(styles, /overflow-x: auto;[\s\S]*?scroll-snap-type: x proximity;/);
  assert.match(styles, /\.staff-app--kitchen \.table-panel__receipt \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.staff-app--kitchen \.kitchen-content \{ display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden;/);
  assert.match(liveLayout, /\.staff-app--kitchen \.table-scroll \{\s*flex: 1 1 auto;\s*min-height: 0;/);
  assert.match(liveLayout, /\.staff-app--kitchen \.table-panel \{\s*width: 100%;\s*height: 100%;/);
  assert.doesNotMatch(liveLayout, /\.staff-app--kitchen \.table-panel \{[^}]*height: clamp/);
  assert.match(liveLayout, /grid-template-areas: "ordered total" "adjustments adjustments"/);
  assert.match(liveLayout, /checkout-editor__actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  assert.match(liveLayout, /checkout-adjustments-disclosure > summary span \{ display: block;/);
  assert.match(app, /<details open className="checkout-adjustments-disclosure"/);
  assert.match(app, /<summary><h4>追加料金合計<\/h4>[\s\S]*?<span>入力・編集<\/span>/);
  assert.match(styles, /\.staff-app--kitchen \.staff-sidebar__status \.staff-topbar__right/);
  assert.match(styles, /\.staff-app--kitchen \.table-panel__orders \{ flex: none; min-height: 0; overflow: visible;/);
});
