import assert from "node:assert/strict";
import test from "node:test";

import { taxExcludedYen } from "../src/pricing.js";

test("tax-exclusive display is derived centrally by rounding down", () => {
  assert.equal(taxExcludedYen(550), 500);
  assert.equal(taxExcludedYen(700), 636);
  assert.equal(taxExcludedYen(1300), 1181);
});

test("invalid master prices are rejected", () => {
  for (const value of [-1, 1.5, "550"]) assert.throws(() => taxExcludedYen(value), TypeError);
});
