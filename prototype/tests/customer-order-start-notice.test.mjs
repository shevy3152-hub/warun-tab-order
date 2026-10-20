import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acknowledgeCustomerOrderStartNotice,
  clearCustomerOrderStartNoticeAcknowledgements,
  createCustomerOrderStartNoticeScopeKey,
  DEFAULT_CUSTOMER_ORDER_START_NOTICE,
  hasCustomerOrderStartNoticeAcknowledgement,
  beginCustomerOrderStartNoticeRefresh,
  hasValidCustomerOrderStartNoticeSettings,
} from "../src/customer-order-start-notice.js";

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

test("background notice refresh preserves loaded content and enabled presentation", () => {
  const settings = { heading: "Notice heading", body: "Notice body" };
  const cachedState = { loading: false, error: false, settings };
  const beforeFixRefreshState = { ...cachedState, loading: true, error: false };
  const presentation = (state) => ({
    headingVisible: Boolean(state.settings?.heading),
    bodyVisible: hasValidCustomerOrderStartNoticeSettings(state.settings),
    loadingVisible: state.loading,
    continueDisabled: state.loading || state.error || !hasValidCustomerOrderStartNoticeSettings(state.settings),
  });

  assert.deepEqual(presentation(beforeFixRefreshState), {
    headingVisible: true,
    bodyVisible: true,
    loadingVisible: true,
    continueDisabled: true,
  });
  const refreshedState = beginCustomerOrderStartNoticeRefresh(cachedState);
  assert.strictEqual(refreshedState, cachedState);
  assert.deepEqual(presentation(refreshedState), {
    headingVisible: true,
    bodyVisible: true,
    loadingVisible: false,
    continueDisabled: false,
  });
});

test("initial, invalid, and failed notice states remain blocked", () => {
  const initial = beginCustomerOrderStartNoticeRefresh({ loading: true, error: false, settings: null });
  assert.deepEqual(initial, { loading: true, error: false, settings: null });
  const invalid = beginCustomerOrderStartNoticeRefresh({ loading: false, error: false, settings: { heading: " ", body: "Terms" } });
  assert.equal(invalid.loading, true);
  assert.equal(invalid.error, false);
  assert.equal(hasValidCustomerOrderStartNoticeSettings({ heading: "Heading", body: " " }), false);
  const failed = { loading: false, error: true, settings: null };
  assert.equal(failed.loading || failed.error || !hasValidCustomerOrderStartNoticeSettings(failed.settings), true);
});

test("notice acknowledgement is scoped to the device, table, and visit context", () => {
  const scope = { deviceId: "device-a", tableId: 1, visitContextId: "visit-a" };
  const key = createCustomerOrderStartNoticeScopeKey(scope);
  assert.ok(key);
  assert.equal(createCustomerOrderStartNoticeScopeKey(scope), key);
  assert.notEqual(createCustomerOrderStartNoticeScopeKey({ ...scope, visitContextId: "visit-b" }), key);
  assert.notEqual(createCustomerOrderStartNoticeScopeKey({ ...scope, tableId: 2 }), key);
  assert.notEqual(createCustomerOrderStartNoticeScopeKey({ ...scope, deviceId: "device-b" }), key);
  assert.equal(createCustomerOrderStartNoticeScopeKey({ ...scope, visitContextId: "" }), null);
});

test("acknowledgement persists for its scope and reassignment cleanup is device-only", () => {
  const storage = new MemoryStorage();
  const first = createCustomerOrderStartNoticeScopeKey({ deviceId: "device-a", tableId: 1, visitContextId: "visit-a" });
  const second = createCustomerOrderStartNoticeScopeKey({ deviceId: "device-a", tableId: 2, visitContextId: "visit-b" });
  const otherDevice = createCustomerOrderStartNoticeScopeKey({ deviceId: "device-b", tableId: 2, visitContextId: "visit-b" });
  assert.equal(hasCustomerOrderStartNoticeAcknowledgement({ scopeKey: first, storage }), false);
  assert.equal(acknowledgeCustomerOrderStartNotice({ scopeKey: first, storage }), true);
  assert.equal(acknowledgeCustomerOrderStartNotice({ scopeKey: second, storage }), true);
  assert.equal(acknowledgeCustomerOrderStartNotice({ scopeKey: otherDevice, storage }), true);
  assert.equal(hasCustomerOrderStartNoticeAcknowledgement({ scopeKey: first, storage }), true);
  assert.equal(clearCustomerOrderStartNoticeAcknowledgements({ deviceId: "device-a", storage }), 2);
  assert.equal(hasCustomerOrderStartNoticeAcknowledgement({ scopeKey: first, storage }), false);
  assert.equal(hasCustomerOrderStartNoticeAcknowledgement({ scopeKey: otherDevice, storage }), true);
});

test("customer notice gates only the customer screen and does not touch orders or outbox", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const customer = app.slice(app.indexOf("function CustomerScreen"), app.indexOf("const staffNavItems"));
  const notice = app.slice(app.indexOf("function CustomerOrderStartNotice"), app.indexOf("function CustomerScreen"));
  for (const rule of ["20歳未満の入店禁止", "飲酒運転しません・させません", "SNS投稿・LIVE配信禁止", "お支払いは現金のみ"]) {
    assert.ok(DEFAULT_CUSTOMER_ORDER_START_NOTICE.body.includes(rule));
  }
  assert.doesNotMatch(notice, /すべて確認しました|type="checkbox"/);
  assert.match(notice, /確認して注文を開始する/);
  assert.match(notice, /disabled=\{!ready\}/);
  assert.match(customer, /if \(!orderStartNoticeAcknowledged\) return <CustomerOrderStartNotice/);
  assert.match(customer, /visitContextId: customerDeviceConfig\?\.visitContextId/);
  assert.match(customer, /acknowledgeCustomerOrderStartNotice\(\{ scopeKey: orderStartNoticeScopeKey \}\)/);
  assert.doesNotMatch(customer, /checkedOrderStartNoticeScope/);
  assert.match(customer, /onCustomerDeviceConfigChange\?\.\(\{ \.\.\.currentConfig, deviceId: customerDeviceConfig\?\.deviceId \}\)/);
  assert.match(app, /clearCustomerOrderStartNoticeAcknowledgements\(\{ deviceId: device\.deviceId \}\)/);
  assert.doesNotMatch(notice, /orderClient|enqueue|session|outbox/i);
  assert.match(app, /orderClient\.start\(\)/);
  assert.match(customer, /subscribeInvalidations|enqueue/);
  assert.match(customer, /orderStartNoticeState\.settings/);
  assert.match(customer, /setOrderStartNoticeState\(beginCustomerOrderStartNoticeRefresh\)/);
  assert.match(customer, /hasValidCustomerOrderStartNoticeSettings\(orderStartNoticeState\.settings\)/);
  assert.match(customer, /loading: false, error: true, settings: null/);
  assert.match(styles, /customer-order-start-notice__body[\s\S]*?white-space:\s*pre-wrap/);
  assert.match(notice, /customer-order-start-notice__body-scroll[\s\S]*customer-order-start-notice__continue/);
  assert.match(styles, /\.customer-order-start-notice \{ height: 100dvh;[\s\S]*overflow: hidden/);
  assert.match(styles, /\.customer-order-start-notice__card \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /\.customer-order-start-notice__body-scroll \{ min-height: 0; overflow-y: auto/);
  assert.match(styles, /\.customer-order-start-notice__continue \{[\s\S]*min-height: 72px; margin: 0/);
  assert.match(app, /function CustomerOrderStartNoticeEditor/);
  assert.match(app, /客席プレビュー/);
  assert.doesNotMatch(app, /□ すべて確認しました/);
  assert.match(app, /<button type="button" disabled>確認して注文を開始する<\/button>/);
});
