export const MIN_CUSTOMER_THEME_ZOOM = 1;
export const MAX_CUSTOMER_THEME_ZOOM = 3;

export function customerThemeImageMinimumZoom(image, frameWidth, frameHeight) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  const frameW = Number(frameWidth);
  const frameH = Number(frameHeight);
  if (!(width > 0 && height > 0 && frameW > 0 && frameH > 0)) return MIN_CUSTOMER_THEME_ZOOM;
  const coverScale = Math.max(frameW / width, frameH / height);
  const containScale = Math.min(frameW / width, frameH / height);
  return Math.min(MIN_CUSTOMER_THEME_ZOOM, containScale / coverScale);
}

export function normalizeCustomerThemeLayout(variant = {}) {
  const position = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  const zoom = Number.isFinite(variant.zoom) ? variant.zoom : MIN_CUSTOMER_THEME_ZOOM;
  return {
    positionX: position(variant.positionX),
    positionY: position(variant.positionY),
    zoom: Math.max(0.5, Math.min(MAX_CUSTOMER_THEME_ZOOM, zoom)),
  };
}

export function resolveCustomerThemeZoom(storedZoom, minimumZoom) {
  const zoom = Number.isFinite(storedZoom) ? storedZoom : MIN_CUSTOMER_THEME_ZOOM;
  const minimum = Number.isFinite(minimumZoom) ? Math.max(0.1, Math.min(MIN_CUSTOMER_THEME_ZOOM, minimumZoom)) : MIN_CUSTOMER_THEME_ZOOM;
  if (zoom >= MIN_CUSTOMER_THEME_ZOOM) return Math.min(MAX_CUSTOMER_THEME_ZOOM, zoom);
  return minimum + ((Math.max(0.5, zoom) - 0.5) / 0.5) * (MIN_CUSTOMER_THEME_ZOOM - minimum);
}

export function customerThemeStoredZoomForVisualZoom(visualZoom, minimumZoom) {
  const minimum = Number.isFinite(minimumZoom) ? Math.max(0.1, Math.min(MIN_CUSTOMER_THEME_ZOOM, minimumZoom)) : MIN_CUSTOMER_THEME_ZOOM;
  const zoom = Number.isFinite(visualZoom) ? Math.max(minimum, Math.min(MAX_CUSTOMER_THEME_ZOOM, visualZoom)) : MIN_CUSTOMER_THEME_ZOOM;
  if (zoom >= MIN_CUSTOMER_THEME_ZOOM || minimum >= MIN_CUSTOMER_THEME_ZOOM) return zoom;
  return 0.5 + ((zoom - minimum) / (MIN_CUSTOMER_THEME_ZOOM - minimum)) * 0.5;
}

export function customerThemePositionAfterDrag(position, pointerDelta, renderedDelta, previewScale = 1) {
  if (!Number.isFinite(renderedDelta) || Math.abs(renderedDelta) <= 0.5 || !Number.isFinite(previewScale) || previewScale <= 0) return position;
  const next = position - (pointerDelta / previewScale) / renderedDelta;
  return Math.max(0, Math.min(1, next));
}

export function customerThemeImageLayout(image, variant, frameWidth, frameHeight) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  const frameW = Number(frameWidth);
  const frameH = Number(frameHeight);
  if (!(width > 0 && height > 0 && frameW > 0 && frameH > 0)) return null;

  const minimumZoom = customerThemeImageMinimumZoom(image, frameW, frameH);
  const layout = normalizeCustomerThemeLayout(variant);
  const visualZoom = resolveCustomerThemeZoom(layout.zoom, minimumZoom);
  const sourceRatio = width / height;
  const frameRatio = frameW / frameH;
  const coverWidth = sourceRatio > frameRatio ? frameH * sourceRatio : frameW;
  const coverHeight = sourceRatio > frameRatio ? frameH : frameW / sourceRatio;
  const renderWidth = coverWidth * visualZoom;
  const renderHeight = coverHeight * visualZoom;
  const deltaX = renderWidth - frameW;
  const deltaY = renderHeight - frameH;
  const overflowX = Math.max(0, deltaX);
  const overflowY = Math.max(0, deltaY);
  const spaceX = Math.max(0, -deltaX);
  // Center stays fixed; even a frame-height image can move up and down.
  const rangeY = Math.max(Math.abs(deltaY), frameH);
  const offsetY = -deltaY / 2 + (0.5 - layout.positionY) * rangeY;
  const visibleHeight = Math.max(0, Math.min(frameH, offsetY + renderHeight) - Math.max(0, offsetY));
  const spaceY = frameH - visibleHeight;
  const rangeX = Math.abs(deltaX);


  return {
    style: {
      width: `${renderWidth}px`,
      height: `${renderHeight}px`,
      left: `${-deltaX * layout.positionX}px`,
      top: `${offsetY}px`,
    },
    metrics: {
      frameWidth: frameW,
      frameHeight: frameH,
      renderWidth,
      renderHeight,
      overflowX,
      overflowY,
      spaceX,
      spaceY,
      deltaX,
      deltaY,
      rangeX,
      rangeY,
      offsetY,
      minimumZoom,
      canMoveX: rangeX > 0.5,
      canMoveY: rangeY > 0.5,
      croppedSourceWidth: Math.max(0, width - (frameW / renderWidth) * width),
      croppedSourceHeight: Math.max(0, height - (visibleHeight / renderHeight) * height),
      zoom: visualZoom,
      storedZoom: layout.zoom,
    },
  };
}
