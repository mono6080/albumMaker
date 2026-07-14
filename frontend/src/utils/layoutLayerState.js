import {
  getAncestorGroupIds,
  getFlattenedRenderElements,
  getGroupById,
} from "./layoutGroups.js";

const COLLECTION_BY_TYPE = {
  photo: "photo_slots",
  text: "text_labels",
  sticker: "stickers",
};

export function getLayoutNodeData(layout, ref) {
  if (!layout || !ref) return null;
  if (ref.type === "group") return getGroupById(layout, ref.id);
  const collectionKey = COLLECTION_BY_TYPE[ref.type];
  if (!collectionKey) return null;
  return (layout[collectionKey] || []).find(item => String(item.id) === String(ref.id)) ?? null;
}

export function getNodeLayerState(layout, ref) {
  const data = getLayoutNodeData(layout, ref);
  if (!data) return { data: null, isVisible: false, isLocked: false };
  const ancestorIds = getAncestorGroupIds(layout, ref);
  const ancestors = ancestorIds
    .map(groupId => getGroupById(layout, groupId))
    .filter(Boolean);
  const stateNodes = ref.type === "group" ? ancestors : [...ancestors, data];
  return {
    data,
    isVisible: stateNodes.every(node => node.visible !== false),
    isLocked: stateNodes.some(node => node.locked === true),
  };
}

export function updateLayoutNodeMetadata(layout, ref, updates) {
  if (!layout || !ref) return layout;
  const applyUpdates = item => {
    const nextItem = { ...item, ...updates };
    Object.entries(updates || {}).forEach(([key, value]) => {
      if (value === undefined) delete nextItem[key];
    });
    return nextItem;
  };
  if (ref.type === "group") {
    return {
      ...layout,
      groups: (layout.groups || []).map(group => (
        String(group.id) === String(ref.id) ? applyUpdates(group) : group
      )),
    };
  }
  const collectionKey = COLLECTION_BY_TYPE[ref.type];
  if (!collectionKey) return layout;
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).map(item => (
      String(item.id) === String(ref.id) ? applyUpdates(item) : item
    )),
  };
}

export function getVisibleLayoutElements(layout, type = null) {
  const visibleNodes = getFlattenedRenderElements(layout || {}, { visibleOnly: true });
  if (!type) return visibleNodes.map(node => node.data);
  const collectionKey = COLLECTION_BY_TYPE[type];
  if (!collectionKey) return [];
  const visibleIds = new Set(
    visibleNodes
      .filter(node => node.type === type)
      .map(node => String(node.id)),
  );
  // 照片／文字的序號沿用既有 collection 順序；圖層重排只影響繪製堆疊，不改欄位對應。
  return (layout?.[collectionKey] || []).filter(item => visibleIds.has(String(item.id)));
}

export function getVisibleLayoutElementOrdinals(layout, type) {
  return new Map(
    getVisibleLayoutElements(layout, type).map((item, index) => [String(item.id), index + 1]),
  );
}
