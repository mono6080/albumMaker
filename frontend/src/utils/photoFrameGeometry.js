// 照片框幾何（拍立得 insets、content rect、等比 snap）
// 跨語言鏡像：backend/services/photo_frame_geometry.py（Konva 與 PIL 各需一份實作，
// 數值走共用 design tokens）；一致性由 tests/test_contract_pins.py 釘住。
import { DESIGN_TOKENS } from "../constants/designTokens.js";

const DEFAULT_PHOTO_BORDER_WIDTH = DESIGN_TOKENS.photo_frame.default_border_width;
const BOTTOM_INSET_MULTIPLIER = DESIGN_TOKENS.photo_frame.bottom_inset_multiplier;
export const PHOTO_SLOT_DIMENSION_MODE_KEY = "photo_slot_dimension_mode";
export const PHOTO_SLOT_CONTENT_BOX_MODE = "content-box-v1";
// 照片格內容最小寬度：TemplateEditor 縮放下限與標準比例 snap 下限共用
export const PHOTO_CONTENT_MIN_WIDTH = DESIGN_TOKENS.photo_frame.content_min_width;

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
    bottom: borderWidth * BOTTOM_INSET_MULTIPLIER,
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

// 標準比例（直式 3:4 / 橫式 4:3）照片格的等比 snap：回傳整數精確的 { width, height }。
// width / height 是改動前的格子尺寸（標準格永遠是整數精確比例，用來判斷方向）；
// changedKey（"width" | "height"）指出使用者實際改動的邊，從 nextValue 推出整數 ratioUnit。
// 下限統一為 PHOTO_CONTENT_MIN_WIDTH（寬 60）；非標準比例格回傳 null 由呼叫端自行處理。
export function snapPhotoSlotStandardRatio(width, height, changedKey, nextValue) {
  const isPortraitSlot = width * 4 === height * 3;
  const isLandscapeSlot = width * 3 === height * 4;
  if (!isPortraitSlot && !isLandscapeSlot) return null;

  const [widthMultiple, heightMultiple] = isPortraitSlot ? [3, 4] : [4, 3];
  const ratioUnit = Math.max(
    PHOTO_CONTENT_MIN_WIDTH / widthMultiple,
    Math.round(nextValue / (changedKey === "width" ? widthMultiple : heightMultiple)),
  );
  return { width: ratioUnit * widthMultiple, height: ratioUnit * heightMultiple };
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
