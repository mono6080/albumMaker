import {
  COLLECTION_BY_TYPE,
  ELEMENT_SPECS,
  LEAF_TYPES,
  MATERIAL_TEXT_LINK_KIND,
  NESTED_GROUP_CONTRACT,
  NODE_TYPES,
  LayoutGroupError,
  assertValidLayoutGroups,
  canonicalElementKey,
  canonicalId,
  cloneLayout,
  sameId,
  validateLayoutGroups,
} from "./layoutGroupContractGraph.js";
import {
  getDescendantGroupIds,
  getDescendantLeafRefs,
  getElementFromLayout,
  getGroupAncestorPath,
  getGroupById,
  getNodeParent,
  getScopeNodes,
} from "./layoutGroupQueries.js";
import {
  applyVisibleFrame,
  assertPhotoScaleMinimum,
  getGroupBounds,
  getLeafFrameRect,
  normalizeAngle,
  rotatePoint,
} from "./layoutGroupGeometry.js";

export function ensureNestedWorldV2(layout) {
  assertValidLayoutGroups(layout);
  if (layout.group_contract === NESTED_GROUP_CONTRACT) return layout;
  const materialTextLinks = [];
  const groups = (layout.groups || []).map(group => {
    if (Array.isArray(group.links)) {
      for (const link of group.links) materialTextLinks.push({ ...link });
    }
    const { links: _links, ...withoutLinks } = group;
    return withoutLinks;
  });
  const next = {
    ...cloneLayout(layout),
    group_contract: NESTED_GROUP_CONTRACT,
  };
  if (groups.length) next.groups = groups;
  else delete next.groups;
  if (materialTextLinks.length) next.material_text_links = materialTextLinks;
  else delete next.material_text_links;
  return next;
}

function finalizeLayoutMetadata(layout) {
  const next = layout;
  if (!Array.isArray(next.groups) || next.groups.length === 0) delete next.groups;
  if (!Array.isArray(next.material_text_links) || next.material_text_links.length === 0) {
    delete next.material_text_links;
  }
  if (!next.groups && !next.material_text_links) delete next.group_contract;
  else next.group_contract = NESTED_GROUP_CONTRACT;
  return next;
}

function setNodeZ(layout, ref, zIndex) {
  if (ref.type === "group") {
    return {
      ...layout,
      groups: (layout.groups || []).map(group => (
        sameId(group.id, ref.id) ? { ...group, z_index: zIndex } : group
      )),
    };
  }
  const collectionKey = COLLECTION_BY_TYPE[ref.type];
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).map(element => (
      sameId(element.id, ref.id) ? { ...element, z_index: zIndex } : element
    )),
  };
}

function assignRootOrder(layout, refs) {
  return refs.reduce((next, ref, index) => setNodeZ(next, ref, index), layout);
}

export function normalizeRootZIndices(layout) {
  assertValidLayoutGroups(layout);
  return assignRootOrder(cloneLayout(layout), getScopeNodes(layout, null));
}

function updateGroup(layout, groupId, updater) {
  let found = false;
  const groups = (layout.groups || []).map(group => {
    if (!sameId(group.id, groupId)) return group;
    found = true;
    return updater(group);
  });
  if (!found) throw new LayoutGroupError("找不到群組");
  return { ...layout, groups };
}

function replaceScope(layout, parentGroupId, refs) {
  if (parentGroupId == null) return assignRootOrder(layout, refs);
  return updateGroup(layout, parentGroupId, group => ({
    ...group,
    children: refs.map(ref => ({ type: ref.type, id: ref.id })),
  }));
}

function ensureUniqueGroupId(layout, groupId) {
  canonicalId(groupId);
  if ((layout.groups || []).some(group => sameId(group.id, groupId))) {
    throw new LayoutGroupError("群組 ID 已存在");
  }
}

function sameRef(left, right) {
  return canonicalElementKey(left.type, left.id) === canonicalElementKey(right.type, right.id);
}

export function groupElements(layout, refs, { groupId, parentGroupId = null } = {}) {
  assertValidLayoutGroups(layout);
  if (!Array.isArray(refs) || refs.length < 2) {
    throw new LayoutGroupError("至少選取兩個物件才能群組");
  }
  if (groupId == null) throw new LayoutGroupError("建立群組時必須提供 groupId");
  const upgraded = ensureNestedWorldV2(layout);
  ensureUniqueGroupId(upgraded, groupId);
  const keys = refs.map(ref => canonicalElementKey(ref.type, ref.id));
  if (new Set(keys).size !== keys.length) throw new LayoutGroupError("群組選取包含重複物件");
  const scope = getScopeNodes(upgraded, parentGroupId);
  if (parentGroupId != null && !getGroupById(upgraded, parentGroupId)) {
    throw new LayoutGroupError("找不到目前群組 scope");
  }
  const indexByKey = new Map(scope.map((ref, index) => [canonicalElementKey(ref.type, ref.id), index]));
  const indices = keys.map(key => indexByKey.get(key));
  if (indices.some(index => index == null)) {
    throw new LayoutGroupError("群組選取必須是同一 scope 的 direct nodes");
  }
  const sortedIndices = [...indices].sort((left, right) => left - right);
  const orderedRefs = sortedIndices.map(index => ({ ...scope[index] }));
  const selected = new Set(keys);
  const topmostIndex = sortedIndices[sortedIndices.length - 1];
  const remaining = scope.filter(ref => !selected.has(canonicalElementKey(ref.type, ref.id)));
  const insertIndex = scope
    .slice(0, topmostIndex)
    .filter(ref => !selected.has(canonicalElementKey(ref.type, ref.id)))
    .length;
  const newRef = { type: "group", id: groupId };
  remaining.splice(insertIndex, 0, newRef);
  let next = cloneLayout(upgraded);
  next.groups = [
    ...(next.groups || []),
    {
      id: groupId,
      z_index: parentGroupId == null ? topmostIndex : 0,
      selection_rotation: 0,
      children: orderedRefs,
    },
  ];
  next = replaceScope(next, parentGroupId, remaining);
  if (parentGroupId != null) {
    const collapsed = collapseInvalidGroups(
      next,
      parentGroupId,
      getScopeNodes(upgraded, null),
    );
    next = collapsed.layout;
    if (!rawGroup(next, parentGroupId)) {
      next = assignRootOrder(next, collapsed.rootOrder);
    }
  }
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function ungroupElements(layout, groupId) {
  assertValidLayoutGroups(layout);
  const upgraded = ensureNestedWorldV2(layout);
  const group = getGroupById(upgraded, groupId);
  if (!group) throw new LayoutGroupError("找不到要解除的群組");
  const parent = getNodeParent(upgraded, { type: "group", id: group.id });
  const parentId = parent?.id ?? null;
  const scope = getScopeNodes(upgraded, parentId);
  const groupIndex = scope.findIndex(ref => ref.type === "group" && sameId(ref.id, group.id));
  if (groupIndex < 0) throw new LayoutGroupError("群組不在預期的 scope");
  const desired = scope.map(ref => ({ ...ref }));
  desired.splice(groupIndex, 1, ...group.children.map(ref => ({ ...ref })));
  let next = cloneLayout(upgraded);
  next.groups = next.groups.filter(item => !sameId(item.id, group.id));
  next = replaceScope(next, parentId, desired);
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function reorderNode(layout, ref, { parentGroupId = null, toIndex } = {}) {
  assertValidLayoutGroups(layout);
  const upgraded = ensureNestedWorldV2(layout);
  const scope = getScopeNodes(upgraded, parentGroupId);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= scope.length) {
    throw new LayoutGroupError("目標圖層位置無效");
  }
  const currentIndex = scope.findIndex(item => sameRef(item, ref));
  if (currentIndex < 0) throw new LayoutGroupError("物件不在指定 scope");
  const desired = scope.map(item => ({ ...item }));
  const [target] = desired.splice(currentIndex, 1);
  desired.splice(toIndex, 0, target);
  const next = replaceScope(cloneLayout(upgraded), parentGroupId, desired);
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function reorderRootNode(layout, target, toIndex) {
  return reorderNode(layout, target, { parentGroupId: null, toIndex });
}

export function reorderGroupChild(layout, groupId, ref, toIndex) {
  return reorderNode(layout, ref, { parentGroupId: groupId, toIndex });
}

function nodeExists(layout, ref) {
  if (!ref || !NODE_TYPES.has(ref.type)) return false;
  return ref.type === "group" ? !!getGroupById(layout, ref.id) : !!getElementFromLayout(layout, ref);
}

export function insertNodeInScope(layout, ref, { parentGroupId = null, afterRef = null } = {}) {
  assertValidLayoutGroups(layout);
  const upgraded = ensureNestedWorldV2(layout);
  if (!nodeExists(upgraded, ref)) throw new LayoutGroupError("插入 scope 的物件不存在");
  const currentParent = getNodeParent(upgraded, ref);
  if (currentParent && !sameId(currentParent.id, parentGroupId)) {
    throw new LayoutGroupError("不可從其他 group scope 直接搬移物件");
  }
  if (parentGroupId == null && currentParent) {
    throw new LayoutGroupError("不可從 group scope 直接搬到 root");
  }
  if (parentGroupId != null && !getGroupById(upgraded, parentGroupId)) {
    throw new LayoutGroupError("找不到目標群組");
  }
  if (ref.type === "group" && parentGroupId != null) {
    const targetPath = getGroupAncestorPath(upgraded, parentGroupId);
    if (targetPath.some(id => sameId(id, ref.id))) throw new LayoutGroupError("群組不可移入自己的 descendant");
  }

  const targetScope = getScopeNodes(upgraded, parentGroupId);
  const existingIndex = targetScope.findIndex(item => sameRef(item, ref));
  const desired = targetScope.filter(item => !sameRef(item, ref)).map(item => ({ ...item }));
  let insertIndex = desired.length;
  if (afterRef) {
    const afterIndex = desired.findIndex(item => sameRef(item, afterRef));
    if (afterIndex < 0) throw new LayoutGroupError("指定的插入位置不存在");
    insertIndex = afterIndex + 1;
  } else if (existingIndex >= 0) {
    insertIndex = Math.min(existingIndex, desired.length);
  }
  desired.splice(insertIndex, 0, { type: ref.type, id: ref.id });

  let next = cloneLayout(upgraded);
  next = replaceScope(next, parentGroupId, desired);
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function addElementToGroup(layout, groupId, ref, { afterRef = null } = {}) {
  return insertNodeInScope(layout, ref, { parentGroupId: groupId, afterRef });
}

export function linkMaterialText(layout, { materialId, textId } = {}) {
  assertValidLayoutGroups(layout);
  const upgraded = ensureNestedWorldV2(layout);
  if (!getElementFromLayout(upgraded, { type: "sticker", id: materialId })
    || !getElementFromLayout(upgraded, { type: "text", id: textId })) {
    throw new LayoutGroupError("連結的圖片或文字框不存在");
  }
  const links = upgraded.material_text_links || [];
  const exact = links.find(link => (
    link.kind === MATERIAL_TEXT_LINK_KIND
    && sameId(link.material_id, materialId)
    && sameId(link.text_id, textId)
  ));
  if (exact) return upgraded;
  if (links.some(link => sameId(link.material_id, materialId))) {
    throw new LayoutGroupError("這張圖片已連結其他文字框");
  }
  if (links.some(link => sameId(link.text_id, textId))) {
    throw new LayoutGroupError("這個文字框已連結其他圖片");
  }
  const next = cloneLayout(upgraded);
  next.material_text_links = [
    ...(next.material_text_links || []),
    { kind: MATERIAL_TEXT_LINK_KIND, material_id: materialId, text_id: textId },
  ];
  next.group_contract = NESTED_GROUP_CONTRACT;
  assertValidLayoutGroups(next);
  return next;
}

export function unlinkMaterialText(layout, { materialId, textId } = {}) {
  const validation = validateLayoutGroups(layout);
  if (!validation.topologyValid) {
    throw new LayoutGroupError("群組資料格式不正確", validation.topologyErrors);
  }
  const repaired = validation.linkValid ? layout : removeInvalidMaterialTextLinks(layout);
  const upgraded = ensureNestedWorldV2(repaired);
  const next = cloneLayout(upgraded);
  next.material_text_links = (next.material_text_links || []).filter(link => !(
    link.kind === MATERIAL_TEXT_LINK_KIND
    && sameId(link.material_id, materialId)
    && sameId(link.text_id, textId)
  ));
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function removeInvalidMaterialTextLinks(layout) {
  const validation = validateLayoutGroups(layout);
  if (!validation.topologyValid) {
    throw new LayoutGroupError("群組資料格式不正確", validation.topologyErrors);
  }
  if (validation.linkValid) return layout;
  if (layout?.group_contract !== NESTED_GROUP_CONTRACT) {
    throw new LayoutGroupError("只有 v2 layout-level links 可自動修復", validation.linkErrors);
  }
  const next = cloneLayout(layout);
  const materials = new Set();
  const texts = new Set();
  const validLinks = [];
  const rawLinks = Array.isArray(next.material_text_links) ? next.material_text_links : [];
  for (const link of rawLinks) {
    if (!link || typeof link !== "object" || Array.isArray(link)
      || link.kind !== MATERIAL_TEXT_LINK_KIND) continue;
    let materialKey;
    let textKey;
    try {
      materialKey = canonicalId(link.material_id);
      textKey = canonicalId(link.text_id);
    } catch {
      continue;
    }
    if (materials.has(materialKey) || texts.has(textKey)) continue;
    if (!getElementFromLayout(next, { type: "sticker", id: link.material_id })
      || !getElementFromLayout(next, { type: "text", id: link.text_id })) continue;
    materials.add(materialKey);
    texts.add(textKey);
    validLinks.push({ ...link });
  }
  next.material_text_links = validLinks;
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

function removeLeafRecord(layout, ref) {
  const collectionKey = COLLECTION_BY_TYPE[ref.type];
  if (!collectionKey) throw new LayoutGroupError("不支援的 leaf 類型");
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).filter(element => !sameId(element.id, ref.id)),
  };
}

function rawGroup(layout, groupId) {
  return (layout.groups || []).find(group => sameId(group.id, groupId)) || null;
}

function rawParentId(layout, ref) {
  const parent = (layout.groups || []).find(group => (
    (group.children || []).some(child => sameRef(child, ref))
  ));
  return parent?.id ?? null;
}

function replaceChildRef(layout, parentId, targetRef, replacement) {
  return updateGroup(layout, parentId, group => {
    const children = group.children.map(child => ({ ...child }));
    const index = children.findIndex(child => sameRef(child, targetRef));
    if (index < 0) throw new LayoutGroupError("找不到 parent scope child");
    children.splice(index, 1, ...(replacement ? [{ ...replacement }] : []));
    return { ...group, children };
  });
}

function replaceRootRef(rootOrder, targetRef, replacement) {
  const next = rootOrder.map(ref => ({ ...ref }));
  const index = next.findIndex(ref => sameRef(ref, targetRef));
  if (index >= 0) next.splice(index, 1, ...(replacement ? [{ ...replacement }] : []));
  return next;
}

function collapseInvalidGroups(layout, startGroupId, rootOrder) {
  let next = layout;
  let roots = rootOrder;
  let currentId = startGroupId;
  const visited = new Set();
  while (currentId != null) {
    const currentKey = canonicalId(currentId);
    if (visited.has(currentKey)) throw new LayoutGroupError("群組 collapse 偵測到 cycle");
    visited.add(currentKey);
    const group = rawGroup(next, currentId);
    if (!group || group.children.length >= 2) break;
    const parentId = rawParentId(next, { type: "group", id: currentId });
    const replacement = group.children.length === 1 ? { ...group.children[0] } : null;
    if (parentId == null) {
      roots = replaceRootRef(roots, { type: "group", id: currentId }, replacement);
    } else {
      next = replaceChildRef(next, parentId, { type: "group", id: currentId }, replacement);
    }
    next = {
      ...next,
      groups: (next.groups || []).filter(item => !sameId(item.id, currentId)),
    };
    currentId = parentId;
  }
  return { layout: next, rootOrder: roots };
}

function cleanMaterialTextLinks(layout) {
  const next = layout;
  next.material_text_links = (next.material_text_links || []).filter(link => (
    !!getElementFromLayout(next, { type: "sticker", id: link.material_id })
    && !!getElementFromLayout(next, { type: "text", id: link.text_id })
  ));
  return next;
}

export function deleteLayoutElement(layout, ref) {
  assertValidLayoutGroups(layout);
  if (ref?.type === "group") return deleteLayoutGroup(layout, ref.id);
  const upgraded = ensureNestedWorldV2(layout);
  if (!ref || !LEAF_TYPES.has(ref.type) || !getElementFromLayout(upgraded, ref)) {
    throw new LayoutGroupError("找不到要刪除的物件");
  }
  let roots = getScopeNodes(upgraded, null);
  let next = cloneLayout(upgraded);
  const parent = getNodeParent(upgraded, ref);
  if (parent) {
    next = updateGroup(next, parent.id, group => ({
      ...group,
      children: group.children.filter(child => !sameRef(child, ref)),
    }));
  } else {
    roots = roots.filter(item => !sameRef(item, ref));
  }
  next = removeLeafRecord(next, ref);
  if (parent) {
    const collapsed = collapseInvalidGroups(next, parent.id, roots);
    next = collapsed.layout;
    roots = collapsed.rootOrder;
  }
  cleanMaterialTextLinks(next);
  next = assignRootOrder(next, roots);
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function deleteLayoutGroup(layout, groupId) {
  assertValidLayoutGroups(layout);
  const upgraded = ensureNestedWorldV2(layout);
  const group = getGroupById(upgraded, groupId);
  if (!group) throw new LayoutGroupError("找不到要刪除的群組");
  const leafRefs = getDescendantLeafRefs(upgraded, group.id);
  const groupIds = new Set(getDescendantGroupIds(upgraded, group.id).map(canonicalId));
  let roots = getScopeNodes(upgraded, null);
  let next = cloneLayout(upgraded);
  const parent = getNodeParent(upgraded, { type: "group", id: group.id });
  if (parent) {
    next = updateGroup(next, parent.id, item => ({
      ...item,
      children: item.children.filter(child => !(
        child.type === "group" && sameId(child.id, group.id)
      )),
    }));
  } else {
    roots = roots.filter(ref => !(ref.type === "group" && sameId(ref.id, group.id)));
  }
  for (const leafRef of leafRefs) next = removeLeafRecord(next, leafRef);
  next.groups = (next.groups || []).filter(item => !groupIds.has(canonicalId(item.id)));
  if (parent) {
    const collapsed = collapseInvalidGroups(next, parent.id, roots);
    next = collapsed.layout;
    roots = collapsed.rootOrder;
  }
  cleanMaterialTextLinks(next);
  next = assignRootOrder(next, roots);
  finalizeLayoutMetadata(next);
  assertValidLayoutGroups(next);
  return next;
}

export function transformGroup(
  layout,
  groupId,
  { dx = 0, dy = 0, rotationDelta = 0, scale = 1 } = {},
) {
  assertValidLayoutGroups(layout);
  if (![dx, dy, rotationDelta, scale].every(Number.isFinite)) {
    throw new LayoutGroupError("群組 transform 必須是有限數值");
  }
  if (scale <= 0) throw new LayoutGroupError("群組縮放比例必須大於 0");
  if (dx === 0 && dy === 0 && rotationDelta === 0 && scale === 1) return layout;
  const source = ensureNestedWorldV2(layout);
  const group = getGroupById(source, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  const bounds = getGroupBounds(source, group.id);
  const pivot = { x: bounds.centerX, y: bounds.centerY };
  const leafRefs = getDescendantLeafRefs(source, group.id);
  const updates = new Map();

  for (const ref of leafRefs) {
    const element = getElementFromLayout(source, ref);
    const frame = getLeafFrameRect(source, ref, element);
    const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    const scaledCenter = {
      x: pivot.x + (center.x - pivot.x) * scale,
      y: pivot.y + (center.y - pivot.y) * scale,
    };
    const rotatedCenter = rotatePoint(scaledCenter, pivot, rotationDelta);
    const nextFrame = {
      x: rotatedCenter.x + dx - frame.width * scale / 2,
      y: rotatedCenter.y + dy - frame.height * scale / 2,
      width: frame.width * scale,
      height: frame.height * scale,
    };
    if (ref.type === "photo" && scale !== 1) assertPhotoScaleMinimum(element, nextFrame);
    let nextElement = applyVisibleFrame(source, ref, element, nextFrame);
    if (scale === 1) {
      nextElement = { ...nextElement, width: element.width, height: element.height };
    }
    if (rotationDelta !== 0) {
      nextElement.rotation = normalizeAngle((Number(element.rotation) || 0) + rotationDelta);
    }
    updates.set(canonicalElementKey(ref.type, ref.id), nextElement);
  }

  let next = cloneLayout(source);
  for (const [collectionKey, type] of ELEMENT_SPECS) {
    if (!Array.isArray(next[collectionKey])) continue;
    next[collectionKey] = (next[collectionKey] || []).map(element => (
      updates.get(canonicalElementKey(type, element.id)) || element
    ));
  }
  if (rotationDelta !== 0) {
    const descendantGroups = new Set(getDescendantGroupIds(source, group.id).map(canonicalId));
    next.groups = next.groups.map(item => (
      descendantGroups.has(canonicalId(item.id))
        ? {
          ...item,
          selection_rotation: normalizeAngle(
            (Number(item.selection_rotation) || 0) + rotationDelta,
          ),
        }
        : item
    ));
  }
  assertValidLayoutGroups(next);
  return next;
}

export function moveGroup(layout, groupId, { dx = 0, dy = 0 } = {}) {
  return transformGroup(layout, groupId, { dx, dy });
}

export function rotateGroup(layout, groupId, deltaDegrees) {
  return transformGroup(layout, groupId, { rotationDelta: deltaDegrees });
}

export function scaleGroupUniform(layout, groupId, scale) {
  return transformGroup(layout, groupId, { scale });
}
