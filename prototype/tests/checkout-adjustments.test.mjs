import assert from "node:assert/strict";
import test from "node:test";
import { CHECKOUT_ADJUSTMENT_TYPES, checkoutAdjustmentTotal, normalizeCheckoutAdjustments, parseFixedAdjustment } from "../src/checkout-adjustments.js";

function draft({ seat = [500, 1], late = [0, 1], extension = [0, 1], other = [] } = {}) {
  return {
    [CHECKOUT_ADJUSTMENT_TYPES[0][0]]: { label: "席料", unitAmount: String(seat[0]), people: String(seat[1]) },
    [CHECKOUT_ADJUSTMENT_TYPES[1][0]]: { label: "深夜チャージ", unitAmount: String(late[0]), people: String(late[1]) },
    [CHECKOUT_ADJUSTMENT_TYPES[2][0]]: { label: "延長料金", unitAmount: String(extension[0]), people: String(extension[1]) },
    other,
  };
}

test("calculates one-person and multi-person fixed charges together", () => {
  const normalized = normalizeCheckoutAdjustments(draft({ seat: [500, 2], late: [300, 3], extension: [200, 1] }));
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.adjustments.slice(0, 3).map(({ label, amountYen }) => [label, amountYen]), [
    ["席料（500円×2名）", 1000],
    ["深夜チャージ（300円×3名）", 900],
    ["延長料金（200円×1名）", 200],
  ]);
  assert.equal(checkoutAdjustmentTotal(draft({ seat: [500, 2], late: [300, 3], extension: [200, 1], other: [{ label: "任意料金", amount: "150" }] })), 2250);
});

test("rejects invalid people counts and incomplete amounts instead of saving zero", () => {
  assert.equal(normalizeCheckoutAdjustments(draft({ seat: [500, 0] })).ok, false);
  assert.equal(normalizeCheckoutAdjustments(draft({ seat: [500, 100] })).ok, false);
  assert.equal(normalizeCheckoutAdjustments(draft({ seat: ["", 2] })).ok, false);
  assert.equal(normalizeCheckoutAdjustments(draft({ other: [{ label: "", amount: "0" }] })).ok, false);
});

test("reloads formula labels and keeps old amount-only rows compatible", () => {
  assert.deepEqual(parseFixedAdjustment({ label: "席料（500円×2名）", amountYen: 1000 }, "席料"), { label: "席料", unitAmount: "500", people: "2" });
  assert.deepEqual(parseFixedAdjustment({ label: "席料", amountYen: 500 }, "席料"), { label: "席料", unitAmount: "500", people: "1" });
  assert.deepEqual(parseFixedAdjustment({ label: "", amountYen: 0 }, "席料"), { label: "席料", unitAmount: "0", people: "1" });
});

test("keeps the total limited to the checkout session's supplied adjustments", () => {
  const sameSession = 8100;
  const otherSession = 550;
  const normalized = normalizeCheckoutAdjustments(draft({ seat: [0, 1], other: [{ label: "同一sessionの追加料金", amount: String(otherSession) }] }));
  assert.equal(normalized.ok, true);
  assert.equal(sameSession + normalized.adjustments.reduce((sum, item) => sum + item.amountYen, 0), 8650);
  assert.equal(normalized.adjustments.filter((item) => item.kind === "other").length, 1);
});
