import { customerThemeImageLayout } from './customer-theme-layout.js';
import { customerThemeGuideImageCoordinates } from './customer-theme-guide.js';

// CSS rectangles from the A90 customer WebView, 2026-10-12. DPR is metadata only.
export const A90_THEME_CONDITION = Object.freeze({ id: 'a90', label: 'A90キオスク実測条件', viewportWidth: 1313, viewportHeight: 820, dpr: 1.462499976158142, frameWidth: 220, frameHeight: 820.5128173828125 });
const region = (key, label, x, y, width, height, backgroundOnly = false) => Object.freeze({ key, label, rect: { left: x, top: y, right: x + width, bottom: y + height }, backgroundOnly });
export const A90_THEME_REGIONS = Object.freeze([
  region('brand', '店名', 17.991453, 18.995728, 178.846161, 20),
  region('categories', 'カテゴリ全体（上部は透明余白）', 17.991453, 61.987183, 184.017105, 375, true),
  region('category-1', 'カテゴリ1', 17.991453, 216.987183, 184.017105, 55),
  region('category-2', 'カテゴリ2', 17.991453, 271.987183, 184.017105, 55),
  region('category-3', 'カテゴリ3', 17.991453, 326.987183, 184.017105, 55),
  region('placeholder', '空き行（ナビ残余・未実測）', 17.991453, 381.987183, 184.017105, 55),
  region('hours', '営業時間', 31.987181, 687.873962, 156.02565, 100.651711),
]);
export function customerThemeConditionModel({ image, variant, condition = A90_THEME_CONDITION, regions = A90_THEME_REGIONS, collapsed = false }) {
  // Match clientWidth/clientHeight used by the real customer layout; clipping uses the fractional CSS rectangle.
  const layout = customerThemeImageLayout(image, variant, Math.round(condition.frameWidth), Math.round(condition.frameHeight));
  if (!layout) return null;
  const left = Number.parseFloat(layout.style.left), top = Number.parseFloat(layout.style.top);
  const imageRect = { left, top, right: left + layout.metrics.renderWidth, bottom: top + layout.metrics.renderHeight };
  const frameRect = { left: 0, top: 0, right: condition.frameWidth, bottom: condition.frameHeight };
  const coordinate = (rect) => customerThemeGuideImageCoordinates({ image, imageRect, clipRects: [frameRect], regionRect: rect, hidden: collapsed });
  return { layout, measurement: { ...condition, ...layout.metrics, frameWidth: condition.frameWidth, frameHeight: condition.frameHeight, layoutFrameHeight: layout.metrics.frameHeight, zoom: layout.metrics.zoom, theme: variant.theme, collapsed, imageHidden: collapsed, positionX: variant.positionX, positionY: variant.positionY, storedZoom: variant.zoom, conditionId: condition.id, conditionLabel: condition.label, categoryCount: 3, placeholderCount: 1, visibleImage: coordinate(imageRect), regions: regions.map(r => ({ key: r.key, label: r.label, backgroundOnly: r.backgroundOnly, ...coordinate(r.rect) })), limitations: '実測矩形の再現。文字内容・字形・カテゴリ件数の変更・案内ボタン・折り畳み配置は未再現。空き行の矩形はナビ残余からの推定。DPRは画像座標へ掛けない。' } };
}

// Conservative full-width bands: subtract measured foreground UI, then leave margins.
export function customerThemePlacementFrames(measurement, image) {
  const visible = measurement?.visibleImage;
  if (measurement?.imageHidden || visible?.status !== 'overlap' || !image) return { title: null, subject: null, reason: '表示範囲が未取得または非表示' };
  const width = visible.right - visible.left, height = visible.bottom - visible.top;
  const padX = width * .07, padY = height * .025;
  const inner = { left: visible.left + padX, right: visible.right - padX, top: visible.top + padY, bottom: visible.bottom - padY };
  const foreground = (measurement.regions || []).filter(r => !r.backgroundOnly);
  if (foreground.some(r => r.status === 'pending')) return { title: null, subject: null, reason: 'UI矩形が未取得のため配置枠は未確定' };
  const blocked = foreground.filter(r => r.status === 'overlap' && r.right > inner.left && r.left < inner.right).map(r => [Math.max(inner.top, r.top - padY), Math.min(inner.bottom, r.bottom + padY)]).filter(([a,b]) => b > a).sort((a,b) => a[0] - b[0]);
  let cursor = inner.top;const gaps = [];
  for (const [a,b] of blocked) { if (a > cursor) gaps.push([cursor,a]);cursor = Math.max(cursor,b); }
  if (cursor < inner.bottom) gaps.push([cursor,inner.bottom]);
  const rect = gap => gap ? { left: inner.left, top: gap[0], right: inner.right, bottom: gap[1] } : null;
  if (inner.right - inner.left < image.width * .2) return { title: null, subject: null, reason: '横幅が不足' };
  const usable = gaps.filter(([a,b]) => b - a >= image.height * .07);
  const titleGap = usable.find(([a,b]) => (a+b)/2 < image.height * .55);
  const subjectGap = usable.filter(g => g !== titleGap && (g[0]+g[1])/2 > image.height * .45).sort((a,b) => (b[1]-b[0])-(a[1]-a[0]))[0];
  return { title: rect(titleGap), subject: rect(subjectGap), reason: '実測UIのない空き帯から作る制作案。未再現UI・別表示条件での安全保証なし' };
}
