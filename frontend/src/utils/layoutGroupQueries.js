import {
  COLLECTION_BY_TYPE,
  GROUP_CONTRACT,
  LEAF_TYPES,
  MATERIAL_TEXT_LINK_KIND,
  NODE_TYPES,
  buildLayoutGraph,
  canonicalElementKey,
  canonicalId,
  sameId,
} from "./layoutGroupContractGraph.js";

export function getGroupByIdFromGraph(graph, id) {
  if (!graph?.topologyValid) return null;
  try {
    return graph.groupsById.get(canonicalId(id)) || null;
  } catch {
    return null;
  }
}

export function getGroupById(layout, id) {
  return getGroupByIdFromGraph(buildLayoutGraph(layout || {}), id);
}

export function getNodeParentFromGraph(graph, ref) {
  if (!ref || !NODE_TYPES.has(ref.type) || !graph?.topologyValid) return null;
  try {
    return graph.parentByNodeKey.get(canonicalElementKey(ref.type, ref.id)) || null;
  } catch {
    return null;
  }
}

export function getNodeParent(layout, ref) {
  return getNodeParentFromGraph(buildLayoutGraph(layout || {}), ref);
}

export function getGroupForElement(layout, ref) {
  return getNodeParent(layout, ref);
}

export function getScopeNodesFromGraph(graph, parentGroupId = null) {
  if (!graph?.topologyValid) return graph?.rootRefs || [];
  if (parentGroupId == null) return graph.rootRefs.map(ref => ({ ...ref }));
  try {
    const key = canonicalElementKey("group", parentGroupId);
    const refs = graph.childrenByParentKey.get(key);
    return refs ? refs.map(ref => ({ ...ref })) : [];
  } catch {
    return [];
  }
}

export function getScopeNodes(layout, parentGroupId = null) {
  return getScopeNodesFromGraph(buildLayoutGraph(layout || {}), parentGroupId);
}

export function getAncestorGroupIdsFromGraph(graph, refOrGroupId) {
  if (!graph?.topologyValid) return [];
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

export function getAncestorGroupIds(layout, refOrGroupId) {
  return getAncestorGroupIdsFromGraph(buildLayoutGraph(layout || {}), refOrGroupId);
}

export function getGroupAncestorPathFromGraph(graph, groupId) {
  return getAncestorGroupIdsFromGraph(graph, { type: "group", id: groupId });
}

export function getGroupAncestorPath(layout, groupId) {
  return getGroupAncestorPathFromGraph(buildLayoutGraph(layout || {}), groupId);
}

export function getDescendantLeafRefsFromGraph(graph, groupId) {
  if (!graph?.topologyValid) return [];
  const group = getGroupByIdFromGraph(graph, groupId);
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

export function getDescendantLeafRefs(layout, groupId) {
  return getDescendantLeafRefsFromGraph(buildLayoutGraph(layout || {}), groupId);
}

export function getDescendantGroupIdsFromGraph(graph, groupId) {
  const output = [];
  const group = getGroupByIdFromGraph(graph, groupId);
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

export function getDescendantGroupIds(layout, groupId) {
  return getDescendantGroupIdsFromGraph(buildLayoutGraph(layout || {}), groupId);
}

export function resolveHitToDirectChildFromGraph(graph, parentGroupId, leafRef) {
  if (!leafRef || !LEAF_TYPES.has(leafRef.type)) return null;
  const scope = getScopeNodesFromGraph(graph, parentGroupId);
  const scopeKeys = new Set(scope.map(ref => canonicalElementKey(ref.type, ref.id)));
  let current = { type: leafRef.type, id: leafRef.id };
  const seen = new Set();
  while (current) {
    const key = canonicalElementKey(current.type, current.id);
    if (scopeKeys.has(key)) return current;
    if (seen.has(key)) return null;
    seen.add(key);
    const parent = getNodeParentFromGraph(graph, current);
    current = parent ? { type: "group", id: parent.id } : null;
  }
  return null;
}

export function resolveHitToDirectChild(layout, parentGroupId, leafRef) {
  return resolveHitToDirectChildFromGraph(
    buildLayoutGraph(layout || {}),
    parentGroupId,
    leafRef,
  );
}

export function getElementFromLayout(layout, ref) {
  const collectionKey = COLLECTION_BY_TYPE[ref?.type];
  if (!collectionKey) return null;
  return (layout?.[collectionKey] || []).find(element => sameId(element.id, ref.id)) || null;
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
