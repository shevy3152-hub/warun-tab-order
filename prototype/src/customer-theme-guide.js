// All rectangles must come from the same document after ancestor transforms.
const validRect = (rect) => rect && ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(rect[key])) && rect.right > rect.left && rect.bottom > rect.top;

export function customerThemeGuideImageCoordinates({ image, imageRect, clipRects = [], regionRect, hidden = false }) {
  if (hidden) return { status: 'hidden' };
  if (!(image?.width > 0 && image?.height > 0) || !validRect(imageRect) || !validRect(regionRect) || clipRects.some((rect) => !validRect(rect))) return { status: 'pending' };
  const rectangles = [imageRect, regionRect, ...clipRects];
  const left = Math.max(...rectangles.map((rect) => rect.left));
  const top = Math.max(...rectangles.map((rect) => rect.top));
  const right = Math.min(...rectangles.map((rect) => rect.right));
  const bottom = Math.min(...rectangles.map((rect) => rect.bottom));
  if (right <= left || bottom <= top) return { status: 'none' };
  const x = (value) => (value - imageRect.left) * image.width / (imageRect.right - imageRect.left);
  const y = (value) => (value - imageRect.top) * image.height / (imageRect.bottom - imageRect.top);
  return { status: 'overlap', left: x(left), top: y(top), right: x(right), bottom: y(bottom) };
}
