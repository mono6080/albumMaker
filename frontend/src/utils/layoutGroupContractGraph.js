export const GROUP_CONTRACT = "flat-world-v1";
export const NESTED_GROUP_CONTRACT = "nested-world-v2";
export const MATERIAL_TEXT_LINK_KIND = "material-text-v1";

export const ELEMENT_SPECS = [
  ["photo_slots", "photo", 0, 0],
  ["text_labels", "text", 200, 2],
  ["stickers", "sticker", 300, 3],
];
export const COLLECTION_BY_TYPE = Object.fromEntries(ELEMENT_SPECS.map(([key, type]) => [type, key]));
export const LEAF_TYPES = new Set(Object.keys(COLLECTION_BY_TYPE));
export const NODE_TYPES = new Set([...LEAF_TYPES, "group"]);
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

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

export function canonicalId(id) {
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  if (typeof id === "string" && id.trim()) return id;
  throw new LayoutGroupError("元素 ID 必須是非空字串或整數");
}

export function canonicalElementKey(type, id) {
  return String(type) + ":" + canonicalId(id);
}

export function sameId(left, right) {
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
      validation,
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
    // 無群組的 legacy layout 可能有 1 / "1" 這類碰撞；保留後出現者為獨立 root，
    // 查詢仍依舊版 String(id) first-match，不可被 Map 的最後寫入覆蓋。
    if (nodeByKey.has(key)) {
      unkeyedRootNodes.push(node);
      continue;
    }
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
    validation,
    warnings: validation.errors,
    topologyValid: true,
    linkValid: validation.linkValid,
    fallback: false,
  };
}

function nodeRef(node) {
  return { type: node.type, id: node.id };
}

export function filterVisibleRenderNodes(nodes) {
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
