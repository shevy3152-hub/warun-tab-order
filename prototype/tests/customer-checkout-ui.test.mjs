import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const modal = source.slice(source.indexOf("function CustomerCheckoutModal"), source.indexOf("function CustomerScreen"));

test("customer checkout button and states are connected to the authenticated client", () => {
  assert.match(source, /<IconButton icon=\{CurrencyJpy\} onClick=\{openCheckout\}>お会計/);
  assert.match(source, /orderClient\.requestCheckout/);
  assert.match(source, /orderClient\.getCheckout/);
  assert.match(source, /checkout.*resource|resource.*checkout/);
  assert.match(modal, /お会計を依頼する/);
  assert.match(modal, /手書き領収書を希望する/);
  assert.match(modal, /しばらくお待ちください/);
  assert.match(modal, /お会計金額/);
  assert.match(modal, /割り勘/);
  assert.match(modal, /Math\.ceil\(checkout\.grandTotalYen \/ splitCount\)/);
  assert.match(source, /previous\?\.status === "requested" && nextCheckout\?\.status === "ready"/);
  assert.match(source, /sessionStorage.*warun-checkout-ready/);
  assert.match(source, /AudioContext/);
});

test("customer pending view does not expose order or adjustment amounts", () => {
  const pending = modal.slice(modal.indexOf("waiting ?"), modal.indexOf(": cancelled ?"));
  assert.match(pending, /しばらくお待ちください/);
  assert.doesNotMatch(pending, /grandTotalYen|orderedItemsTotalYen|adjustmentsTotalYen|追加料金|注文商品合計/);
  assert.match(styles, /\.checkout-customer-total \{[\s\S]*font:/);
  assert.match(styles, /\.checkout-split__control \{[\s\S]*grid-template-columns/);
});

test("cancelled checkout hides the old total and uses the existing customer re-request action", () => {
  const cancelled = modal.split(": cancelled ?")[1]?.split(": <div className=\"checkout-customer-request\"")[0] ?? "";
  assert.match(cancelled, /会計依頼が取り消されました/);
  assert.match(cancelled, /onResetCancelled/);
  assert.match(cancelled, /新しく会計を依頼する/);
  assert.doesNotMatch(cancelled, /grandTotalYen|orderedItemsTotalYen|adjustmentsTotalYen/);
  assert.match(source, /const resetCancelledCheckout = \(\) => \{[\s\S]*checkoutRequestIdRef\.current = null/);
});

test("checkout GET retry renders safe diagnostics and never sends a checkout request", () => {
  assert.ok(modal.includes("失敗段階: {checkoutState.errorDetails?.stage"));
  assert.ok(modal.includes("HTTP status: {checkoutState.errorDetails?.status"));
  assert.ok(modal.includes("error code: {checkoutState.errorDetails?.code"));
  assert.ok(source.includes("const stage = [\"configuration\", \"network\", \"http\", \"response\"]"));
  const retry = source.slice(source.indexOf("const retryCheckout"), source.indexOf("const resetCancelledCheckout"));
  assert.match(retry, /setCheckoutRefreshKey/);
  assert.doesNotMatch(retry, /requestCheckout|POST/);
});

test("checkout modal state is scoped to the current visit and ignores late prior-visit responses", () => {
  assert.match(source, /checkoutVisitContextRef\.current = checkoutVisitContextId/);
  assert.match(source, /setCheckoutState\(\{ loading: false, error: false, errorDetails: null, checkout: nextCheckout, visitContextId: checkoutVisitContextId \}\)/);
  assert.match(source, /\[apiMode, modal, orderClient, checkoutRefreshKey, checkoutVisitContextId\]/);
  assert.match(source, /checkoutVisitContextRef\.current !== requestVisitContextId\) return/);
  assert.match(source, /modal === "checkout" && \(!apiMode \|\| checkoutState\.visitContextId === checkoutVisitContextId\)/);
  assert.match(source, /setModal\(\(current\) => current === "checkout" \? null : current\)/);
  assert.match(source, /if \(resource === "deviceConfig"\) \{[\s\S]*checkoutReadGenerationRef\.current \+= 1;[\s\S]*setCheckoutState\(\{ loading: false, error: false, errorDetails: null, checkout: null, visitContextId: checkoutVisitContextId \}\)[\s\S]*setModal\(\(current\) => current === "checkout" \? null : current\)/);
  assert.match(source, /requestGeneration !== checkoutReadGenerationRef\.current/);
});
