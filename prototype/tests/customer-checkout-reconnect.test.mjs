import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCustomerCheckoutReconnectHandler, isMatchingCustomerCheckoutReconnectVisit } from "../src/customer-checkout-reconnect.js";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const VISIT_A = "v1_" + "a".repeat(64);
const VISIT_B = "v1_" + "b".repeat(64);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

test("missed ready event on epoch reset is recovered by one current-visit GET without a checkout POST", async () => {
  let renderedCheckout = { status: "requested", grandTotalYen: null };
  const readyOnServer = { status: "ready", grandTotalYen: 4750 };
  let eventReplayed = false;
  let getCount = 0;
  let postCount = 0;
  let currentVisitContextId = VISIT_A;
  let queuedRefreshVisitContextId = null;
  const client = {
    async getCheckout() { getCount += 1; return readyOnServer; },
    async requestCheckout() { postCount += 1; throw new Error("POST must not be used by this test."); },
  };
  assert.equal(renderedCheckout.status, "requested");
  assert.equal(eventReplayed, false);

  const reconnect = createCustomerCheckoutReconnectHandler({
    async refreshVisitState() { return { role: "customer", tableId: 1, visitContextId: VISIT_A }; },
    onRefreshReady(visitContextId) { queuedRefreshVisitContextId = visitContextId; },
  });
  await reconnect("epoch-reset");
  if (isMatchingCustomerCheckoutReconnectVisit({ refreshedVisitContextId: queuedRefreshVisitContextId, currentVisitContextId })) {
    renderedCheckout = await client.getCheckout();
  }

  assert.equal(renderedCheckout.status, "ready");
  assert.equal(renderedCheckout.grandTotalYen, 4750);
  assert.equal(getCount, 1);
  assert.equal(postCount, 0);
  assert.match(appSource, /onReconnect: refreshCheckoutAfterReconnect/);
  assert.match(appSource, /setCheckoutRefreshKey\(\(current\) => current \+ 1\)/);
});

test("overlapping reconnect refreshes use the latest config and wait until the current visit matches", async () => {
  const firstConfig = deferred();
  const secondConfig = deferred();
  const callbacks = [];
  let calls = 0;
  let currentVisitContextId = VISIT_A;
  let getCount = 0;
  const reconnect = createCustomerCheckoutReconnectHandler({
    refreshVisitState() { calls += 1; return calls === 1 ? firstConfig.promise : secondConfig.promise; },
    onRefreshReady(visitContextId) { callbacks.push(visitContextId); },
  });

  const olderReconnect = reconnect("reconnected");
  const newerReconnect = reconnect("epoch-reset");
  secondConfig.resolve({ role: "customer", tableId: 1, visitContextId: VISIT_B });
  assert.equal(await newerReconnect, true);
  firstConfig.resolve({ role: "customer", tableId: 1, visitContextId: VISIT_A });
  assert.equal(await olderReconnect, false);
  assert.deepEqual(callbacks, [VISIT_B]);

  if (isMatchingCustomerCheckoutReconnectVisit({ refreshedVisitContextId: callbacks[0], currentVisitContextId })) getCount += 1;
  assert.equal(getCount, 0, "a refresh for the new visit must not read against the still-rendered old visit");
  currentVisitContextId = VISIT_B;
  if (isMatchingCustomerCheckoutReconnectVisit({ refreshedVisitContextId: callbacks[0], currentVisitContextId })) getCount += 1;
  assert.equal(getCount, 1, "the queued read is released once the refreshed visit becomes current");
  assert.match(appSource, /requestGeneration !== checkoutReadGenerationRef\.current/);
  assert.match(appSource, /checkoutState\.visitContextId === checkoutVisitContextId/);
});

test("reconnect never opens a closed modal, and failed current-state GETs clear any previous total", () => {
  const callbackStart = appSource.indexOf("const refreshCheckoutAfterReconnect =");
  const callbackEnd = appSource.indexOf("const unsubscribe = typeof orderClient.subscribeInvalidations", callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  const reconnectCallback = appSource.slice(callbackStart, callbackEnd);
  assert.doesNotMatch(reconnectCallback, /setModal|requestCheckout/);
  assert.match(appSource, /checkout: null, visitContextId: checkoutVisitContextId/);
  assert.match(appSource, /if \(cancelled \|\| requestGeneration !== checkoutReadGenerationRef\.current\) return/);
});
