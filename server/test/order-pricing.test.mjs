import assert from 'node:assert/strict';
import test from 'node:test';

import {
  orderItemAmounts,
  sumCurrentOrderItemTotals,
} from '../src/orders/order-pricing.mjs';

test('shared order pricing uses adjusted unit price times quantity and preserves snapshot amounts', () => {
  const adjusted = orderItemAmounts({
    unit_price_yen_snapshot: 380,
    adjusted_unit_price_yen: 300,
    quantity: 3,
    line_total_yen: 1140,
  });

  assert.deepEqual(adjusted, {
    unitPriceYenSnapshot: 380,
    adjustedUnitPriceYen: 300,
    currentUnitPriceYen: 300,
    quantity: 3,
    lineTotalYenSnapshot: 1140,
    lineTotalYen: 900,
  });
});

test('shared order pricing falls back to the order-time snapshot and accepts a zero adjustment', () => {
  assert.equal(orderItemAmounts({
    unitPriceYenSnapshot: 680,
    adjustedUnitPriceYen: null,
    quantity: 2,
  }).lineTotalYen, 1360);
  assert.equal(orderItemAmounts({
    unitPriceYenSnapshot: 680,
    adjustedUnitPriceYen: 0,
    quantity: 2,
  }).lineTotalYen, 0);
});

test('shared order total excludes cancelled rows without mutating their price snapshots', () => {
  const rows = [
    { unitPriceYenSnapshot: 380, adjustedUnitPriceYen: 300, quantity: 2, lineTotalYenSnapshot: 760 },
    { unit_price_yen_snapshot: 680, adjusted_unit_price_yen: null, quantity: 1, is_cancelled: 1 },
  ];

  assert.equal(sumCurrentOrderItemTotals(rows), 600);
  assert.equal(rows[0].lineTotalYenSnapshot, 760);
  assert.equal(rows[1].unit_price_yen_snapshot, 680);
});
