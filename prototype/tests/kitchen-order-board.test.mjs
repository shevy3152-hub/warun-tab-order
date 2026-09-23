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

test("more tables remain in the horizontally scrollable board without dropping sessions", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({ tableId: String(index + 1), sessionId: `s${index + 1}`, openedAt: "2026-09-23T09:00:00Z" }));
  const groups = buildKitchenTableGroups({ orders: [], sessions, menuItems, drinkCategoryIds });
  assert.equal(groups.length, 7);
  assert.deepEqual(groups.map((group) => group.session.sessionId), sessions.map((session) => session.sessionId));
});

test("kitchen markup and styles keep per-table stacks scrollable and compact the red-rail shell", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const screen = app.slice(app.indexOf("function KitchenScreen"), app.indexOf("function HistoryScreen"));
  assert.match(screen, /tables\.map\(\(table\)/);
  assert.match(screen, /className="table-panel__orders"/);
  assert.match(screen, /is-drink-order/);
  assert.match(screen, /ドリンク注文/);
  assert.match(screen, /isCompletedSide \? "提供完了"/);
  assert.match(screen, /toggleServed\(order\.id, item\.id\)/);
  assert.match(styles, /\.staff-app--kitchen \.table-panel__orders \{ overflow-y: auto; \}/);
  assert.match(styles, /\.staff-app--kitchen \.kitchen-sidebar__status \.staff-topbar__right/);
  assert.match(styles, /\.staff-app--kitchen \.table-scroll \{ overflow-x: auto; overflow-y: hidden;/);
});
