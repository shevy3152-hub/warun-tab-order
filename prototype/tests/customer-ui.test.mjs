import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const customerScreen = appSource.slice(appSource.indexOf("function CustomerScreen"), appSource.indexOf("const staffNavItems"));

test("CustomerScreen does not render menu prices or totals", () => {
  assert.doesNotMatch(customerScreen, /menu-row__price/);
  assert.doesNotMatch(customerScreen, /totalAmount.*yen\(|yen\(.*totalAmount/);
  assert.match(customerScreen, /price-hidden-note/);
});
