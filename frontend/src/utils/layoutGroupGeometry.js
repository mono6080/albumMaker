import {
  PHOTO_CONTENT_MIN_HEIGHT,
  PHOTO_CONTENT_MIN_WIDTH,
  getPhotoFrameInsets,
  getPhotoFrameRect,
  getPhotoSlotDimensionMode,
  isPhotoContentBoxMode,
} from "./photoFrameGeometry.js";

import {
  LayoutGroupError,
  NODE_TYPES,
  buildLayoutGraph,
} from "./layoutGroupContractGraph.js";
import {
  getDescendantLeafRefsFromGraph,
  getElementFromLayout,
  getGroupByIdFromGraph,
} from "./layoutGroupQueries.js";

export function roundGeometry(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

export function normalizeAngle(value) {
  return roundGeometry(((Number(value) + 180) % 360 + 360) % 360 - 180);
}

export function rotatePoint(point, center, degrees) {
  const radians = Number(degrees) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

export function getLeafFrameRect(layout, ref, element) {
  if (ref.type === "photo") {
    return getPhotoFrameRect(element, { dimensionMode: getPhotoSlotDimensionMode(layout) });
  }
  return {
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    width: Math.max(0, Number(element.width) || 0),
    height: Math.max(0, Number(element.height) || 0),
  };
}

function frameCorners(frame, rotation) {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ].map(point => rotatePoint(point, center, rotation));
}

function boundsForLeaf(layout, ref, element) {
  const frame = getLeafFrameRect(layout, ref, element);
  const rotation = normalizeAngle(Number(element.rotation) || 0);
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return {
    x: roundGeometry(frame.x),
    y: roundGeometry(frame.y),
    width: roundGeometry(frame.width),
    height: roundGeometry(frame.height),
    centerX: roundGeometry(centerX),
    centerY: roundGeometry(centerY),
    rotation,
    corners: frameCorners(frame, rotation).map(point => ({
      x: roundGeometry(point.x), y: roundGeometry(point.y),
    })),
  };
}

export function getNodeBoundsFromGraph(layout, graph, ref) {
  if (!ref || !NODE_TYPES.has(ref.type)) throw new LayoutGroupError("找不到物件");
  if (ref.type !== "group") {
    const element = getElementFromLayout(layout, ref);
    if (!element) throw new LayoutGroupError("找不到物件");
    return boundsForLeaf(layout, ref, element);
  }
  const group = getGroupByIdFromGraph(graph, ref.id);
  if (!group) throw new LayoutGroupError("找不到群組");
  const leafRefs = getDescendantLeafRefsFromGraph(graph, group.id);
  if (!leafRefs.length) throw new LayoutGroupError("群組沒有可計算的子物件");
  const rotation = normalizeAngle(group.selection_rotation ?? 0);
  const worldCorners = [];
  for (const leafRef of leafRefs) {
    const element = getElementFromLayout(layout, leafRef);
    worldCorners.push(...boundsForLeaf(layout, leafRef, element).corners);
  }
  const localCorners = worldCorners.map(point => rotatePoint(point, { x: 0, y: 0 }, -rotation));
  const minX = Math.min(...localCorners.map(point => point.x));
  const maxX = Math.max(...localCorners.map(point => point.x));
  const minY = Math.min(...localCorners.map(point => point.y));
  const maxY = Math.max(...localCorners.map(point => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const center = rotatePoint(localCenter, { x: 0, y: 0 }, rotation);
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ].map(point => rotatePoint(point, { x: 0, y: 0 }, rotation));
  return {
    x: roundGeometry(center.x - width / 2),
    y: roundGeometry(center.y - height / 2),
    width: roundGeometry(width),
    height: roundGeometry(height),
    centerX: roundGeometry(center.x),
    centerY: roundGeometry(center.y),
    rotation,
    corners: corners.map(point => ({ x: roundGeometry(point.x), y: roundGeometry(point.y) })),
  };
}

export function getNodeBounds(layout, ref) {
  return getNodeBoundsFromGraph(layout, buildLayoutGraph(layout || {}), ref);
}

export function getGroupBoundsFromGraph(layout, graph, groupOrId) {
  const id = typeof groupOrId === "object" && groupOrId ? groupOrId.id : groupOrId;
  return getNodeBoundsFromGraph(layout, graph, { type: "group", id });
}

export function getGroupBounds(layout, groupOrId) {
  return getGroupBoundsFromGraph(
    layout,
    buildLayoutGraph(layout || {}),
    groupOrId,
  );
}

export function applyVisibleFrame(layout, ref, element, frame) {
  if (ref.type !== "photo") {
    return {
      ...element,
      x: roundGeometry(frame.x),
      y: roundGeometry(frame.y),
      width: roundGeometry(frame.width),
      height: roundGeometry(frame.height),
    };
  }
  const mode = getPhotoSlotDimensionMode(layout);
  if (!isPhotoContentBoxMode({ dimensionMode: mode })) {
    return {
      ...element,
      x: roundGeometry(frame.x),
      y: roundGeometry(frame.y),
      width: roundGeometry(frame.width),
      height: roundGeometry(frame.height),
    };
  }
  const insets = getPhotoFrameInsets(element);
  return {
    ...element,
    x: roundGeometry(frame.x + insets.left),
    y: roundGeometry(frame.y + insets.top),
    width: roundGeometry(frame.width - insets.left - insets.right),
    height: roundGeometry(frame.height - insets.top - insets.bottom),
  };
}

export function assertPhotoScaleMinimum(element, nextFrame) {
  const insets = getPhotoFrameInsets(element);
  const contentWidth = nextFrame.width - insets.left - insets.right;
  const contentHeight = nextFrame.height - insets.top - insets.bottom;
  if (contentWidth < PHOTO_CONTENT_MIN_WIDTH || contentHeight < PHOTO_CONTENT_MIN_HEIGHT) {
    throw new LayoutGroupError("群組縮放會讓照片內容小於 60×40");
  }
}

function assertNormalizedBox(box) {
  const values = [box?.x, box?.y, box?.width, box?.height];
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new LayoutGroupError("圖片分析框必須是有限數值");
  }
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0
    || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) {
    throw new LayoutGroupError("圖片分析框超出素材範圍");
  }
}

export function projectNormalizedBoxToSticker(sticker, normalizedBox) {
  if (!sticker) throw new LayoutGroupError("找不到圖片素材");
  assertNormalizedBox(normalizedBox);
  const stickerX = Number(sticker.x) || 0;
  const stickerY = Number(sticker.y) || 0;
  const stickerWidth = Number(sticker.width) || 0;
  const stickerHeight = Number(sticker.height) || 0;
  if (stickerWidth <= 0 || stickerHeight <= 0) {
    throw new LayoutGroupError("圖片素材尺寸無效");
  }
  const stickerCenter = {
    x: stickerX + stickerWidth / 2,
    y: stickerY + stickerHeight / 2,
  };
  const localCenter = {
    x: stickerCenter.x + (normalizedBox.x + normalizedBox.width / 2 - 0.5) * stickerWidth,
    y: stickerCenter.y + (normalizedBox.y + normalizedBox.height / 2 - 0.5) * stickerHeight,
  };
  const worldCenter = rotatePoint(
    localCenter,
    stickerCenter,
    Number(sticker.rotation) || 0,
  );
  const width = normalizedBox.width * stickerWidth;
  const height = normalizedBox.height * stickerHeight;
  return {
    x: roundGeometry(worldCenter.x - width / 2),
    y: roundGeometry(worldCenter.y - height / 2),
    width: roundGeometry(width),
    height: roundGeometry(height),
    rotation: normalizeAngle(Number(sticker.rotation) || 0),
  };
}
