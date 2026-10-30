import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { beginCheckoutRead, isCheckoutModalForCurrentVisit, isPassiveMissingCheckoutSession } from "../src/customer-checkout-state.js";

const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const orderOutbox = await readFile(new URL("../src/order-outbox.js", import.meta.url), "utf8");
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

test("ready checkout uses only the modal close control and reopens through a fresh GET", () => {
  assert.match(modal, /<Modal title="お会計" onClose=\{onClose\} className="modal--checkout">/);
  assert.doesNotMatch(modal, /checkout-modal__footer|button[^>]*>閉じる</);

  const openCheckout = source.slice(source.indexOf("const openCheckout = () =>"), source.indexOf("const requestCheckout = async () =>"));
  assert.match(openCheckout, /setModal\("checkout"\)/);
  assert.match(openCheckout, /setCheckoutRefreshKey\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(openCheckout, /requestCheckout|POST/);
  assert.match(source, /orderClient\.getCheckout\(\)/);
  assert.match(source, /if \(checkoutSubmitting \|\| checkoutState\.checkout\?\.status === "requested" \|\| checkoutState\.checkout\?\.status === "ready"\) return/);
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

test("only a current ready checkout response can provide an amount to the customer modal", () => {
  assert.match(modal, /const ready = checkout\?\.status === "ready" && Number\.isSafeInteger\(checkout\.grandTotalYen\)/);
  assert.match(source, /setCheckoutState\(\(current\) => beginCheckoutRead\(current, checkoutVisitContextId\)\)/);
  assert.match(source, /setCheckoutState\(\{ loading: false, error: false, errorDetails: null, checkout: nextCheckout, visitContextId: checkoutVisitContextId, loaded: true \}\)/);
  assert.match(orderOutbox, /checkout\.status === "ready" && Number\.isSafeInteger\(checkout\.grandTotalYen\) \? \{ grandTotalYen: checkout\.grandTotalYen \} : \{\}/);
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
  assert.match(source, /setCheckoutState\(\{ loading: false, error: false, errorDetails: null, checkout: nextCheckout, visitContextId: checkoutVisitContextId, loaded: true \}\)/);
  assert.match(source, /\[apiMode, modal, orderClient, checkoutRefreshKey, checkoutVisitContextId, historyScope\]/);
  assert.match(source, /checkoutVisitContextRef\.current !== requestVisitContextId \|\| checkoutRequestIdRef\.current !== checkoutRequestId \|\| checkoutPostAttemptRef\.current !== attempt\) return/);
  assert.match(source, /isCheckoutModalForCurrentVisit\(\{ modal, openedForVisitContextId: checkoutModalVisitContextRef\.current, currentVisitContextId: checkoutVisitContextId \}\)/);
  assert.match(source, /\(!apiMode \|\| checkoutState\.visitContextId === checkoutVisitContextId\)/);
  assert.match(source, /setModal\(\(current\) => current === "checkout" \? null : current\)/);
  const invalidation = source.slice(source.indexOf('if (resource === "deviceConfig")'), source.indexOf('if (resource === "orders")'));
  assert.match(invalidation, /checkoutReadGenerationRef\.current \+= 1;[\s\S]*refreshVisitState\(\)\.then/);
  assert.doesNotMatch(invalidation, /setModal\(\(current\) => current === "checkout" \? null/);
  assert.match(source, /requestGeneration !== checkoutReadGenerationRef\.current/);
});

test("checkout refresh preserves receipt choice and modal for the same visit", () => {
  assert.match(source, /if \(nextCheckout\)(?:\s*\{)?\s*setCheckoutReceiptRequested\(nextCheckout\.receiptRequested === true\)/);
  const visitEffect = source.slice(source.indexOf("const checkoutVisitContextRef = useRef"), source.indexOf("const customerMajorCategories"));
  assert.match(visitEffect, /if \(previousVisitContextId\) setModal\(\(current\) => current === "checkout" \? null : current\)/);
  assert.match(visitEffect, /else if \(checkoutVisitContextId && modal === "checkout"\) setCheckoutRefreshKey/);
  const invalidation = source.slice(source.indexOf('if (resource === "deviceConfig")'), source.indexOf('if (resource === "orders")'));
  assert.match(invalidation, /refreshedConfig\.visitContextId !== visitContextBeforeRefresh\) return/);
  assert.doesNotMatch(invalidation, /setCheckoutReceiptRequested\(false\)|setModal\(\(current\) => current === "checkout" \? null/);
});

test("checkout request modal includes the specified exit notice without another confirmation", () => {
  assert.match(modal, /checkout-customer-exit-notice[^>]*>会計後は10分ほどで退店して頂きます。/);
  assert.match(modal, /手書き領収書を希望する/);
  assert.doesNotMatch(modal, /checkbox|確認してから依頼/);
});

test("same-visit checkout refetch keeps the rendered state stable while the GET is pending", () => {
  const requestForm = { loading: false, error: false, errorDetails: null, checkout: null, visitContextId: "visit-a", loaded: true };
  const waiting = { ...requestForm, checkout: { status: "requested" } };
  const ready = { ...requestForm, checkout: { status: "ready", grandTotalYen: 1234 } };
  assert.equal(beginCheckoutRead(requestForm, "visit-a"), requestForm);
  assert.equal(beginCheckoutRead(waiting, "visit-a"), waiting);
  assert.equal(beginCheckoutRead(ready, "visit-a"), ready);
  const firstRead = beginCheckoutRead({ ...requestForm, loaded: false }, "visit-a");
  assert.equal(firstRead.loading, true);
  const newVisitRead = beginCheckoutRead(waiting, "visit-b");
  assert.equal(newVisitRead.loading, true);
  assert.equal(newVisitRead.visitContextId, "visit-b");
});

test("passive missing-session GET clears stale checkout UI but explicit checkout keeps its error", () => {
  const missingSession = { status: 404, code: "CHECKOUT_SESSION_NOT_FOUND" };
  assert.equal(isPassiveMissingCheckoutSession(missingSession), true);
  assert.equal(isPassiveMissingCheckoutSession(missingSession, { explicitlyOpened: true }), false);
  assert.equal(isPassiveMissingCheckoutSession({ status: 404, code: "MENU_NOT_FOUND" }), false);
  assert.equal(isPassiveMissingCheckoutSession({ status: 500, code: "CHECKOUT_SESSION_NOT_FOUND" }), false);
  assert.equal(isCheckoutModalForCurrentVisit({ modal: "checkout", openedForVisitContextId: "visit-old", currentVisitContextId: "visit-new" }), false);
  assert.equal(isCheckoutModalForCurrentVisit({ modal: "checkout", openedForVisitContextId: "visit-new", currentVisitContextId: "visit-new" }), true);

  const reproducedOldState = { modal: "checkout", checkoutStateVisitContextId: "visit-new", openedForVisitContextId: "visit-old", currentVisitContextId: "visit-new" };
  assert.equal(reproducedOldState.checkoutStateVisitContextId === reproducedOldState.currentVisitContextId, true, "the prior render guard admitted a stale modal after its background 404 was stamped with the new context");
  assert.equal(isCheckoutModalForCurrentVisit({ modal: reproducedOldState.modal, openedForVisitContextId: reproducedOldState.openedForVisitContextId, currentVisitContextId: reproducedOldState.currentVisitContextId }), false);

  assert.match(source, /checkoutModalVisitContextRef = useRef\(checkoutVisitContextId\)/);
  assert.match(source, /checkoutExplicitReadRef\.current = true/);
  assert.match(source, /if \(isPassiveMissingCheckoutSession\(error, \{ explicitlyOpened \}\)\)[\s\S]*setModal\(\(current\) => current === "checkout" \? null : current\)/);
  assert.match(source, /isCheckoutModalForCurrentVisit\(\{ modal, openedForVisitContextId: checkoutModalVisitContextRef\.current, currentVisitContextId: checkoutVisitContextId \}\)/);
});
