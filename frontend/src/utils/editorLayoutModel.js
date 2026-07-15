import {
  COLLECTION_BY_TYPE,
  buildLayoutGraph,
  filterVisibleRenderNodes,
  flattenRenderNodes,
} from "./layoutGroupContractGraph.js";
import {
  getAncestorGroupIdsFromGraph,
  getDescendantLeafRefsFromGraph,
  getGroupAncestorPathFromGraph,
  getGroupByIdFromGraph,
  getMaterialTextLinkForNode,
  getNodeParentFromGraph,
  getScopeNodesFromGraph,
  resolveHitToDirectChildFromGraph,
} from "./layoutGroupQueries.js";
import {
  getGroupBoundsFromGraph,
  getNodeBoundsFromGraph,
} from "./layoutGroupGeometry.js";

function legacyIdKey(id) {
  try {
    return String(id);
  } catch {
    return null;
  }
}

function legacyRefKey(ref) {
  if (!ref) return null;
  const idKey = legacyIdKey(ref.id);
  return idKey == null ? null : `${ref.type}\u0000${idKey}`;
}

// 舊版 findRenderNode 以 DFS 順序和 String(id) 找第一筆；Map 只做索引，不能改變碰撞語意。
function buildFirstMatchRenderNodeMap(nodes) {
  const nodeByKey = new Map();
  const stack = [...(nodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const key = legacyRefKey(node);
    if (key != null && !nodeByKey.has(key)) nodeByKey.set(key, node);
    if (node.kind === "group") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]);
      }
    }
  }
  return nodeByKey;
}

function buildFirstMatchElementMap(layout) {
  const elementByKey = new Map();
  for (const [type, collectionKey] of Object.entries(COLLECTION_BY_TYPE)) {
    const collection = Array.isArray(layout?.[collectionKey]) ? layout[collectionKey] : [];
    for (const element of collection) {
      if (!element || typeof element !== "object") continue;
      const key = legacyRefKey({ type, id: element.id });
      if (key != null && !elementByKey.has(key)) elementByKey.set(key, element);
    }
  }
  return elementByKey;
}

export function buildEditorLayoutModel(layout, {
  onWarning,
  buildGraph = buildLayoutGraph,
} = {}) {
  const sourceLayout = layout || {};
  const graph = buildGraph(sourceLayout, { onWarning });
  const rootRenderNodes = graph.rootNodes;
  const visibleRootRenderNodes = filterVisibleRenderNodes(rootRenderNodes);
  const flattenedLeaves = flattenRenderNodes(rootRenderNodes);
  const visibleFlattenedLeaves = flattenRenderNodes(visibleRootRenderNodes, { visibleOnly: true });
  const renderNodeByKey = buildFirstMatchRenderNodeMap(rootRenderNodes);
  const visibleRenderNodeByKey = buildFirstMatchRenderNodeMap(visibleRootRenderNodes);
  const elementByKey = buildFirstMatchElementMap(sourceLayout);
  const boundsByKey = new Map();
  const layerStateByKey = new Map();
  const visibleElementOrdinalsByType = new Map();
  const collectionElementOrdinalsByType = new Map();
  const elementCounts = Object.fromEntries(
    Object.entries(COLLECTION_BY_TYPE).map(([type, collectionKey]) => [
      type,
      Array.isArray(sourceLayout[collectionKey]) ? sourceLayout[collectionKey].length : 0,
    ]),
  );

  const getGroupById = groupId => getGroupByIdFromGraph(graph, groupId);
  const getNodeData = ref => (
    ref?.type === "group"
      ? getGroupById(ref.id)
      : elementByKey.get(legacyRefKey(ref)) || null
  );
  const getNodeBounds = ref => {
    const key = legacyRefKey(ref);
    if (key != null && boundsByKey.has(key)) return boundsByKey.get(key);
    const bounds = getNodeBoundsFromGraph(sourceLayout, graph, ref);
    if (key != null) boundsByKey.set(key, bounds);
    return bounds;
  };
  const getNodeLayerState = ref => {
    const key = legacyRefKey(ref);
    if (key != null && layerStateByKey.has(key)) return layerStateByKey.get(key);
    const data = getNodeData(ref);
    if (!data) return { data: null, isVisible: false, isLocked: false };
    const ancestors = getAncestorGroupIdsFromGraph(graph, ref)
      .map(getGroupById)
      .filter(Boolean);
    const stateNodes = ref.type === "group" ? ancestors : [...ancestors, data];
    const state = {
      data,
      isVisible: stateNodes.every(node => node.visible !== false),
      isLocked: stateNodes.some(node => node.locked === true),
    };
    if (key != null) layerStateByKey.set(key, state);
    return state;
  };
  const getRenderNode = (ref, { visibleOnly = false } = {}) => {
    const key = legacyRefKey(ref);
    if (key == null) return null;
    return (visibleOnly ? visibleRenderNodeByKey : renderNodeByKey).get(key) || null;
  };
  const getVisibleElementOrdinals = type => {
    if (visibleElementOrdinalsByType.has(type)) return visibleElementOrdinalsByType.get(type);
    const collectionKey = COLLECTION_BY_TYPE[type];
    if (!collectionKey) return new Map();
    const visibleIds = new Set(
      visibleFlattenedLeaves
        .filter(node => node.type === type)
        .map(node => legacyIdKey(node.id))
        .filter(id => id != null),
    );
    const collection = Array.isArray(sourceLayout[collectionKey]) ? sourceLayout[collectionKey] : [];
    const ordinals = new Map(
      collection
        .filter(item => visibleIds.has(legacyIdKey(item?.id)))
        .map((item, index) => [legacyIdKey(item.id), index + 1]),
    );
    visibleElementOrdinalsByType.set(type, ordinals);
    return ordinals;
  };
  const getCollectionElementOrdinal = (type, elementId) => {
    const collectionKey = COLLECTION_BY_TYPE[type];
    if (!collectionKey) return null;
    if (!collectionElementOrdinalsByType.has(type)) {
      const ordinals = new Map();
      const collection = Array.isArray(sourceLayout[collectionKey]) ? sourceLayout[collectionKey] : [];
      collection.forEach((element, index) => {
        if (element && !ordinals.has(element.id)) ordinals.set(element.id, index + 1);
      });
      collectionElementOrdinalsByType.set(type, ordinals);
    }
    return collectionElementOrdinalsByType.get(type).get(elementId) ?? null;
  };

  return {
    layout: sourceLayout,
    graph,
    validation: graph.validation,
    rootRenderNodes,
    visibleRootRenderNodes,
    flattenedLeaves,
    visibleFlattenedLeaves,
    elementCounts,
    getGroupById,
    getNodeData,
    getNodeParent: ref => getNodeParentFromGraph(graph, ref),
    getScopeNodes: parentGroupId => getScopeNodesFromGraph(graph, parentGroupId),
    getGroupAncestorPath: groupId => getGroupAncestorPathFromGraph(graph, groupId),
    getDescendantLeafRefs: groupId => getDescendantLeafRefsFromGraph(graph, groupId),
    resolveHitToDirectChild: (parentGroupId, leafRef) => (
      resolveHitToDirectChildFromGraph(graph, parentGroupId, leafRef)
    ),
    getNodeBounds,
    getGroupBounds: groupOrId => getGroupBoundsFromGraph(sourceLayout, graph, groupOrId),
    getNodeLayerState,
    getRenderNode,
    getVisibleElementOrdinals,
    getCollectionElementOrdinal,
    getMaterialTextLinkForNode: ref => getMaterialTextLinkForNode(sourceLayout, ref),
  };
}
