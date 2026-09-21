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
