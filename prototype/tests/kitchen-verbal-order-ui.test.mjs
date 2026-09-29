import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("kitchen verbal order menu displays kitchen aliases without changing the formal payload name", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const modal = app.slice(app.indexOf("function KitchenAdditionModal"), app.indexOf("function cancelledQuantityForDisplay"));

  assert.match(app, /function kitchenAdditionMenuName\(item\) \{[\s\S]*?typeof item\?\.kitchenAlias === "string"[\s\S]*?alias \|\| item\?\.name \|\| "";/);
  assert.match(modal, /<span>\{kitchenAdditionMenuName\(item\)\}<\/span>/);
  assert.match(modal, /<b>\{kitchenAdditionMenuName\(selectedMenuItem\)\}<\/b>/);
  assert.match(modal, /\{ menuItemId: selected\.id, name: selected\.name, priceYen: Number\(selected\.price\), quantity: count \}/);
  assert.match(modal, /<label>商品名<input value=\{name\}/);
  assert.match(modal, /<label>金額<input type="number"/);
});
