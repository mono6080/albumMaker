const DEFAULT_PHOTO_BORDER_WIDTH = 8;
export const PHOTO_SLOT_DIMENSION_MODE_KEY = "photo_slot_dimension_mode";
export const PHOTO_SLOT_CONTENT_BOX_MODE = "content-box-v1";

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getPhotoSlotDimensionMode(source = {}) {
  const value = source?.[PHOTO_SLOT_DIMENSION_MODE_KEY] ?? source?.dimensionMode;
  return value === PHOTO_SLOT_CONTENT_BOX_MODE ? PHOTO_SLOT_CONTENT_BOX_MODE : "frame-box-v1";
}

export function isPhotoContentBoxMode(source = {}) {
  return getPhotoSlotDimensionMode(source) === PHOTO_SLOT_CONTENT_BOX_MODE;
}

export function getPhotoFrameInsets(slot = {}) {
  const hasBorder = slot.border !== false;
  const borderWidth = hasBorder
    ? Math.max(0, toFiniteNumber(slot.border_width ?? slot.borderW, DEFAULT_PHOTO_BORDER_WIDTH))
    : 0;

  return {
    left: borderWidth,
    top: borderWidth,
    right: borderWidth,
    bottom: borderWidth * 3,
    borderWidth,
    hasBorder,
  };
}

export function getPhotoContentRect(slot = {}, options = {}) {
  const width = Math.max(1, toFiniteNumber(slot.width ?? slot.slotW, 1));
  const height = Math.max(1, toFiniteNumber(slot.height ?? slot.slotH, 1));
  const x = toFiniteNumber(slot.x, 0);
  const y = toFiniteNumber(slot.y, 0);
  if (isPhotoContentBoxMode(options.dimensionMode ? { dimensionMode: options.dimensionMode } : slot)) {
    return { x, y, width, height };
  }

  const insets = getPhotoFrameInsets(slot);

  return {
    x: x + insets.left,
    y: y + insets.top,
    width: Math.max(1, width - insets.left - insets.right),
    height: Math.max(1, height - insets.top - insets.bottom),
  };
}

export function getPhotoFrameRect(slot = {}, options = {}) {
  const width = Math.max(1, toFiniteNumber(slot.width ?? slot.slotW, 1));
  const height = Math.max(1, toFiniteNumber(slot.height ?? slot.slotH, 1));
  const x = toFiniteNumber(slot.x, 0);
  const y = toFiniteNumber(slot.y, 0);
  if (!isPhotoContentBoxMode(options.dimensionMode ? { dimensionMode: options.dimensionMode } : slot)) {
    return { x, y, width, height };
  }

  const insets = getPhotoFrameInsets(slot);
  return {
    x: x - insets.left,
    y: y - insets.top,
    width: width + insets.left + insets.right,
    height: height + insets.top + insets.bottom,
  };
}

export function buildPhotoFrameRectFromContent(slot = {}, contentRect = {}) {
  const insets = getPhotoFrameInsets(slot);
  const contentX = toFiniteNumber(contentRect.x, 0);
  const contentY = toFiniteNumber(contentRect.y, 0);
  const contentWidth = Math.max(1, toFiniteNumber(contentRect.width, 1));
  const contentHeight = Math.max(1, toFiniteNumber(contentRect.height, 1));

  return {
    x: Math.round(contentX - insets.left),
    y: Math.round(contentY - insets.top),
    width: Math.round(contentWidth + insets.left + insets.right),
    height: Math.round(contentHeight + insets.top + insets.bottom),
  };
}

export function buildPhotoSlotFromContentRect(slot = {}, contentRect = {}, options = {}) {
  if (isPhotoContentBoxMode(options.dimensionMode ? { dimensionMode: options.dimensionMode } : slot)) {
    return {
      ...slot,
      x: Math.round(toFiniteNumber(contentRect.x, 0)),
      y: Math.round(toFiniteNumber(contentRect.y, 0)),
      width: Math.round(Math.max(1, toFiniteNumber(contentRect.width, 1))),
      height: Math.round(Math.max(1, toFiniteNumber(contentRect.height, 1))),
    };
  }

  return {
    ...slot,
    ...buildPhotoFrameRectFromContent(slot, contentRect),
  };
}
