export const GROUP_CONTRACT = "flat-world-v1";
export const MATERIAL_TEXT_LINK_KIND = "material-text-v1";

const ELEMENT_SPECS = [
  ["photo_slots", "photo", 0, 0],
  ["text_bubbles", "bubble", 100, 1],
  ["text_labels", "text", 200, 2],
  ["stickers", "sticker", 300, 3],
];
const GROUPABLE_KEYS = { text: "text_labels", sticker: "stickers" };
const FORBIDDEN_GROUP_GEOMETRY = new Set([
  "x", "y", "width", "height", "rotation", "bounds", "scale", "matrix", "transform",
]);

export class LayoutGroupError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "LayoutGroupError";
    this.code = "invalid_layout_group";
    this.errors = errors;
  }
}

function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

function canonicalId(id) {
  if (typeof id === "number" && Number.isInteger(id) && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim()) return id;
  throw new LayoutGroupError("元素 ID 必須是非空字串或整數");
}

export function canonicalElementKey(type, id) {
  return `${type}:${canonicalId(id)}`;
}

function sameId(left, right) {
  try {
    return canonicalId(left) === canonicalId(right);
  } catch {
    return false;
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isGroupableType(type) {
  return Object.hasOwn(GROUPABLE_KEYS, type);
}

function validationError(path, message, details = {}) {
  return {
    path,
    group_id: details.group_id ?? null,
    child_type: details.child_type ?? null,
    child_id: details.child_id ?? null,
    message,
  };
}

export function validateLayoutGroups(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    return { valid: false, errors: [validationError("$", "layout must be an object")] };
  }
  if (layout.groups == null) return { valid: true, errors: [] };
  if (!Array.isArray(layout.groups)) {
    return { valid: false, errors: [validationError("groups", "groups must be an array")] };
  }
  if (layout.groups.length === 0) return { valid: true, errors: [] };

  const errors = [];
  if (layout.group_contract !== GROUP_CONTRACT) {
    errors.push(validationError("group_contract", `group_contract must be ${GROUP_CONTRACT}`));
  }

  const elementMaps = { text: new Map(), sticker: new Map() };
  for (const [type, collectionKey] of Object.entries(GROUPABLE_KEYS)) {
    const collection = layout[collectionKey];
    if (!Array.isArray(collection)) {
      errors.push(validationError(collectionKey, "collection must be an array"));
      continue;
    }
    collection.forEach((element, index) => {
      const path = `${collectionKey}[${index}]`;
      if (!element || typeof element !== "object" || Array.isArray(element)) {
        errors.push(validationError(path, "element must be an object", { child_type: type }));
        return;
      }
      let id;
      try {
        id = canonicalId(element.id);
      } catch (error) {
        errors.push(validationError(`${path}.id`, error.message, { child_type: type, child_id: element.id }));
        return;
      }
      if (elementMaps[type].has(id)) {
        errors.push(validationError(`${path}.id`, "element ID collides after string normalization", {
          child_type: type,
          child_id: element.id,
        }));
        return;
      }
      elementMaps[type].set(id, element);
    });
  }

  const groupIds = new Set();
  const memberships = new Set();
  layout.groups.forEach((group, groupIndex) => {
    const groupPath = `groups[${groupIndex}]`;
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      errors.push(validationError(groupPath, "group must be an object"));
      return;
    }
    let groupId = null;
    try {
      groupId = canonicalId(group.id);
      if (groupIds.has(groupId)) {
        errors.push(validationError(`${groupPath}.id`, "group ID collides after string normalization", { group_id: group.id }));
      }
      groupIds.add(groupId);
    } catch (error) {
      errors.push(validationError(`${groupPath}.id`, error.message, { group_id: group.id }));
    }
    for (const key of Object.keys(group)) {
      if (FORBIDDEN_GROUP_GEOMETRY.has(key)) {
        errors.push(validationError(`${groupPath}.${key}`, "group geometry must be derived from children", { group_id: group.id }));
      }
    }
    if (!isFiniteNumber(group.z_index)) {
      errors.push(validationError(`${groupPath}.z_index`, "z_index must be a finite number", { group_id: group.id }));
    }
    if (!isFiniteNumber(group.selection_rotation)) {
      errors.push(validationError(`${groupPath}.selection_rotation`, "selection_rotation must be a finite number", { group_id: group.id }));
    }

    const children = Array.isArray(group.children) ? group.children : [];
    if (!Array.isArray(group.children)) {
      errors.push(validationError(`${groupPath}.children`, "children must be an array", { group_id: group.id }));
    } else if (children.length < 2) {
      errors.push(validationError(`${groupPath}.children`, "group must contain at least two children", { group_id: group.id }));
    }
    const localMemberships = new Set();
    const childIds = { text: new Set(), sticker: new Set() };
    children.forEach((child, childIndex) => {
      const childPath = `${groupPath}.children[${childIndex}]`;
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        errors.push(validationError(childPath, "child ref must be an object", { group_id: group.id }));
        return;
      }
      const type = child.type;
      if (!isGroupableType(type)) {
        errors.push(validationError(`${childPath}.type`, "child type must be 'text' or 'sticker'", {
          group_id: group.id, child_type: type, child_id: child.id,
        }));
        return;
      }
      let id;
      try {
        id = canonicalId(child.id);
      } catch (error) {
        errors.push(validationError(`${childPath}.id`, error.message, {
          group_id: group.id, child_type: type, child_id: child.id,
        }));
        return;
      }
      const key = `${type}:${id}`;
      if (localMemberships.has(key)) {
        errors.push(validationError(childPath, "duplicate child ref in group", {
          group_id: group.id, child_type: type, child_id: child.id,
        }));
        return;
      }
      localMemberships.add(key);
      childIds[type].add(id);
      if (!elementMaps[type].has(id)) {
        errors.push(validationError(childPath, "child ref does not exist", {
          group_id: group.id, child_type: type, child_id: child.id,
        }));
      }
      if (memberships.has(key)) {
        errors.push(validationError(childPath, "child already belongs to another group", {
          group_id: group.id, child_type: type, child_id: child.id,
        }));
      }
      memberships.add(key);
    });

    const links = group.links == null ? [] : group.links;
    if (!Array.isArray(links)) {
      errors.push(validationError(`${groupPath}.links`, "links must be an array", { group_id: group.id }));
      return;
    }
    const linkedMaterials = new Set();
    const linkedTexts = new Set();
    links.forEach((link, linkIndex) => {
      const path = `${groupPath}.links[${linkIndex}]`;
      if (!link || typeof link !== "object" || Array.isArray(link)) {
        errors.push(validationError(path, "link must be an object", { group_id: group.id }));
        return;
      }
      if (link.kind !== MATERIAL_TEXT_LINK_KIND) {
        errors.push(validationError(`${path}.kind`, `link kind must be '${MATERIAL_TEXT_LINK_KIND}'`, { group_id: group.id }));
      }
      for (const [field, type, seen] of [
        ["material_id", "sticker", linkedMaterials],
        ["text_id", "text", linkedTexts],
      ]) {
        let id;
        try {
          id = canonicalId(link[field]);
        } catch (error) {
          errors.push(validationError(`${path}.${field}`, error.message, {
            group_id: group.id, child_type: type, child_id: link[field],
          }));
          continue;
        }
        if (!childIds[type].has(id)) {
          errors.push(validationError(`${path}.${field}`, "link endpoint must reference a child in the same group", {
            group_id: group.id, child_type: type, child_id: link[field],
          }));
        }
        if (seen.has(id)) {
          errors.push(validationError(`${path}.${field}`, "link endpoint is already linked", {
            group_id: group.id, child_type: type, child_id: link[field],
          }));
        }
        seen.add(id);
      }
    });
  });
  return { valid: errors.length === 0, errors };
}

export function assertValidLayoutGroups(layout) {
  const result = validateLayoutGroups(layout);
  if (!result.valid) throw new LayoutGroupError("群組資料格式不正確", result.errors);
  return layout;
}

function effectiveZ(value, fallback) {
  return isFiniteNumber(value) ? value : fallback;
}

function legacyElementNodes(layout) {
  const nodes = [];
  ELEMENT_SPECS.forEach(([collectionKey, type, base, typeRank]) => {
    const collection = Array.isArray(layout?.[collectionKey]) ? layout[collectionKey] : [];
    collection.forEach((data, index) => {
      if (!data || typeof data !== "object") return;
      const zIndex = effectiveZ(data.z_index, base + index);
      nodes.push({
        kind: "element", type, id: data.id, data, index, zIndex,
        zDefault: base + index,
        groupId: null,
        _sort: [zIndex, typeRank, index],
      });
    });
  });
  return nodes.sort(compareSortTuple);
}

function compareSortTuple(left, right) {
  for (let index = 0; index < left._sort.length; index += 1) {
    if (left._sort[index] !== right._sort[index]) return left._sort[index] - right._sort[index];
  }
  return 0;
}

export function buildRootRenderNodes(layout, { onWarning } = {}) {
  const legacyNodes = legacyElementNodes(layout);
  if (!Array.isArray(layout?.groups) || layout.groups.length === 0) return legacyNodes;
  const validation = validateLayoutGroups(layout);
  if (!validation.valid) {
    onWarning?.(validation.errors);
    return legacyNodes;
  }

  const elementsByKey = new Map(
    legacyNodes
      .filter(node => isGroupableType(node.type))
      .map(node => [canonicalElementKey(node.type, node.id), node]),
  );
  const groupedKeys = new Set();
  const groupNodes = layout.groups.map((group, index) => {
    const children = group.children.map(ref => {
      const key = canonicalElementKey(ref.type, ref.id);
      groupedKeys.add(key);
      return { ...elementsByKey.get(key), groupId: group.id };
    });
    const zIndex = effectiveZ(group.z_index, index);
    return {
      kind: "group", type: "group", id: group.id, data: group, index, zIndex,
      children, _sort: [zIndex, 4, index],
    };
  });
  return [
    ...legacyNodes.filter(node => !isGroupableType(node.type) || !groupedKeys.has(canonicalElementKey(node.type, node.id))),
    ...groupNodes,
  ].sort(compareSortTuple);
}

export function flattenRenderNodes(nodes) {
  return nodes.flatMap(node => node.kind === "group" ? node.children : [node]);
}

export function getFlattenedRenderElements(layout, options) {
  return flattenRenderNodes(buildRootRenderNodes(layout, options));
}

function getValidatedGroups(layout) {
  if (!Array.isArray(layout?.groups) || layout.groups.length === 0) return [];
  return validateLayoutGroups(layout).valid ? layout.groups : [];
}

export function getGroupById(layout, id) {
  return getValidatedGroups(layout).find(group => sameId(group.id, id)) || null;
}

export function getGroupForElement(layout, ref) {
  if (!ref || !isGroupableType(ref.type)) return null;
  const key = canonicalElementKey(ref.type, ref.id);
  return getValidatedGroups(layout).find(group => (
    (group.children || []).some(child => canonicalElementKey(child.type, child.id) === key)
  )) || null;
}

function roundGeometry(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function normalizeAngle(value) {
  const normalized = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return roundGeometry(normalized);
}

function rotatePoint(point, center, degrees) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

function getElementFromLayout(layout, ref) {
  const collectionKey = isGroupableType(ref.type) ? GROUPABLE_KEYS[ref.type] : null;
  if (!collectionKey) return null;
  return (layout?.[collectionKey] || []).find(element => sameId(element.id, ref.id)) || null;
}

function elementCorners(element) {
  const x = Number(element.x) || 0;
  const y = Number(element.y) || 0;
  const width = Math.max(0, Number(element.width) || 0);
  const height = Math.max(0, Number(element.height) || 0);
  const center = { x: x + width / 2, y: y + height / 2 };
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map(point => rotatePoint(point, center, Number(element.rotation) || 0));
}

export function getGroupBounds(layout, groupOrId) {
  const requestedId = typeof groupOrId === "object" && groupOrId ? groupOrId.id : groupOrId;
  const group = getGroupById(layout, requestedId);
  if (!group) throw new LayoutGroupError("找不到群組");
  const children = group.children.map(ref => getElementFromLayout(layout, ref));
  if (children.some(child => !child)) throw new LayoutGroupError("群組包含不存在的子物件");
  const rotation = normalizeAngle(group.selection_rotation ?? 0);
  const worldCorners = children.flatMap(elementCorners);
  const inverseCorners = worldCorners.map(point => rotatePoint(point, { x: 0, y: 0 }, -rotation));
  const minX = Math.min(...inverseCorners.map(point => point.x));
  const maxX = Math.max(...inverseCorners.map(point => point.x));
  const minY = Math.min(...inverseCorners.map(point => point.y));
  const maxY = Math.max(...inverseCorners.map(point => point.y));
  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const center = rotatePoint(localCenter, { x: 0, y: 0 }, rotation);
  const width = maxX - minX;
  const height = maxY - minY;
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

function updateElement(layout, ref, updater) {
  const collectionKey = isGroupableType(ref.type) ? GROUPABLE_KEYS[ref.type] : null;
  if (!collectionKey) throw new LayoutGroupError("只有文字與貼圖可作為群組 child");
  let found = false;
  const collection = (layout[collectionKey] || []).map(element => {
    if (!sameId(element.id, ref.id)) return element;
    found = true;
    return updater(element);
  });
  if (!found) throw new LayoutGroupError(`找不到 ${ref.type} ${ref.id}`);
  return { ...layout, [collectionKey]: collection };
}

function setRootNodeZ(layout, node, zIndex) {
  if (node.kind === "group") {
    return {
      ...layout,
      groups: (layout.groups || []).map(group => (
        sameId(group.id, node.id) ? { ...group, z_index: zIndex } : group
      )),
    };
  }
  const collectionKey = ELEMENT_SPECS.find(([, type]) => type === node.type)?.[0];
  if (!collectionKey) return layout;
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).map(element => (
      sameId(element.id, node.id) ? { ...element, z_index: zIndex } : element
    )),
  };
}

export function normalizeRootZIndices(layout) {
  assertValidLayoutGroups(layout);
  return buildRootRenderNodes(layout).reduce(
    (nextLayout, node, index) => setRootNodeZ(nextLayout, node, index),
    cloneLayout(layout),
  );
}

function ensureUniqueGroupId(layout, groupId) {
  const normalized = canonicalId(groupId);
  if ((layout.groups || []).some(group => sameId(group.id, normalized))) {
    throw new LayoutGroupError("群組 ID 已存在");
  }
}

export function groupElements(layout, refs, { groupId } = {}) {
  assertValidLayoutGroups(layout);
  if (!Array.isArray(refs) || refs.length < 2) throw new LayoutGroupError("至少選取兩個物件才能群組");
  if (groupId == null) throw new LayoutGroupError("建立群組時必須提供 groupId");
  ensureUniqueGroupId(layout, groupId);
  const keys = refs.map(ref => canonicalElementKey(ref.type, ref.id));
  if (new Set(keys).size !== keys.length) throw new LayoutGroupError("群組選取包含重複物件");
  refs.forEach(ref => {
    if (!isGroupableType(ref.type)) throw new LayoutGroupError("v1 只能群組文字與貼圖");
    if (!getElementFromLayout(layout, ref)) throw new LayoutGroupError("群組選取包含不存在的物件");
    if (getGroupForElement(layout, ref)) throw new LayoutGroupError("物件已屬於其他群組");
  });

  const normalizedLayout = normalizeRootZIndices(layout);
  const rootNodes = buildRootRenderNodes(normalizedLayout);
  const indices = keys.map(key => rootNodes.findIndex(node => (
    node.kind === "element" && canonicalElementKey(node.type, node.id) === key
  )));
  if (indices.some(index => index < 0)) throw new LayoutGroupError("群組選取必須是 root 物件");
  const sortedIndices = [...indices].sort((a, b) => a - b);
  const adjacent = sortedIndices.every((value, index) => index === 0 || value === sortedIndices[index - 1] + 1);
  if (!adjacent) throw new LayoutGroupError("選取物件的圖層不相鄰，請先調整圖層");
  const orderedRefs = sortedIndices.map(index => ({ type: rootNodes[index].type, id: rootNodes[index].id }));
  return {
    ...normalizedLayout,
    group_contract: GROUP_CONTRACT,
    groups: [
      ...(normalizedLayout.groups || []),
      {
        id: groupId,
        z_index: sortedIndices[0],
        selection_rotation: 0,
        children: orderedRefs,
        links: [],
      },
    ],
  };
}

function assignDesiredRootOrder(layout, desiredNodes) {
  return desiredNodes.reduce(
    (nextLayout, node, index) => setRootNodeZ(nextLayout, node, index),
    layout,
  );
}

export function ungroupElements(layout, groupId) {
  assertValidLayoutGroups(layout);
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到要解除的群組");
  const rootNodes = buildRootRenderNodes(layout);
  const desiredNodes = rootNodes.flatMap(node => (
    node.kind === "group" && sameId(node.id, groupId) ? node.children : [node]
  ));
  const withoutGroup = {
    ...cloneLayout(layout),
    groups: (layout.groups || []).filter(item => !sameId(item.id, groupId)),
  };
  if (withoutGroup.groups.length === 0) {
    delete withoutGroup.groups;
    delete withoutGroup.group_contract;
  }
  return assignDesiredRootOrder(withoutGroup, desiredNodes);
}

export function reorderRootNode(layout, target, toIndex) {
  assertValidLayoutGroups(layout);
  const rootNodes = buildRootRenderNodes(layout);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= rootNodes.length) {
    throw new LayoutGroupError("目標圖層位置無效");
  }
  const currentIndex = rootNodes.findIndex(node => (
    node.type === target.type && sameId(node.id, target.id)
  ));
  if (currentIndex < 0) throw new LayoutGroupError("找不到要調整的 root 物件");
  const desired = [...rootNodes];
  const [node] = desired.splice(currentIndex, 1);
  desired.splice(toIndex, 0, node);
  return assignDesiredRootOrder(cloneLayout(layout), desired);
}

export function reorderGroupChild(layout, groupId, ref, toIndex) {
  assertValidLayoutGroups(layout);
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= group.children.length) {
    throw new LayoutGroupError("群組內圖層位置無效");
  }
  const currentIndex = group.children.findIndex(child => canonicalElementKey(child.type, child.id) === canonicalElementKey(ref.type, ref.id));
  if (currentIndex < 0) throw new LayoutGroupError("物件不在此群組內");
  const children = group.children.map(child => ({ ...child }));
  const [child] = children.splice(currentIndex, 1);
  children.splice(toIndex, 0, child);
  return {
    ...layout,
    groups: layout.groups.map(item => sameId(item.id, groupId) ? { ...item, children } : item),
  };
}

export function addElementToGroup(layout, groupId, ref, { afterRef = null } = {}) {
  assertValidLayoutGroups(layout);
  if (!ref || !isGroupableType(ref.type) || !getElementFromLayout(layout, ref)) {
    throw new LayoutGroupError("加入群組的物件不存在或類型不支援");
  }
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  const existingGroup = getGroupForElement(layout, ref);
  if (existingGroup) {
    if (sameId(existingGroup.id, group.id)) return layout;
    throw new LayoutGroupError("物件已屬於其他群組");
  }

  let insertIndex = group.children.length;
  if (afterRef) {
    const afterKey = canonicalElementKey(afterRef.type, afterRef.id);
    const afterIndex = group.children.findIndex(child => (
      canonicalElementKey(child.type, child.id) === afterKey
    ));
    if (afterIndex < 0) throw new LayoutGroupError("指定的群組內插入位置不存在");
    insertIndex = afterIndex + 1;
  }
  const children = group.children.map(child => ({ ...child }));
  children.splice(insertIndex, 0, { type: ref.type, id: ref.id });
  return updateGroup(layout, group.id, item => ({ ...item, children }));
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

function addMaterialTextLink(layout, groupId, materialId, textId) {
  return updateGroup(layout, groupId, group => {
    const links = group.links || [];
    const exactLink = links.find(link => (
      link.kind === MATERIAL_TEXT_LINK_KIND
      && sameId(link.material_id, materialId)
      && sameId(link.text_id, textId)
    ));
    if (exactLink) return group;
    if (links.some(link => sameId(link.material_id, materialId))) {
      throw new LayoutGroupError("這張圖片已連結其他文字框");
    }
    if (links.some(link => sameId(link.text_id, textId))) {
      throw new LayoutGroupError("這個文字框已連結其他圖片");
    }
    return {
      ...group,
      links: [...links, { kind: MATERIAL_TEXT_LINK_KIND, material_id: materialId, text_id: textId }],
    };
  });
}

export function linkMaterialText(layout, { materialId, textId, groupId } = {}) {
  assertValidLayoutGroups(layout);
  const materialRef = { type: "sticker", id: materialId };
  const textRef = { type: "text", id: textId };
  if (!getElementFromLayout(layout, materialRef) || !getElementFromLayout(layout, textRef)) {
    throw new LayoutGroupError("連結的圖片或文字框不存在");
  }
  const materialGroup = getGroupForElement(layout, materialRef);
  const textGroup = getGroupForElement(layout, textRef);
  if (materialGroup || textGroup) {
    if (!materialGroup || !textGroup || !sameId(materialGroup.id, textGroup.id)) {
      throw new LayoutGroupError("圖片與文字分屬不同群組，請先解除群組");
    }
    return addMaterialTextLink(layout, materialGroup.id, materialId, textId);
  }
  const grouped = groupElements(layout, [materialRef, textRef], { groupId });
  return addMaterialTextLink(grouped, groupId, materialId, textId);
}

export function unlinkMaterialText(layout, { materialId, textId } = {}) {
  assertValidLayoutGroups(layout);
  const group = getGroupForElement(layout, { type: "sticker", id: materialId });
  if (!group || !getGroupForElement(layout, { type: "text", id: textId }) || (
    !sameId(group.id, getGroupForElement(layout, { type: "text", id: textId })?.id)
  )) return layout;
  return updateGroup(layout, group.id, item => ({
    ...item,
    links: (item.links || []).filter(link => !(
      link.kind === MATERIAL_TEXT_LINK_KIND
      && sameId(link.material_id, materialId)
      && sameId(link.text_id, textId)
    )),
  }));
}

function removeElementFromCollection(layout, ref) {
  const collectionKey = (isGroupableType(ref.type) ? GROUPABLE_KEYS[ref.type] : null)
    || ELEMENT_SPECS.find(([, type]) => type === ref.type)?.[0];
  if (!collectionKey) throw new LayoutGroupError("不支援的元素類型");
  return {
    ...layout,
    [collectionKey]: (layout[collectionKey] || []).filter(element => !sameId(element.id, ref.id)),
  };
}

export function deleteLayoutElement(layout, ref) {
  assertValidLayoutGroups(layout);
  const group = isGroupableType(ref.type) ? getGroupForElement(layout, ref) : null;
  let nextLayout = cloneLayout(layout);
  if (group?.children?.length === 2) {
    nextLayout = ungroupElements(nextLayout, group.id);
  } else if (group) {
    nextLayout = updateGroup(nextLayout, group.id, item => ({
      ...item,
      children: item.children.filter(child => canonicalElementKey(child.type, child.id) !== canonicalElementKey(ref.type, ref.id)),
      links: (item.links || []).filter(link => (
        !(ref.type === "sticker" && sameId(link.material_id, ref.id))
        && !(ref.type === "text" && sameId(link.text_id, ref.id))
      )),
    }));
  }
  nextLayout = removeElementFromCollection(nextLayout, ref);
  return normalizeRootZIndices(nextLayout);
}

export function deleteLayoutGroup(layout, groupId) {
  assertValidLayoutGroups(layout);
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到要刪除的群組");
  let nextLayout = cloneLayout(layout);
  for (const child of group.children) nextLayout = removeElementFromCollection(nextLayout, child);
  nextLayout.groups = (nextLayout.groups || []).filter(item => !sameId(item.id, groupId));
  if (nextLayout.groups.length === 0) {
    delete nextLayout.groups;
    delete nextLayout.group_contract;
  }
  return normalizeRootZIndices(nextLayout);
}

export function moveGroup(layout, groupId, { dx = 0, dy = 0 } = {}) {
  assertValidLayoutGroups(layout);
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new LayoutGroupError("群組位移必須是有限數值");
  return group.children.reduce((nextLayout, ref) => updateElement(nextLayout, ref, element => ({
    ...element,
    x: roundGeometry((Number(element.x) || 0) + dx),
    y: roundGeometry((Number(element.y) || 0) + dy),
  })), cloneLayout(layout));
}

export function rotateGroup(layout, groupId, deltaDegrees) {
  assertValidLayoutGroups(layout);
  if (!Number.isFinite(deltaDegrees)) throw new LayoutGroupError("群組旋轉角度必須是有限數值");
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  const bounds = getGroupBounds(layout, group);
  const pivot = { x: bounds.centerX, y: bounds.centerY };
  let nextLayout = cloneLayout(layout);
  for (const ref of group.children) {
    nextLayout = updateElement(nextLayout, ref, element => {
      const width = Number(element.width) || 0;
      const height = Number(element.height) || 0;
      const center = rotatePoint({
        x: (Number(element.x) || 0) + width / 2,
        y: (Number(element.y) || 0) + height / 2,
      }, pivot, deltaDegrees);
      return {
        ...element,
        x: roundGeometry(center.x - width / 2),
        y: roundGeometry(center.y - height / 2),
        rotation: normalizeAngle((Number(element.rotation) || 0) + deltaDegrees),
      };
    });
  }
  return updateGroup(nextLayout, groupId, item => ({
    ...item,
    selection_rotation: normalizeAngle((Number(item.selection_rotation) || 0) + deltaDegrees),
  }));
}

const TEXT_SCALE_FIELDS = [
  "font_size",
  "letter_spacing",
  "text_shadow_offset_x",
  "text_shadow_offset_y",
  "text_shadow_blur",
];

export function scaleGroupUniform(layout, groupId, scale) {
  assertValidLayoutGroups(layout);
  if (!Number.isFinite(scale) || scale <= 0) throw new LayoutGroupError("群組縮放比例必須大於 0");
  const group = getGroupById(layout, groupId);
  if (!group) throw new LayoutGroupError("找不到群組");
  const bounds = getGroupBounds(layout, group);
  const pivot = { x: bounds.centerX, y: bounds.centerY };
  let nextLayout = cloneLayout(layout);
  for (const ref of group.children) {
    nextLayout = updateElement(nextLayout, ref, element => {
      const width = Number(element.width) || 0;
      const height = Number(element.height) || 0;
      const center = {
        x: (Number(element.x) || 0) + width / 2,
        y: (Number(element.y) || 0) + height / 2,
      };
      const scaledCenter = {
        x: pivot.x + (center.x - pivot.x) * scale,
        y: pivot.y + (center.y - pivot.y) * scale,
      };
      const nextWidth = width * scale;
      const nextHeight = height * scale;
      const scaled = {
        ...element,
        x: roundGeometry(scaledCenter.x - nextWidth / 2),
        y: roundGeometry(scaledCenter.y - nextHeight / 2),
        width: roundGeometry(nextWidth),
        height: roundGeometry(nextHeight),
      };
      if (ref.type === "text") {
        for (const field of TEXT_SCALE_FIELDS) {
          if (typeof element[field] === "number" && Number.isFinite(element[field])) {
            scaled[field] = roundGeometry(element[field] * scale);
          }
        }
      }
      return scaled;
    });
  }
  return nextLayout;
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
  if (stickerWidth <= 0 || stickerHeight <= 0) throw new LayoutGroupError("圖片素材尺寸無效");
  const stickerCenter = { x: stickerX + stickerWidth / 2, y: stickerY + stickerHeight / 2 };
  const localCenter = {
    x: stickerCenter.x + (normalizedBox.x + normalizedBox.width / 2 - 0.5) * stickerWidth,
    y: stickerCenter.y + (normalizedBox.y + normalizedBox.height / 2 - 0.5) * stickerHeight,
  };
  const worldCenter = rotatePoint(localCenter, stickerCenter, Number(sticker.rotation) || 0);
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
