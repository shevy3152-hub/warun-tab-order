import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_BUSINESS_HOURS, businessHoursDisplay, businessHoursHourLabel, fetchPublicBusinessHours, normalizeBusinessHours } from '../src/business-hours.js';

test('business-hours common formatter preserves 24:00-29:59 and marks next-day select labels', () => {
  const settings = normalizeBusinessHours({ openTime: '17:00', closeTime: '29:59', lastOrderTime: '24:00', isVisible: true });
  assert.deepEqual(businessHoursDisplay(settings), { range: '17:00 — 29:59', lastOrder: '（ラストオーダー 24:00）' });
  assert.equal(businessHoursHourLabel(23), '23時');
  assert.equal(businessHoursHourLabel(24), '翌日 24時');
  assert.equal(businessHoursHourLabel(29), '翌日 29時');
});

test('public business-hours client falls back to the legacy display on failure', async () => {
  const settings = await fetchPublicBusinessHours({
    env: { location: { origin: 'http://127.0.0.1:5173' } },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(settings, DEFAULT_BUSINESS_HOURS);
});
