import { getTextLabelRole, isFillableTextLabel } from "./textLabelRoles.js";

import { DESIGN_TOKENS } from "../constants/designTokens.js";
import {
  getPhotoContentRect,
  getPhotoFrameInsets,
  getPhotoFrameRect,
  getPhotoSlotDimensionMode,
} from "./photoFrameGeometry.js";

// 畫布尺寸走跨語言共用 design tokens（正本 backend/services/design_tokens.json）
export const CANVAS_REAL_WIDTH = DESIGN_TOKENS.canvas.width;
export const CANVAS_REAL_HEIGHT = DESIGN_TOKENS.canvas.height;
export const CANVAS_DISPLAY_WIDTH = 530;
export const CANVAS_SCALE = CANVAS_DISPLAY_WIDTH / CANVAS_REAL_WIDTH;
export const CANVAS_DISPLAY_HEIGHT = Math.round(CANVAS_REAL_HEIGHT * CANVAS_SCALE);
export const STICKER_DEFAULT_MAX_SIDE = 150;

const Z_BASE = { photo: 0, bubble: 100, text: 200, sticker: 300 };

// 元素類型 → layout_json 陣列 key 的對照（編輯器與圖層清單共用）
export const ELEMENT_ARRAY_KEY = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };

export function toDisplayCoord(realValue) {
  return realValue * CANVAS_SCALE;
}

export function toRealCoord(displayValue) {
  return Math.round(displayValue / CANVAS_SCALE);
}

export function getInitialStickerSize(imageWidth, imageHeight, maxSide = STICKER_DEFAULT_MAX_SIDE) {
  if (!imageWidth || !imageHeight) {
    return { width: maxSide, height: maxSide };
  }
  const scale = maxSide / Math.max(imageWidth, imageHeight);
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  };
}

export function getAllElementsSorted(layout) {
  if (!layout) return [];
  return [
    ...(layout.photo_slots || []).map((data, index) => ({
      type: "photo",
      data,
      index,
      zDefault: Z_BASE.photo + index,
    })),
    ...(layout.text_bubbles || []).map((data, index) => ({
      type: "bubble",
      data,
      index,
      zDefault: Z_BASE.bubble + index,
    })),
    ...(layout.text_labels || []).map((data, index) => ({
      type: "text",
      data,
      index,
      zDefault: Z_BASE.text + index,
    })),
    ...(layout.stickers || []).map((data, index) => ({
      type: "sticker",
      data,
      index,
      zDefault: Z_BASE.sticker + index,
    })),
  ].sort((a, b) => (a.data.z_index ?? a.zDefault) - (b.data.z_index ?? b.zDefault));
}

export function getNextZIndex(layout) {
  const all = getAllElementsSorted(layout);
  if (all.length === 0) return 0;
  return Math.max(...all.map(element => element.data.z_index ?? element.zDefault)) + 1;
}

export function applyElementsToLayout(layout, sortedElements) {
  const newLayout = { ...layout };
  for (const { type, data } of sortedElements) {
    const key = ELEMENT_ARRAY_KEY[type];
    newLayout[key] = (newLayout[key] || []).map(element => element.id === data.id ? data : element);
  }
  return newLayout;
}

export function getDisplayBox(data) {
  const width = toDisplayCoord(data.width);
  const height = toDisplayCoord(data.height);
  return {
    x: toDisplayCoord(data.x),
    y: toDisplayCoord(data.y),
    width,
    height,
    centerX: toDisplayCoord(data.x) + width / 2,
    centerY: toDisplayCoord(data.y) + height / 2,
    offsetX: width / 2,
    offsetY: height / 2,
    rotation: data.rotation ?? 0,
  };
}

export function getPhotoSlotModel(data, elemIndex, pageIndex = 0, dimensionMode) {
  const frameRect = getPhotoFrameRect(data, { dimensionMode });
  const frameW = toDisplayCoord(frameRect.width);
  const frameH = toDisplayCoord(frameRect.height);
  const box = {
    x: toDisplayCoord(frameRect.x),
    y: toDisplayCoord(frameRect.y),
    width: frameW,
    height: frameH,
    centerX: toDisplayCoord(frameRect.x) + frameW / 2,
    centerY: toDisplayCoord(frameRect.y) + frameH / 2,
    offsetX: frameW / 2,
    offsetY: frameH / 2,
    rotation: data.rotation ?? 0,
  };
  const hasBorder = data.border !== false;
  const insets = getPhotoFrameInsets(data);
  const contentRect = getPhotoContentRect(data, { dimensionMode });
  return {
    type: "photo",
    id: data.id,
    box,
    outerFill: hasBorder ? "#ffffff" : "#EEEEEE",
    innerFill: "#EEEEEE",
    innerBox: hasBorder
      ? {
          x: toDisplayCoord(contentRect.x),
          y: toDisplayCoord(contentRect.y),
          width: toDisplayCoord(contentRect.width),
          height: toDisplayCoord(contentRect.height),
        }
      : box,
    insets: {
      left: toDisplayCoord(insets.left),
      top: toDisplayCoord(insets.top),
      right: toDisplayCoord(insets.right),
      bottom: toDisplayCoord(insets.bottom),
      borderWidth: toDisplayCoord(insets.borderWidth),
    },
    placeholderText: `P${pageIndex + 1}·${elemIndex + 1}`,
  };
}

export function getBubbleModel(data) {
  return {
    type: "bubble",
    id: data.id,
    box: getDisplayBox(data),
    fill: data.fill ?? "#FDED6E",
    borderColor: data.border_color,
    borderWidth: (data.border_width ?? 0) > 0 ? toDisplayCoord(data.border_width) : 0,
    text: (data.text ?? "").substring(0, 30),
    fontColor: data.font_color ?? "#333333",
    fontSize: Math.max(8, toDisplayCoord(data.font_size ?? 20)),
  };
}

export function getTextLabelModel(data) {
  return {
    type: "text",
    id: data.id,
    textRole: getTextLabelRole(data),
    isFillable: isFillableTextLabel(data),
    box: getDisplayBox(data),
    stroke: "#AAAAAA",
    text: (data.text ?? "").substring(0, 60),
    fontColor: data.font_color ?? "#333333",
    fontSize: Math.max(8, toDisplayCoord(data.font_size ?? 24)),
    align: data.text_align ?? "center",
    lineHeight: data.line_height ?? 1.4,
  };
}

export function getFooterModel(footer) {
  const fontSize = footer.font_size ?? 22;
  return {
    type: "footer",
    id: "footer",
    box: {
      x: toDisplayCoord(footer.x ?? CANVAS_REAL_WIDTH / 2),
      y: toDisplayCoord((footer.y ?? CANVAS_REAL_HEIGHT - 50) - fontSize),
      width: toDisplayCoord(CANVAS_REAL_WIDTH - (footer.x ?? 0)),
      height: toDisplayCoord(fontSize * 2),
    },
    text: footer.text ?? "",
    fontColor: footer.font_color ?? "#3B6B8C",
    fontSize: Math.max(8, toDisplayCoord(fontSize)),
  };
}

export function buildRenderLayoutModel(layout, pageIndex = 0) {
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(layout);
  const elements = getAllElementsSorted(layout).map(({ type, data, index }) => {
    if (type === "photo") return getPhotoSlotModel(data, index, pageIndex, photoSlotDimensionMode);
    if (type === "bubble") return getBubbleModel(data);
    if (type === "text") return getTextLabelModel(data);
    return { type, id: data.id, box: getDisplayBox(data) };
  });
  if (layout?.footer?.text) {
    elements.push(getFooterModel(layout.footer));
  }

  return {
    stage: {
      width: CANVAS_DISPLAY_WIDTH,
      height: CANVAS_DISPLAY_HEIGHT,
      scale: CANVAS_SCALE,
      realWidth: CANVAS_REAL_WIDTH,
      realHeight: CANVAS_REAL_HEIGHT,
    },
    elements,
  };
}
