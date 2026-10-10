import test from 'node:test';
import assert from 'node:assert/strict';
import { customerThemeGuideImageCoordinates as coordinates } from '../src/customer-theme-guide.js';

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
test('guide converts transformed rectangles to the selected source image pixels', () => {
  assert.deepEqual(coordinates({ image: { width: 1000, height: 2000 }, imageRect: rect(100, 200, 300, 600), regionRect: rect(120, 240, 200, 400) }), { status: 'overlap', left: 100, top: 200, right: 500, bottom: 1000 });
  assert.deepEqual(coordinates({ image: { width: 426, height: 1587 }, imageRect: rect(100, 200, 300, 600), regionRect: rect(100, 200, 300, 600) }), { status: 'overlap', left: 0, top: 0, right: 426, bottom: 1587 });
});
test('guide intersects image, UI and all clipping ancestors before conversion', () => {
  assert.deepEqual(coordinates({ image: { width: 1000, height: 2000 }, imageRect: rect(-100, -200, 100, 200), regionRect: rect(-200, -300, 200, 300), clipRects: [rect(0, 0, 150, 250), rect(-50, -50, 50, 100)] }), { status: 'overlap', left: 500, top: 1000, right: 750, bottom: 1500 });
});
test('guide distinguishes no intersection, hidden elements and pending measurement', () => {
  const base = { image: { width: 803, height: 1958 }, imageRect: rect(0, 0, 100, 200) };
  assert.deepEqual(coordinates({ ...base, regionRect: rect(100, 0, 200, 100) }), { status: 'none' });
  assert.deepEqual(coordinates({ ...base, regionRect: rect(0, 0, 100, 100), clipRects: [rect(200, 200, 300, 300)] }), { status: 'none' });
  assert.deepEqual(coordinates({ ...base, hidden: true }), { status: 'hidden' });
  assert.deepEqual(coordinates(base), { status: 'pending' });
  assert.deepEqual(coordinates({ ...base, regionRect: rect(0, 0, 100, 100), imageRect: rect(0, 0, 0, 0) }), { status: 'pending' });
});
test('moving and scaling the image changes reference coordinates without changing placement', () => {
  const base = { image: { width: 1000, height: 2000 }, regionRect: rect(100, 100, 150, 150) };
  assert.equal(coordinates({ ...base, imageRect: rect(0, 0, 200, 400) }).left, 500);
  assert.equal(coordinates({ ...base, imageRect: rect(50, 0, 250, 400) }).left, 250);
  assert.equal(coordinates({ ...base, imageRect: rect(0, 0, 400, 800) }).left, 250);
});
