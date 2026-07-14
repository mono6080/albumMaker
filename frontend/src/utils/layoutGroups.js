import {
  PHOTO_CONTENT_MIN_HEIGHT,
  PHOTO_CONTENT_MIN_WIDTH,
  getPhotoFrameInsets,
  getPhotoFrameRect,
  getPhotoSlotDimensionMode,
  isPhotoContentBoxMode,
} from "./photoFrameGeometry.js";

export const GROUP_CONTRACT = "flat-world-v1";
export const NESTED_GROUP_CONTRACT = "nested-world-v2";
export const MATERIAL_TEXT_LINK_KIND = "material-text-v1";

const ELEMENT_SPECS = [
  ["photo_slots", "photo", 0, 0],
  ["text_labels", "text", 200, 2],
  ["stickers", "sticker", 300, 3],
];
const COLLECTION_BY_TYPE = Object.fromEntries(ELEMENT_SPECS.map(([key, type]) => [type, key]));
const LEAF_TYPES = new Set(Object.keys(COLLECTION_BY_TYPE));
const NODE_TYPES = new Set([...LEAF_TYPES, "group"]);
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
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  if (typeof id === "string" && id.trim()) return id;
  throw new LayoutGroupError("元素 ID 必須是非空字串或整數");
}

export function canonicalElementKey(type, id) {
  return String(type) + ":" + canonicalId(id);
}

function sameId(left, right) {
  try {
    return canonicalId(left) === canonicalId(right);
  } catch {
    return false;
  }
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

function legacyElementNodes(layout) {
  const nodes = [];
  for (const [collectionKey, type, base, rank] of ELEMENT_SPECS) {
    const collection = Array.isArray(layout?.[collectionKey]) ? layout[collectionKey] : [];
    collection.forEach((data, index) => {
      if (!data || typeof data !== "object") return;
      const zIndex = Number.isFinite(data.z_index) ? data.z_index : base + index;
      nodes.push({
        kind: "element", type, id: data.id, data, index, zIndex,
        zDefault: base + index, groupId: null, _sort: [zIndex, rank, index],
      });
    });
  }
  return nodes.sort(compareSortTuple);
}

function compareSortTuple(left, right) {
  for (let index = 0; index < left._sort.length; index += 1) {
    if (left._sort[index] !== right._sort[index]) return left._sort[index] - right._sort[index];
  }
  return 0;
}

export function validateLayoutGroups(layout) {
  const topologyErrors = [];
  const linkErrors = [];
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    topologyErrors.push(validationError("$", "layout must be an object"));
    return validationResult(topologyErrors, linkErrors);
  }
  const groups = layout.groups;
  const topLinks = layout.material_text_links;
  if (groups != null && !Array.isArray(groups)) {
    topologyErrors.push(validationError("groups", "groups must be an array"));
  }
  if (topLinks != null && !Array.isArray(topLinks)) {
    linkErrors.push(validationError("material_text_links", "material_text_links must be an array"));
  }
  const groupList = Array.isArray(groups) ? groups : [];
  const linkList = Array.isArray(topLinks) ? topLinks : [];
  const contract = layout.group_contract;
  if (contract != null
    && contract !== GROUP_CONTRACT
    && contract !== NESTED_GROUP_CONTRACT) {
    topologyErrors.push(validationError("group_contract", "unsupported group_contract"));
  }
  if (groupList.length === 0 && linkList.length === 0) {
    return validationResult(topologyErrors, linkErrors);
  }
  const active = groupList.length > 0 || linkList.length > 0;
  if (active && contract == null) {
    topologyErrors.push(validationError("group_contract", "unsupported group_contract"));
  }
  const leafMaps = {};
  for (const [collectionKey, type] of ELEMENT_SPECS) {
    if (contract === GROUP_CONTRACT && !["text", "sticker"].includes(type)) {
      leafMaps[type] = new Map();
      continue;
    }
    const collection = layout[collectionKey];
    const map = new Map();
    leafMaps[type] = map;
    if (collection != null && !Array.isArray(collection)) {
      topologyErrors.push(validationError(collectionKey, "collection must be an array"));
      continue;
    }
    (collection || []).forEach((element, index) => {
      try {
        const id = canonicalId(element?.id);
        if (map.has(id)) throw new LayoutGroupError("element ID collides after string normalization");
        map.set(id, element);
      } catch (error) {
        topologyErrors.push(validationError(collectionKey + "[" + index + "].id", error.message, {
          child_type: type, child_id: element?.id,
        }));
      }
    });
  }
  const groupsById = new Map();
  groupList.forEach((group, index) => {
    try {
      const id = canonicalId(group?.id);
      if (groupsById.has(id)) throw new LayoutGroupError("group ID collides after string normalization");
      groupsById.set(id, group);
    } catch (error) {
      topologyErrors.push(validationError("groups[" + index + "].id", error.message, { group_id: group?.id }));
    }
  });
  const parentByKey = new Map();
  groupList.forEach((group, groupIndex) => {
    const path = "groups[" + groupIndex + "]";
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      topologyErrors.push(validationError(path, "group must be an object"));
      return;
    }
    for (const key of Object.keys(group)) {
      if (FORBIDDEN_GROUP_GEOMETRY.has(key)) {
        topologyErrors.push(validationError(path + "." + key, "group geometry must be derived", { group_id: group.id }));
      }
    }
    if (!Number.isFinite(group.z_index)) topologyErrors.push(validationError(path + ".z_index", "z_index must be finite", { group_id: group.id }));
    if (!Number.isFinite(group.selection_rotation)) topologyErrors.push(validationError(path + ".selection_rotation", "selection_rotation must be finite", { group_id: group.id }));
    if (!Array.isArray(group.children)) {
      topologyErrors.push(validationError(path + ".children", "children must be an array", { group_id: group.id }));
      return;
    }
    if (group.children.length < 2) topologyErrors.push(validationError(path + ".children", "group must contain at least two children", { group_id: group.id }));
    const local = new Set();
    group.children.forEach((child, childIndex) => {
      const childPath = path + ".children[" + childIndex + "]";
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        topologyErrors.push(validationError(childPath, "child ref must be an object", { group_id: group.id }));
        return;
      }
      const allowed = contract === GROUP_CONTRACT ? new Set(["text", "sticker"]) : NODE_TYPES;
      if (!allowed.has(child.type)) {
        topologyErrors.push(validationError(childPath + ".type", "unsupported child type", {
          group_id: group.id, child_type: child.type, child_id: child.id,
        }));
        return;
      }
      try {
        const key = canonicalElementKey(child.type, child.id);
        if (local.has(key)) throw new LayoutGroupError("duplicate child ref in group");
        local.add(key);
        if (parentByKey.has(key)) throw new LayoutGroupError("child already belongs to another group");
        parentByKey.set(key, group);
        const exists = child.type === "group"
          ? groupsById.has(canonicalId(child.id))
          : leafMaps[child.type]?.has(canonicalId(child.id));
        if (!exists) throw new LayoutGroupError("child ref does not exist");
        if (child.type === "group" && sameId(child.id, group.id)) throw new LayoutGroupError("group cannot contain itself");
      } catch (error) {
        topologyErrors.push(validationError(childPath, error.message, {
          group_id: group.id, child_type: child.type, child_id: child.id,
        }));
      }
    });
    if (contract === NESTED_GROUP_CONTRACT && Object.hasOwn(group, "links")) {
      topologyErrors.push(validationError(path + ".links", "v2 links must be layout-level", { group_id: group.id }));
    }
  });
  validateCycles(groupList, groupsById, topologyErrors);
  const relationErrors = [];
  validateLinks(layout, leafMaps, relationErrors);
  for (const error of relationErrors) {
    if (contract === GROUP_CONTRACT && error.path.startsWith("groups[")) {
      topologyErrors.push(error);
    } else {
      linkErrors.push(error);
    }
  }
  return validationResult(topologyErrors, linkErrors);
}

function validationResult(topologyErrors, linkErrors) {
  const errors = [...topologyErrors, ...linkErrors];
  return {
    valid: errors.length === 0, errors,
    topologyValid: topologyErrors.length === 0,
    linkValid: linkErrors.length === 0,
    topologyErrors, linkErrors,
  };
}

function validateCycles(groups, groupsById, errors) {
  const color = new Map();
  for (const start of groups) {
    if (!start || typeof start !== "object" || Array.isArray(start)) continue;
    let startKey;
    try { startKey = canonicalId(start.id); } catch { continue; }
    if (color.get(startKey) === 2) continue;
    color.set(startKey, 1);
    const stack = [{ group: start, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = Array.isArray(frame.group.children) ? frame.group.children : [];
      if (frame.index >= children.length) {
        color.set(canonicalId(frame.group.id), 2);
        stack.pop();
        continue;
      }
      const childIndex = frame.index++;
      const child = children[childIndex];
      if (child?.type !== "group") continue;
      if (sameId(child.id, frame.group.id)) continue;
      let key;
      try { key = canonicalId(child.id); } catch { continue; }
      if (color.get(key) === 1) {
        const groupIndex = groups.indexOf(frame.group);
        errors.push(validationError("groups[" + groupIndex + "].children[" + childIndex + "]", "group cycle detected", {
          group_id: frame.group.id, child_type: "group", child_id: child.id,
        }));
      } else if (!color.get(key) && groupsById.has(key)) {
        color.set(key, 1);
        stack.push({ group: groupsById.get(key), index: 0 });
      }
    }
  }
}

function validateLinks(layout, leafMaps, errors) {
  const links = [];
  if (layout.group_contract === GROUP_CONTRACT) {
    (Array.isArray(layout.groups) ? layout.groups : []).forEach((group, groupIndex) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return;
      if (group.links != null && !Array.isArray(group.links)) {
        errors.push(validationError("groups[" + groupIndex + "].links", "links must be an array", {
          group_id: group.id,
        }));
        return;
      }
      const directChildren = Array.isArray(group.children) ? group.children : [];
      const directKeys = new Set(directChildren.map(child => {
        try { return canonicalElementKey(child.type, child.id); } catch { return null; }
      }));
      (group.links || []).forEach((link, linkIndex) => links.push({
        link,
        path: "groups[" + groupIndex + "].links[" + linkIndex + "]",
        group,
        directKeys,
      }));
    });
  } else if (Array.isArray(layout.material_text_links)) {
    layout.material_text_links.forEach((link, index) => links.push({
      link, path: "material_text_links[" + index + "]",
    }));
  }
  if (layout.group_contract === GROUP_CONTRACT && (layout.material_text_links || []).length) {
    errors.push(validationError("material_text_links", "top-level links require nested-world-v2"));
  }
  const materials = new Set();
  const texts = new Set();
  for (const item of links) {
    const { link, path, group, directKeys } = item;
    if (!link || typeof link !== "object" || link.kind !== MATERIAL_TEXT_LINK_KIND) {
      errors.push(validationError(path, "invalid material-text link", { group_id: group?.id }));
      continue;
    }
    for (const [field, type, seen] of [["material_id", "sticker", materials], ["text_id", "text", texts]]) {
      try {
        const id = canonicalId(link[field]);
        if (!leafMaps[type].has(id)) throw new LayoutGroupError("link endpoint does not exist");
        if (directKeys && !directKeys.has(type + ":" + id)) {
          throw new LayoutGroupError("link endpoint must reference a direct child in the same group");
        }
        if (seen.has(id)) throw new LayoutGroupError("link endpoint is already linked");
        seen.add(id);
      } catch (error) {
        errors.push(validationError(path + "." + field, error.message, {
          group_id: group?.id, child_type: type, child_id: link[field],
        }));
      }
    }
  }
}

export function assertValidLayoutGroups(layout) {
  const result = validateLayoutGroups(layout);
  if (!result.valid) throw new LayoutGroupError("群組資料格式不正確", result.errors);
  return layout;
}

export function buildLayoutGraph(layout, { onWarning } = {}) {
  const legacyNodes = legacyElementNodes(layout || {});
  const validation = validateLayoutGroups(layout || {});
  if (validation.errors.length) onWarning?.(validation.errors);
  if (!validation.topologyValid) {
    return {
      groupsById: new Map(),
      parentByNodeKey: new Map(),
      childrenByParentKey: new Map([["root", legacyNodes.map(nodeRef)]]),
      nodeByKey: new Map(),
      rootNodes: legacyNodes,
      rootRefs: legacyNodes.map(nodeRef),
      warnings: validation.errors,
      topologyValid: false,
      linkValid: validation.linkValid,
      fallback: true,
    };
  }

  const groups = Array.isArray(layout?.groups) ? layout.groups : [];
  const groupsById = new Map();
  const groupIndexById = new Map();
  groups.forEach((group, index) => {
    groupsById.set(canonicalId(group.id), group);
    groupIndexById.set(canonicalId(group.id), index);
  });
  const parentByNodeKey = new Map();
  const childrenByParentKey = new Map();
  for (const group of groups) {
    const refs = group.children.map(ref => ({ type: ref.type, id: ref.id }));
    const groupKey = canonicalElementKey("group", group.id);
    childrenByParentKey.set(groupKey, refs);
    for (const ref of refs) parentByNodeKey.set(canonicalElementKey(ref.type, ref.id), group);
  }

  const nodeByKey = new Map();
  const unkeyedRootNodes = [];
  for (const node of legacyNodes) {
    let key;
    try {
      key = canonicalElementKey(node.type, node.id);
    } catch {
      unkeyedRootNodes.push(node);
      continue;
    }
    node.groupId = parentByNodeKey.get(key)?.id ?? null;
    nodeByKey.set(key, node);
  }
  for (const group of groups) {
    const index = groupIndexById.get(canonicalId(group.id));
    const zIndex = Number.isFinite(group.z_index) ? group.z_index : index;
    nodeByKey.set(canonicalElementKey("group", group.id), {
      kind: "group",
      type: "group",
      id: group.id,
      data: group,
      index,
      zIndex,
      groupId: parentByNodeKey.get(canonicalElementKey("group", group.id))?.id ?? null,
      children: [],
      _sort: [zIndex, 4, index],
    });
  }
  for (const group of groups) {
    const groupNode = nodeByKey.get(canonicalElementKey("group", group.id));
    groupNode.children = group.children.map(ref => nodeByKey.get(canonicalElementKey(ref.type, ref.id)));
  }

  const rootNodes = [...unkeyedRootNodes];
  for (const node of nodeByKey.values()) {
    if (!parentByNodeKey.has(canonicalElementKey(node.type, node.id))) rootNodes.push(node);
  }
  rootNodes.sort(compareSortTuple);
  const rootRefs = rootNodes.map(nodeRef);
  childrenByParentKey.set("root", rootRefs);
  return {
    groupsById,
    parentByNodeKey,
    childrenByParentKey,
    nodeByKey,
    rootNodes,
    rootRefs,
    warnings: validation.errors,
    topologyValid: true,
    linkValid: validation.linkValid,
    fallback: false,
  };
}

function nodeRef(node) {
  return { type: node.type, id: node.id };
}

function filterVisibleRenderNodes(nodes) {
  const output = [];
  const stack = [];
  const rootNodes = nodes || [];
  for (let index = rootNodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: rootNodes[index], target: output });
  }
  while (stack.length) {
    const { node, target } = stack.pop();
    if (!node || node.data?.visible === false) continue;
    if (node.kind !== "group") {
      target.push(node);
      continue;
    }
    const visibleGroup = { ...node, children: [] };
    target.push(visibleGroup);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index], target: visibleGroup.children });
    }
  }
  return output;
}

export function buildRootRenderNodes(layout, options = {}) {
  const rootNodes = buildLayoutGraph(layout || {}, options).rootNodes;
  return options.visibleOnly ? filterVisibleRenderNodes(rootNodes) : rootNodes;
}

export function flattenRenderNodes(nodes, { visibleOnly = false } = {}) {
  const output = [];
  const stack = [...(nodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (visibleOnly && node.data?.visible === false) continue;
    if (node.kind === "group") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]);
      }
    } else {
      output.push(node);
    }
  }
  return output;
}

export function getFlattenedRenderElements(layout, options) {
  return flattenRenderNodes(buildRootRenderNodes(layout, options), options);
}

export function getGroupById(layout, id) {
  const graph = buildLayoutGraph(layout || {});
  if (!graph.topologyValid) return null;
  try {
    return graph.groupsById.get(canonicalId(id)) || null;
  } catch {
    return null;
  }
}

export function getNodeParent(layout, ref) {
  if (!ref || !NODE_TYPES.has(ref.type)) return null;
  const graph = buildLayoutGraph(layout || {});
  if (!graph.topologyValid) return null;
  try {
    return graph.parentByNodeKey.get(canonicalElementKey(ref.type, ref.id)) || null;
  } catch {
    return null;
  }
}

export function getGroupForElement(layout, ref) {
  return getNodeParent(layout, ref);
}

export function getScopeNodes(layout, parentGroupId = null) {
  const graph = buildLayoutGraph(layout || {});
  if (!graph.topologyValid) return graph.rootRefs;
  if (parentGroupId == null) return graph.rootRefs.map(ref => ({ ...ref }));
  try {
    const key = canonicalElementKey("group", parentGroupId);
    const refs = graph.childrenByParentKey.get(key);
    return refs ? refs.map(ref => ({ ...ref })) : [];
  } catch {
    return [];
  }
}

export function getAncestorGroupIds(layout, refOrGroupId) {
  const graph = buildLayoutGraph(layout || {});
  if (!graph.topologyValid) return [];
  const isRef = refOrGroupId && typeof refOrGroupId === "object";
  const ref = isRef ? refOrGroupId : { type: "group", id: refOrGroupId };
  if (!ref || !NODE_TYPES.has(ref.type)) return [];
  let key;
  try {
    key = canonicalElementKey(ref.type, ref.id);
  } catch {
    return [];
  }
  const reversed = [];
  if (ref.type === "group" && graph.groupsById.has(canonicalId(ref.id))) reversed.push(ref.id);
  const seen = new Set();
  let parent = graph.parentByNodeKey.get(key);
  while (parent) {
    const parentKey = canonicalId(parent.id);
    if (seen.has(parentKey)) return [];
    seen.add(parentKey);
    reversed.push(parent.id);
    parent = graph.parentByNodeKey.get(canonicalElementKey("group", parent.id));
  }
  return reversed.reverse();
}

export function getGroupAncestorPath(layout, groupId) {
  return getAncestorGroupIds(layout, { type: "group", id: groupId });
}

export function getDescendantLeafRefs(layout, groupId) {
  const graph = buildLayoutGraph(layout || {});
  if (!graph.topologyValid) return [];
  let group;
  try {
    group = graph.groupsById.get(canonicalId(groupId));
  } catch {
    return [];
  }
  if (!group) return [];
  const output = [];
  const seenLeaves = new Set();
  const seenGroups = new Set();
  const stack = [...group.children].reverse();
  while (stack.length) {
    const ref = stack.pop();
    const key = canonicalElementKey(ref.type, ref.id);
    if (ref.type !== "group") {
      if (!seenLeaves.has(key)) {
        seenLeaves.add(key);
        output.push({ type: ref.type, id: ref.id });
      }
      continue;
    }
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    const childGroup = graph.groupsById.get(canonicalId(ref.id));
    for (let index = childGroup.children.length - 1; index >= 0; index -= 1) {
      stack.push(childGroup.children[index]);
    }
  }
  return output;
}

function getDescendantGroupIds(layout, groupId) {
  const graph = buildLayoutGraph(layout || {});
  const output = [];
  let group;
  try { group = graph.groupsById.get(canonicalId(groupId)); } catch { return output; }
  if (!group) return output;
  const stack = [group];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    const key = canonicalId(current.id);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(current.id);
    for (const child of current.children) {
      if (child.type === "group") stack.push(graph.groupsById.get(canonicalId(child.id)));
    }
  }
  return output;
}

export function resolveHitToDirectChild(layout, parentGroupId, leafRef) {
  if (!leafRef || !LEAF_TYPES.has(leafRef.type)) return null;
  const scope = getScopeNodes(layout, parentGroupId);
  const scopeKeys = new Set(scope.map(ref => canonicalElementKey(ref.type, ref.id)));
  let current = { type: leafRef.type, id: leafRef.id };
  const seen = new Set();
  while (current) {
    const key = canonicalElementKey(current.type, current.id);
    if (scopeKeys.has(key)) return current;
    if (seen.has(key)) return null;
    seen.add(key);
    const parent = getNodeParent(layout, current);
    current = parent ? { type: "group", id: parent.id } : null;
  }
  return null;
}

function getElementFromLayout(layout, ref) {
  const collectionKey = COLLECTION_BY_TYPE[ref?.type];
  if (!collectionKey) return null;
  return (layout?.[collectionKey] || []).find(element => sameId(element.id, ref.id)) || null;
}

function roundGeometry(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function normalizeAngle(value) {
  return roundGeometry(((Number(value) + 180) % 360 + 360) % 360 - 180);
}

function rotatePoint(point, center, degrees) {
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

function getLeafFrameRect(layout, ref, element) {
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

export function getNodeBounds(layout, ref) {
  if (!ref || !NODE_TYPES.has(ref.type)) throw new LayoutGroupError("找不到物件");
  if (ref.type !== "group") {
    const element = getElementFromLayout(layout, ref);
    if (!element) throw new LayoutGroupError("找不到物件");
    return boundsForLeaf(layout, ref, element);
  }
  const group = getGroupById(layout, ref.id);
  if (!group) throw new LayoutGroupError("找不到群組");
  const leafRefs = getDescendantLeafRefs(layout, group.id);
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

export function getGroupBounds(layout, groupOrId) {
  const id = typeof groupOrId === "object" && groupOrId ? groupOrId.id : groupOrId;
  return getNodeBounds(layout, { type: "group", id });
}

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

export function getMaterialTextLinks(layout) {
  if (Array.isArray(layout?.material_text_links)) return layout.material_text_links;
  if (layout?.group_contract === GROUP_CONTRACT) {
    return (Array.isArray(layout.groups) ? layout.groups : []).flatMap(group => (
      group && Array.isArray(group.links) ? group.links : []
    ));
  }
  return [];
}

export function getMaterialTextLinkForNode(layout, ref) {
  if (!ref || !["sticker", "text"].includes(ref.type)) return null;
  const field = ref.type === "sticker" ? "material_id" : "text_id";
  return getMaterialTextLinks(layout).find(link => (
    link && typeof link === "object"
    && link.kind === MATERIAL_TEXT_LINK_KIND
    && sameId(link[field], ref.id)
  )) || null;
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

function applyVisibleFrame(layout, ref, element, frame) {
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

function assertPhotoScaleMinimum(element, nextFrame) {
  const insets = getPhotoFrameInsets(element);
  const contentWidth = nextFrame.width - insets.left - insets.right;
  const contentHeight = nextFrame.height - insets.top - insets.bottom;
  if (contentWidth < PHOTO_CONTENT_MIN_WIDTH || contentHeight < PHOTO_CONTENT_MIN_HEIGHT) {
    throw new LayoutGroupError("群組縮放會讓照片內容小於 60×40");
  }
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
