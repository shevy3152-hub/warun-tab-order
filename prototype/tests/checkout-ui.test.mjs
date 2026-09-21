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
