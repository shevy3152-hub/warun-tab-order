import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_CUSTOMER_THEME_ZOOM, resolveCustomerThemeZoom, normalizeCustomerThemeLayout } from '../src/customer-theme-layout.js';
const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const input = source.match(/<input aria-label="テーマ画像ズーム"[^\r\n]+?\/>/)?.[0];

test('zoom range uses stored 0.5..3 values with a 0.01 grid aligned to the maximum', () => {
  assert.ok(input);
  assert.match(input, /min="0\.5"/);
  assert.match(input, /max=\{MAX_CUSTOMER_THEME_ZOOM\}/);
  assert.match(input, /step="0\.01"/);
  assert.match(input, /value=\{selectedVariant\.zoom\}/);
  assert.match(input, /setSelectedVariant\(\{ zoom: Number\(event\.target\.value\) \}\)/);
  assert.equal(MAX_CUSTOMER_THEME_ZOOM, 3);
  assert.equal((MAX_CUSTOMER_THEME_ZOOM - 0.5) / 0.01, 250);
});

test('every slider tick including End maps to a valid stored zoom and maximum 3 for each measured minimum', () => {
  for (const minimum of [0.8479635620803238, 0.352494409746318, 0.3528444538473572, 0.555017919443309]) {
    for (let tick = 0; tick <= 250; tick++) {
      const storedZoom = (50 + tick) / 100;
      assert.equal(normalizeCustomerThemeLayout({ zoom: storedZoom }).zoom, storedZoom);
      const visualZoom = resolveCustomerThemeZoom(storedZoom, minimum);
      assert.ok(visualZoom >= minimum && visualZoom <= 3);
    }
    assert.equal(resolveCustomerThemeZoom(3, minimum), 3);
    assert.equal(resolveCustomerThemeZoom(1, minimum), 1);
    assert.equal(resolveCustomerThemeZoom(0.5, minimum), minimum);
  }
});