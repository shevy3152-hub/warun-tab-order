import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const customerScreen = appSource.slice(appSource.indexOf("function CustomerScreen"), appSource.indexOf("const staffNavItems"));

test("CustomerScreen does not render menu prices or totals", () => {
  assert.doesNotMatch(customerScreen, /menu-row__price/);
  assert.doesNotMatch(customerScreen, /totalAmount.*yen\(|yen\(.*totalAmount/);
  assert.match(customerScreen, /price-hidden-note/);
});

test("API customer orders stay in memory instead of localStorage state", () => {
  const apiBranch = customerScreen.slice(customerScreen.indexOf('if (apiMode) {'), customerScreen.indexOf('      const order = {', customerScreen.indexOf('if (apiMode) {')));
  assert.match(apiBranch, /setApiOrders/);
  assert.doesNotMatch(apiBranch, /updateState/);
  assert.match(customerScreen, /const customerHistory = \(apiMode \? apiOrders : state\.orders\)/);
  assert.match(customerScreen, /\.filter\(\(order\) => apiMode \|\| order\.tableId === device\.tableId\)/);
  assert.match(customerScreen, /disabled=\{submitting\}/);
});

test("production customer history loads authenticated SQLite data and fails closed", () => {
  assert.match(customerScreen, /modal !== "history"/);
  assert.match(customerScreen, /orderClient\.getHistory\(\)/);
  assert.match(customerScreen, /orders\.map\(mapCustomerHistoryOrder\)/);
  assert.match(customerScreen, /apiMode && apiHistoryState\.error/);
  assert.match(customerScreen, /注文履歴を取得できません。/);
  assert.match(appSource, /order\.status === "completed" \? "提供済み"/);
});

test("API customer display uses the server-assigned table", () => {
  assert.match(customerScreen, /customerDeviceConfig/);
  assert.match(customerScreen, /customerDeviceConfig\?\.tableId/);
  assert.match(customerScreen, /const device = assignedTableId/);
});

test("kitchen new-order badge follows active orders, not staff calls", () => {
  const kitchenScreen = appSource.slice(appSource.indexOf("function KitchenScreen"), appSource.indexOf("function HistoryScreen"));
  const staffShell = appSource.slice(appSource.indexOf("function StaffShell"), appSource.indexOf("function KitchenScreen"));
  assert.match(kitchenScreen, /newOrderCount=\{activeOrders\.length\}/);
  assert.match(staffShell, /newOrderCount = 0/);
  assert.match(staffShell, /newOrderCount \? <b className="badge">\{newOrderCount\}<\/b>/);
  assert.doesNotMatch(staffShell, /activeCalls \? <b className="badge">/);
});

test("kitchen does not present local fallback as a persisted empty state", () => {
  const kitchenBootstrap = appSource.slice(appSource.indexOf('useEffect(() => {', appSource.indexOf('export function App')), appSource.indexOf('const serveKitchenItem'));
  assert.match(kitchenBootstrap, /!kitchenApiConfigured\(window\)/);
  assert.match(kitchenBootstrap, /WARUN_ORDER_MODE === "demo"/);
  assert.match(kitchenBootstrap, /error: true, orders: \[\]/);
});

test("kitchen API state changes reach the memoized screen", () => {
  assert.match(appSource, /customerDeviceConfig, kitchenApiState, pairingError/);
  assert.match(appSource, /注文情報を取得できません。/);
});

test("kitchen exposes the current session reset action without deleting order data", () => {
  const kitchenScreen = appSource.slice(appSource.indexOf("function KitchenScreen"), appSource.indexOf("function HistoryScreen"));
  assert.match(kitchenScreen, /openSessions|apiState\.sessions/);
  assert.match(kitchenScreen, /会計完了・席をリセット/);
  assert.match(kitchenScreen, /注文データは削除されませんが、客席端末には表示されなくなります。/);
  assert.match(kitchenScreen, /onCloseSession\(resetTarget\)/);
});

test("customer history refreshes when the authenticated SSE invalidation arrives", () => {
  assert.match(customerScreen, /orderClient\.subscribeInvalidations/);
  assert.match(customerScreen, /setHistoryRefreshKey/);
  assert.match(customerScreen, /historyRefreshKey/);
});

test("production history requires an authenticated API and never falls back to local state", () => {
  const historyScreen = appSource.slice(appSource.indexOf("function HistoryScreen"), appSource.indexOf("const adminTabs"));
  const historyRoute = appSource.slice(appSource.indexOf('if (route === "/history")'), appSource.indexOf('if (route.startsWith("/admin/"))'));
  assert.match(historyScreen, /apiMode \? remoteState\.orders/);
  assert.match(historyScreen, /typeof loadHistory !== "function"/);
  assert.match(historyRoute, /WARUN_ORDER_MODE === "demo"/);
  assert.match(historyRoute, /fetchKitchenOrderHistory/);
  assert.match(historyRoute, /apiMode=\{!explicitDemo\}/);
  assert.match(historyScreen, /completedToday\.length/);
});
