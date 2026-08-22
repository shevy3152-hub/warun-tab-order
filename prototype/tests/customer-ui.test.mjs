import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const customerScreen = appSource.slice(appSource.indexOf("function CustomerScreen"), appSource.indexOf("const staffNavItems"));

test("CustomerScreen renders menu prices but no cart or customer-history totals", () => {
  assert.match(customerScreen, /PriceDisplay/);
  assert.match(appSource, /taxExcludedYen/);
  assert.doesNotMatch(customerScreen, /totalAmount.*yen\(|yen\(.*totalAmount/);
  assert.match(customerScreen, /price-hidden-note/);
  const cartPanel = customerScreen.slice(customerScreen.indexOf('<aside className="cart-panel">'), customerScreen.indexOf('</aside>', customerScreen.indexOf('<aside className="cart-panel">')));
  assert.doesNotMatch(cartPanel, /menu-price|totalAmount|合計/);
});

test("customer menu uses major category navigation with a collapsible rail", () => {
  assert.match(appSource, /CUSTOMER_MAJOR_CATEGORIES/);
  assert.match(appSource, /ドリンク/);
  assert.match(appSource, /フード/);
  assert.match(appSource, /名物/);
  assert.match(appSource, /季節・気まぐれ/);
  assert.match(customerScreen, /majorNavOpen/);
  assert.match(customerScreen, /customer-app--category-collapsed/);
  assert.match(customerScreen, /大分類カテゴリー/);
  assert.match(customerScreen, /カテゴリーを変更/);
  assert.match(customerScreen, /setMajorNavOpen\(true\)/);
  assert.match(customerScreen, /setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /subcategory-nav/);
  assert.match(customerScreen, /menu-heading__breadcrumb/);
  assert.match(customerScreen, /currentMajorCategory\.name/);
  assert.match(customerScreen, /currentCategoryLabel/);
  assert.match(customerScreen, /subcategory-nav--drink/);
  assert.match(customerScreen, /product-image-placeholder/);
  assert.match(appSource, /おすすめ/);
  assert.match(appSource, /ノンアル/);
});

test("major category selection collapses to a 78px rail and the rail reopens it", () => {
  assert.match(customerScreen, /const \[majorNavOpen, setMajorNavOpen\] = useState\(true\)/);
  assert.match(customerScreen, /onClick=\{\(\) => selectMajorCategory\(category\.id\)\}/);
  assert.match(customerScreen, /setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /const selectSubcategory = \(nextCategoryId\) => \{[\s\S]*setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /customer-sidebar__collapsed-toggle.*setMajorNavOpen\(true\)/s);
  assert.match(styles, /\.customer-app\.customer-app--category-collapsed \{ grid-template-columns: 78px/);
  assert.match(styles, /\.customer-sidebar__collapsed-toggle \{/);
});

test("all customer product lists use a shared compact header", () => {
  const menuHeaderCss = styles.slice(styles.indexOf(".menu-heading {"), styles.indexOf(".menu-list {"));
  assert.match(menuHeaderCss, /\.menu-heading \{[\s\S]*min-height: 86px/);
  assert.match(menuHeaderCss, /\.menu-heading__body > div \{[\s\S]*display: flex/);
  assert.match(menuHeaderCss, /\.subcategory-nav \{[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(menuHeaderCss, /padding: 6px 0 8px/);
  assert.match(styles, /\.empty-state \{/);
  assert.match(customerScreen, /menu-heading/);
  assert.match(customerScreen, /currentItems\.length/);
  assert.match(customerScreen, /このカテゴリの商品はまだありません/);
});

test("shochu uses jump navigation and one inline serving-option panel", () => {
  assert.match(customerScreen, /drink-jump-nav/);
  assert.match(customerScreen, /scrollIntoView/);
  assert.match(customerScreen, /menu-section-divider/);
  assert.match(customerScreen, /expandedShochuId/);
  assert.match(customerScreen, /servingOptions\.map/);
  assert.match(customerScreen, /setExpandedShochuId\(null\)/);
});

test("sake rows use one serving-method button and a confirmation popup", () => {
  assert.match(customerScreen, /sake-serve-button/);
  assert.match(customerScreen, /提供方法を選ぶ/);
  assert.match(customerScreen, /sakeSelection/);
  assert.match(customerScreen, /提供方法・温度を選ぶ/);
  assert.match(customerScreen, /この内容で追加/);
  assert.match(customerScreen, /sakeTemperatureOptions/);
  assert.match(customerScreen, /temperature/);
  assert.doesNotMatch(customerScreen, /sake-variant-actions/);
  assert.doesNotMatch(customerScreen, /sake-variant-button/);
  assert.match(customerScreen, /className="add-button"/);
});

test("sake serving popup keeps shared price formatting and A90 tap sizing", () => {
  assert.match(styles, /\.sake-serve-button \{[\s\S]*min-height: 58px/);
  assert.match(styles, /\.sake-serving-options \{[\s\S]*grid-template-columns: repeat\(3/);
  assert.match(styles, /\.sake-temperature-picker button \{[\s\S]*min-height: 52px/);
  assert.match(styles, /\.sake-serving-option \.menu-price \{[\s\S]*align-items: flex-start/);
  assert.match(styles, /\.sake-menu-row \.product-image-button \{[\s\S]*width: 64px/);
  assert.match(styles, /\.sake-serving-option \{[\s\S]*min-height: 132px/);
});

test("sake product details and order snapshots retain the shared selection model", () => {
  assert.match(customerScreen, /setDetailItem\(item\)/);
  assert.match(customerScreen, /<Modal title=\{detailItem\.name\}/);
  assert.match(customerScreen, /variantNameSnapshot|servingOptionNameSnapshot/);
  assert.match(customerScreen, /variantVolumeSnapshot/);
  assert.match(customerScreen, /temperatureSnapshot/);
  assert.match(customerScreen, /unitPriceSnapshot: row\.variant\?\.priceYen/);
});

test("admin detail editing covers every displayed tasting field", () => {
  assert.match(appSource, /name="aroma"/);
  assert.match(appSource, /name="sweetness"/);
  assert.match(appSource, /name="finish"/);
  assert.match(appSource, /form\.get\("aroma"\)/);
  assert.match(appSource, /form\.get\("sweetness"\)/);
  assert.match(appSource, /form\.get\("finish"\)/);
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
