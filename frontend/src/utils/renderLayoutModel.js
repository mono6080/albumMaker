export const CANVAS_REAL_WIDTH = 794;
export const CANVAS_REAL_HEIGHT = 1123;
export const CANVAS_DISPLAY_WIDTH = 530;
export const CANVAS_SCALE = CANVAS_DISPLAY_WIDTH / CANVAS_REAL_WIDTH;
export const CANVAS_DISPLAY_HEIGHT = Math.round(CANVAS_REAL_HEIGHT * CANVAS_SCALE);

const Z_BASE = { photo: 0, bubble: 100, text: 200, sticker: 300 };

export function toDisplayCoord(realValue) {
  return realValue * CANVAS_SCALE;
}

export function toRealCoord(displayValue) {
  return Math.round(displayValue / CANVAS_SCALE);
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
  const keyMap = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };
  const newLayout = { ...layout };
  for (const { type, data } of sortedElements) {
    const key = keyMap[type];
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

export function getPhotoSlotModel(data, elemIndex, pageIndex = 0) {
  const box = getDisplayBox(data);
  const hasBorder = data.border !== false;
  const borderWidth = toDisplayCoord(data.border_width ?? 8);
  return {
    type: "photo",
    id: data.id,
    box,
    outerFill: hasBorder ? "#ffffff" : "#EEEEEE",
    innerFill: "#EEEEEE",
    innerBox: hasBorder
      ? {
          x: box.x + borderWidth,
          y: box.y + borderWidth,
          width: Math.max(1, box.width - borderWidth * 2),
          height: Math.max(1, box.height - borderWidth * 3),
        }
      : box,
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
  const elements = getAllElementsSorted(layout).map(({ type, data, index }) => {
    if (type === "photo") return getPhotoSlotModel(data, index, pageIndex);
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
