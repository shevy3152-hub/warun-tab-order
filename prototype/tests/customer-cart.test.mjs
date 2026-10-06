import assert from "node:assert/strict";
import test from "node:test";
import { addCustomerCartSelection, customerCartItemSnapshot, customerCartRows, removeCustomerCartSelection } from "../src/customer-cart.js";

const regularItem = { id: "regular", name: "QA通常商品", categoryId: "qa" };
const restrictedItem = { id: "restricted", name: "QA来店限定商品", categoryId: "qa" };

test("limited-only cart keeps its display snapshot after the customer menu removes the product", () => {
  const cart = addCustomerCartSelection({}, restrictedItem, { temperature: "冷" }, 2);
  const [row] = customerCartRows(cart, []);

  assert.equal(customerCartRows(cart, []).length, 1);
  assert.equal(row.item.name, "QA来店限定商品");
  assert.equal(row.temperature, "冷");
  assert.equal(row.quantity, 2);
  assert.equal(row.unavailable, true);
  assert.deepEqual(cart[Object.keys(cart)[0]].displaySnapshot, {
    name: "QA来店限定商品",
    baseName: "QA来店限定商品",
    categoryId: "qa",
  });
});

test("mixed cart keeps regular and revoked rows visible and only the removed row unavailable", () => {
  let cart = addCustomerCartSelection({}, regularItem, {}, 1);
  cart = addCustomerCartSelection(cart, restrictedItem, {}, 3);

  const rows = customerCartRows(cart, [regularItem]);
  assert.deepEqual(rows.map(({ item, quantity, unavailable }) => ({ name: item.name, quantity, unavailable })), [
    { name: "QA通常商品", quantity: 1, unavailable: false },
    { name: "QA来店限定商品", quantity: 3, unavailable: true },
  ]);
});

test("removing the unavailable row leaves the regular row ready for ordering", () => {
  let cart = addCustomerCartSelection({}, regularItem, {}, 1);
  cart = addCustomerCartSelection(cart, restrictedItem, {}, 1);
  const restrictedKey = Object.keys(cart).find((key) => cart[key].menuItemId === restrictedItem.id);

  const remainingCart = removeCustomerCartSelection(cart, restrictedKey);
  const rows = customerCartRows(remainingCart, [regularItem]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, regularItem);
  assert.equal(rows[0].unavailable, false);
  assert.equal(Object.values(remainingCart).some((row) => row.menuItemId === restrictedItem.id), false);
});

test("regrant makes an existing cart row available without duplicating its quantity", () => {
  const cart = addCustomerCartSelection({}, restrictedItem, {}, 2);

  const rowsAfterGrant = customerCartRows(cart, [restrictedItem]);
  assert.equal(rowsAfterGrant.length, 1);
  assert.equal(rowsAfterGrant[0].quantity, 2);
  assert.equal(rowsAfterGrant[0].unavailable, false);
  assert.equal(rowsAfterGrant[0].item, restrictedItem);
});

test("adding the same selection increments one row and preserves its original display snapshot", () => {
  const updatedName = { ...restrictedItem, name: "別の表示名" };
  let cart = addCustomerCartSelection({}, restrictedItem, {}, 1);
  cart = addCustomerCartSelection(cart, updatedName, {}, 2);

  const rows = customerCartRows(cart, [updatedName]);
  assert.equal(Object.keys(cart).length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[0].item.name, "別の表示名");
  assert.equal(cart[Object.keys(cart)[0]].displaySnapshot.name, "QA来店限定商品");
});

test("customer display snapshots contain only item text needed by the cart", () => {
  assert.deepEqual(customerCartItemSnapshot({
    name: "商品名",
    baseName: "正式商品名",
    categoryId: "qa",
    price: 480,
    customerVisibilityMode: "per_session",
    sessionId: "server-only",
  }), { name: "商品名", baseName: "正式商品名", categoryId: "qa" });
});
