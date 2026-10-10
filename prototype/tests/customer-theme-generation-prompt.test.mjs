import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_THEME_DEFINITIONS as definitions } from '../../shared/customer-theme-definitions.mjs';
import { buildCustomerThemeGenerationPrompt as build } from '../src/customer-theme-generation-prompt.js';

const measurement = { imageHidden: false, zoom: 0.5234, minimumZoom: 0.5234, frameWidth: 220, frameHeight: 1025, positionX: 0.5, positionY: 0.5, categoryCount: 3, placeholderCount: 1, viewportWidth: 638, viewportHeight: 1025, dpr: 0.63, spaceX: 0, spaceY: 488.56, rangeX: 0, rangeY: 488.56, visibleImage: { status: 'overlap', left: 0, top: 0, right: 803, bottom: 1958 }, regions: [{ label: '店名', status: 'none' }, { label: 'カテゴリ', status: 'overlap', left: 65, top: 0, right: 737, bottom: 688 }, { label: '営業時間', status: 'pending' }, { label: '案内ボタン', status: 'hidden' }] };
const definition = definitions['japanese-halloween'];
test('generation prompt combines instructions, measured bounds and conditions with explicit units', () => {
  const result = build({ definition, variant: { prompt: definition.prompt }, measurement });
  assert.match(result, /PNG形式、横803×縦1958画像px/);
  assert.match(result, /画像全体を表示/);
  assert.match(result, /左0.0・上0.0・右803.0・下1958.0画像px/);
  assert.match(result, /カテゴリ：左65.0・上0.0・右737.0・下688.0画像px/);
  assert.match(result, /営業時間：計測待ち・座標なし/);
  assert.match(result, /案内ボタン：現在は非表示・座標なし/);
  assert.match(result, /縦488.6 CSS px/);
  assert.match(result, /元画像内に描く余白の寸法ではありません/);
  assert.match(result, /UI文字やボタン・区切り線を画像へ描き込まない/);
  assert.match(result, /アンティーク書体/);
  assert.doesNotMatch(result, /ポップな橙色のHALLOWEEN/);
});
test('custom image direction is retained and dimensions are selected per theme', () => {
  const result = build({ definition: definitions.camellia, variant: { prompt: '青い水彩の椿。手書きの希望を保持。' }, measurement: null });
  assert.match(result, /横426×縦1587画像px/);
  assert.match(result, /青い水彩の椿。手書きの希望を保持。/);
  assert.match(result, /計測待ち/);
  assert.doesNotMatch(result, /803|Halloween|アンティーク/);
  assert.equal(build({ definition: definitions.standard, variant: {}, measurement }), '');
});
test('changed position and zoom update the generated copy; hidden images do not invent coordinates', () => {
  const first = build({ definition, variant: { prompt: '好きな書体' }, measurement });
  const next = build({ definition, variant: { prompt: '好きな書体' }, measurement: { ...measurement, positionX: 1, zoom: 1.2, visibleImage: { status: 'overlap', left: 100, top: 200, right: 700, bottom: 1800 } } });
  assert.notEqual(first, next);
  assert.match(next, /拡大調整/);
  assert.match(next, /X100.0%/);
  assert.match(next, /切り抜き量：左100.0・上200.0・右103.0・下158.0画像px/);
  const hidden = build({ definition, variant: {}, measurement: { ...measurement, imageHidden: true } });
  assert.match(hidden, /画像が非表示/);
  assert.doesNotMatch(hidden, /左65.0/);
});
