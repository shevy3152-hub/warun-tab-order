import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerMajorCategories } from "../src/customer-category-navigation.js";

const fallbackCategories = [{ id: "demo", name: "デモ用分類", subcategories: [{ id: "demo-subcategory" }] }];

test("customer categories keep the demo fallback only before an API category array is available", () => {
  assert.equal(buildCustomerMajorCategories(undefined, fallbackCategories), fallbackCategories);
});

test("empty customer API categories keep major rails and fixed refills but hide empty subcategories", () => {
  const categories = buildCustomerMajorCategories([], fallbackCategories);

  assert.deepEqual(categories.map(({ id, name }) => [id, name]), [
    ["drink", "飲み物"],
    ["food", "お食事"],
    ["winter", "冬季限定"],
    ["seasonal", ""],
  ]);
  assert.deepEqual(categories[0].subcategories, [
    { id: "recommended", name: "おかわり！", categoryIds: [] },
  ]);
  assert.equal(categories[1].subcategories.length, 0);
  assert.equal(categories[2].subcategories.length, 0);
  assert.equal(categories[3].subcategories.length, 0);
});

test("customer API categories expose only populated subcategories under their major rail", () => {
  const categories = buildCustomerMajorCategories([
    { categoryId: "qa-menu", name: "QA機能確認", sectionKey: "food", sortOrder: 1 },
  ], fallbackCategories);

  assert.deepEqual(categories.find(({ id }) => id === "food").subcategories, [
    { id: "qa-menu", name: "QA機能確認", categoryIds: ["qa-menu"] },
  ]);
  assert.deepEqual(categories.find(({ id }) => id === "drink").subcategories, [
    { id: "recommended", name: "おかわり！", categoryIds: [] },
  ]);
});
