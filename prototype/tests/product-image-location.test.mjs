import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { productImageLocation, copyProductImageFolder } from "../src/product-image-location.js";
const knownPaths = ["/menu-images/sake/sample-thumb.png", "/menu-images/sake/sample-detail.png", "/menu-images/shochu/sample-thumb-v2.webp"];
const options = { knownPaths };
test("confirmed public images map to relative folders without an absolute setting", () => {
  const location = productImageLocation("/menu-images/sake/sample-thumb.png?v=2", options);
  assert.equal(location.kind, "local");
  assert.equal(location.filename, "sample-thumb.png");
  assert.equal(location.folder, "prototype/public/menu-images/sake");
  assert.equal(location.absolute, false);
  assert.equal(location.folderUrl, "");
  assert.equal(productImageLocation("./menu-images/sake/sample-detail.png", options).filename, "sample-detail.png");
});
test("a separate public folder setting supplies an absolute copy path and file link", () => {
  const location = productImageLocation(knownPaths[0], { ...options, publicFolder: "C:/example project/prototype/public" });
  assert.equal(location.folder, "C:/example project/prototype/public/menu-images/sake");
  assert.equal(location.folderUrl, "file:///C:/example%20project/prototype/public/menu-images/sake/");
  assert.equal(location.absolute, true);
  assert.equal(productImageLocation(knownPaths[0], { ...options, publicFolder: "relative/public" }).absolute, false);
});
test("no image, external URLs, embedded images and unknown local paths stay distinct", () => {
  assert.equal(productImageLocation("", options).kind, "none");
  const external = productImageLocation("https://images.example.test/photo.png?secret=value", options);
  assert.equal(external.kind, "external");
  assert.equal(external.filename, "photo.png");
  assert.equal(external.folder, undefined);
  for (const uri of ["data:image/png;base64,AAA", "blob:test", "/missing.png", "/menu-images/../sake/sample-thumb.png", "/%ZZ"]) assert.equal(productImageLocation(uri, options).kind, "unknown");
  assert.equal(productImageLocation("https://qa.example.test" + knownPaths[0], { ...options, origin: "https://qa.example.test" }).kind, "local");
});
test("copy sends the confirmed folder or selects the displayed fallback input", async () => {
  let copied;
  await copyProductImageFolder("prototype/public/menu-images/sake", null, { clipboard: { writeText: async (value) => { copied = value; } } });
  assert.equal(copied, "prototype/public/menu-images/sake");
  let selected = false;
  await copyProductImageFolder("folder", { select: () => { selected = true; } }, { execCommand: (command) => command === "copy" });
  assert.equal(selected, true);
  await assert.rejects(copyProductImageFolder("folder", null));
  await assert.rejects(copyProductImageFolder("", null));
});
test("both menu editors preserve their URI form fields and render separate image guidance", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../src/ProductImageLocation.jsx", import.meta.url), "utf8");
  assert.equal((app.match(/<ProductImageUriField name="imageUri"/g) || []).length, 2);
  assert.match(app, /<ProductImageUriField name="detailImageUri"/);
  assert.match(app, /resolveDisplayUri=\{item.categoryId === "shochu" \? shochuThumbUri/);
  assert.match(component, /VITE_PRODUCT_IMAGE_PUBLIC_FOLDER/);
  assert.doesNotMatch(component, /VITE_CUSTOMER_THEME_IMAGE_SOURCE_FOLDER|C:\\/);
  assert.match(component, /type="button"/);
  assert.match(component, /defaultValue=\{initialUri\}/);
  assert.match(component, /form\?\.addEventListener\("input", refresh\)/);
  assert.match(component, /保存先のパスをコピー/);
});
