import { getNodeBounds, moveGroup } from "./layoutGroups.js";
import { getLayoutNodeData, getNodeLayerState } from "./layoutLayerState.js";

const COLLECTION_BY_TYPE = {
  photo: "photo_slots",
  text: "text_labels",
  sticker: "stickers",
};

function roundGeometry(value) {
  return Math.round(value * 10000) / 10000;
}

export function getAxisAlignedNodeBounds(layout, ref) {
  const bounds = getNodeBounds(layout, ref);
  const left = Math.min(...bounds.corners.map(point => point.x));
  const right = Math.max(...bounds.corners.map(point => point.x));
  const top = Math.min(...bounds.corners.map(point => point.y));
  const bottom = Math.max(...bounds.corners.map(point => point.y));
  return {
    ref,
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

function moveLeaf(layout, ref, dx, dy) {
  const collectionKey = COLLECTION_BY_TYPE[ref.type];
  if (!collectionKey) return layout;
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).map(item => (
      String(item.id) === String(ref.id)
        ? {
            ...item,
            x: roundGeometry((Number(item.x) || 0) + dx),
            y: roundGeometry((Number(item.y) || 0) + dy),
          }
        : item
    )),
  };
}

export function moveLayoutNode(layout, ref, { dx = 0, dy = 0 } = {}) {
  if (!dx && !dy) return layout;
  return ref.type === "group"
    ? moveGroup(layout, ref.id, { dx, dy })
    : moveLeaf(layout, ref, dx, dy);
}

function ensureMovableSelection(layout, refs, minimumCount) {
  if ((refs || []).length < minimumCount) return false;
  return refs.every(ref => {
    const state = getNodeLayerState(layout, ref);
    return state.data && state.isVisible && !state.isLocked;
  });
}

export function alignLayoutNodes(layout, refs, alignment) {
  if (!ensureMovableSelection(layout, refs, 2)) return layout;
  const items = refs.map(ref => getAxisAlignedNodeBounds(layout, ref));
  const selectionBounds = {
    left: Math.min(...items.map(item => item.left)),
    right: Math.max(...items.map(item => item.right)),
    top: Math.min(...items.map(item => item.top)),
    bottom: Math.max(...items.map(item => item.bottom)),
  };
  selectionBounds.centerX = (selectionBounds.left + selectionBounds.right) / 2;
  selectionBounds.centerY = (selectionBounds.top + selectionBounds.bottom) / 2;

  return items.reduce((nextLayout, item) => {
    let dx = 0;
    let dy = 0;
    if (alignment === "left") dx = selectionBounds.left - item.left;
    if (alignment === "center") dx = selectionBounds.centerX - item.centerX;
    if (alignment === "right") dx = selectionBounds.right - item.right;
    if (alignment === "top") dy = selectionBounds.top - item.top;
    if (alignment === "middle") dy = selectionBounds.centerY - item.centerY;
    if (alignment === "bottom") dy = selectionBounds.bottom - item.bottom;
    return moveLayoutNode(nextLayout, item.ref, { dx, dy });
  }, layout);
}

export function distributeLayoutNodes(layout, refs, axis) {
  if (!ensureMovableSelection(layout, refs, 3)) return layout;
  const isHorizontal = axis === "horizontal";
  const items = refs
    .map(ref => getAxisAlignedNodeBounds(layout, ref))
    .sort((left, right) => (
      isHorizontal ? left.centerX - right.centerX : left.centerY - right.centerY
    ));
  const first = items[0];
  const last = items[items.length - 1];
  const totalSize = items.reduce((sum, item) => sum + (isHorizontal ? item.width : item.height), 0);
  const span = isHorizontal ? last.right - first.left : last.bottom - first.top;
  const gap = (span - totalSize) / (items.length - 1);
  let cursor = isHorizontal ? first.left : first.top;

  return items.reduce((nextLayout, item, index) => {
    if (index === 0 || index === items.length - 1) {
      cursor += (isHorizontal ? item.width : item.height) + gap;
      return nextLayout;
    }
    const currentStart = isHorizontal ? item.left : item.top;
    const delta = cursor - currentStart;
    cursor += (isHorizontal ? item.width : item.height) + gap;
    return moveLayoutNode(nextLayout, item.ref, {
      dx: isHorizontal ? delta : 0,
      dy: isHorizontal ? 0 : delta,
    });
  }, layout);
}

export function canMatchSelectionSize(layout, refs) {
  if ((refs || []).length < 2) return false;
  const firstType = refs[0].type;
  if (firstType === "group" || !refs.every(ref => ref.type === firstType)) return false;
  if (!refs.every(ref => {
    const state = getNodeLayerState(layout, ref);
    return state.isVisible && !state.isLocked;
  })) return false;
  if (firstType !== "photo") return true;
  const first = getLayoutNodeData(layout, refs[0]);
  if (!first?.width || !first?.height) return false;
  const firstRatio = first.width / first.height;
  return refs.slice(1).every(ref => {
    const item = getLayoutNodeData(layout, ref);
    return item?.width > 0
      && item?.height > 0
      && Math.abs(item.width / item.height - firstRatio) < 0.01;
  });
}
