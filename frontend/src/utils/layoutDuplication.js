import {
  buildLayoutGraph,
  canonicalElementKey,
  ensureNestedWorldV2,
  getMaterialTextLinks,
  getScopeNodes,
  insertNodeInScope,
} from "./layoutGroups.js";

const COLLECTION_BY_TYPE = {
  photo: "photo_slots",
  text: "text_labels",
  sticker: "stickers",
};

function refKey(ref) {
  return `${ref.type}:${String(ref.id)}`;
}

function duplicateLayerName(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? `${normalized} 副本` : undefined;
}

function cloneLayoutNodes(
  targetLayout,
  sourceLayout,
  refs,
  {
    parentGroupId = null,
    offset = 20,
    insertAfterSources = false,
    restoreExternalMaterialLinks = false,
    asMove = false,
  } = {},
) {
  if (!targetLayout || !sourceLayout || !(refs || []).length) {
    return { layout: targetLayout, refs: [] };
  }
  const normalizedTargetLayout = ensureNestedWorldV2(targetLayout);
  const targetScopeBeforePaste = getScopeNodes(normalizedTargetLayout, parentGroupId);
  const sourceGraph = buildLayoutGraph(sourceLayout);
  const next = JSON.parse(JSON.stringify(normalizedTargetLayout));
  const usedElementIds = new Set([
    ...(normalizedTargetLayout.photo_slots || []),
    ...(normalizedTargetLayout.text_labels || []),
    ...(normalizedTargetLayout.stickers || []),
  ].map(item => String(item.id)));
  const usedGroupIds = new Set((normalizedTargetLayout.groups || []).map(item => String(item.id)));
  const duplicatedRefs = new Map();
  const duplicatedLeafRecords = { photo: [], text: [], sticker: [] };
  const duplicatedGroups = [];

  const allocateId = (usedIds) => {
    let candidate = Math.floor(Math.random() * 90000) + 10000;
    while (usedIds.has(String(candidate))) candidate = Math.floor(Math.random() * 90000) + 10000;
    usedIds.add(String(candidate));
    return candidate;
  };

  const clonedKeys = new Set();
  const getSourceNode = (ref) => {
    try {
      return sourceGraph.nodeByKey.get(canonicalElementKey(ref.type, ref.id)) ?? null;
    } catch {
      return null;
    }
  };
  const cloneRef = (rootRef) => {
    const rootKey = refKey(rootRef);
    if (clonedKeys.has(rootKey)) return duplicatedRefs.get(rootKey) ?? null;
    const stack = [{ ref: rootRef, exiting: false }];
    while (stack.length) {
      const frame = stack.pop();
      const key = refKey(frame.ref);
      if (frame.exiting) {
        if (clonedKeys.has(key)) continue;
        const sourceNode = getSourceNode(frame.ref);
        const nextRef = duplicatedRefs.get(key);
        if (!sourceNode || sourceNode.kind !== "group" || !nextRef) continue;
        const sourceGroup = sourceNode.data;
        const children = sourceNode.children
          .map(child => duplicatedRefs.get(refKey(child)))
          .filter(Boolean);
        const { links: _legacyLinks, ...sourceGroupWithoutLinks } = sourceGroup;
        const groupCopy = {
          ...sourceGroupWithoutLinks,
          id: nextRef.id,
          children,
          layer_name: asMove ? sourceGroup.layer_name : duplicateLayerName(sourceGroup.layer_name),
        };
        if (groupCopy.layer_name === undefined) delete groupCopy.layer_name;
        duplicatedGroups.push(groupCopy);
        clonedKeys.add(key);
        continue;
      }
      if (clonedKeys.has(key)) continue;
      const sourceNode = getSourceNode(frame.ref);
      if (!sourceNode) continue;
      if (!duplicatedRefs.has(key)) {
        duplicatedRefs.set(key, {
          type: frame.ref.type,
          id: allocateId(frame.ref.type === "group" ? usedGroupIds : usedElementIds),
        });
      }
      if (sourceNode.kind === "group") {
        stack.push({ ref: frame.ref, exiting: true });
        for (let index = sourceNode.children.length - 1; index >= 0; index -= 1) {
          const child = sourceNode.children[index];
          stack.push({ ref: { type: child.type, id: child.id }, exiting: false });
        }
        continue;
      }

      const nextRef = duplicatedRefs.get(key);
      const sourceItem = sourceNode.data;
      const itemCopy = {
        ...sourceItem,
        id: nextRef.id,
        x: (Number(sourceItem.x) || 0) + offset,
        y: (Number(sourceItem.y) || 0) + offset,
        layer_name: asMove ? sourceItem.layer_name : duplicateLayerName(sourceItem.layer_name),
      };
      if (itemCopy.layer_name === undefined) delete itemCopy.layer_name;
      duplicatedLeafRecords[frame.ref.type].push(itemCopy);
      clonedKeys.add(key);
    }
    return clonedKeys.has(rootKey) ? duplicatedRefs.get(rootKey) : null;
  };

  const nextRefs = refs.map(cloneRef).filter(Boolean);
  Object.entries(COLLECTION_BY_TYPE).forEach(([type, collectionKey]) => {
    if (duplicatedLeafRecords[type].length) {
      next[collectionKey] = [...(next[collectionKey] || []), ...duplicatedLeafRecords[type]];
    }
  });
  if (duplicatedGroups.length) next.groups = [...(next.groups || []), ...duplicatedGroups];

  const existingLinks = getMaterialTextLinks(normalizedTargetLayout);
  const linkedMaterialIds = new Set(existingLinks.map(link => String(link.material_id)));
  const linkedTextIds = new Set(existingLinks.map(link => String(link.text_id)));
  let externalMaterialLinkCount = 0;
  let restoredExternalMaterialLinkCount = 0;
  const duplicatedLinks = getMaterialTextLinks(sourceLayout).flatMap(link => {
    const materialRef = duplicatedRefs.get(refKey({ type: "sticker", id: link.material_id }));
    const textRef = duplicatedRefs.get(refKey({ type: "text", id: link.text_id }));
    if (materialRef && textRef) {
      return [{ ...link, material_id: materialRef.id, text_id: textRef.id }];
    }
    if (!!materialRef === !!textRef) return [];

    externalMaterialLinkCount += 1;
    if (!restoreExternalMaterialLinks) return [];

    const sourceEndpointStillExists = materialRef
      ? (normalizedTargetLayout.stickers || []).some(item => String(item.id) === String(link.material_id))
      : (normalizedTargetLayout.text_labels || []).some(item => String(item.id) === String(link.text_id));
    const externalEndpointExists = materialRef
      ? (normalizedTargetLayout.text_labels || []).some(item => String(item.id) === String(link.text_id))
      : (normalizedTargetLayout.stickers || []).some(item => String(item.id) === String(link.material_id));
    const externalEndpointAlreadyLinked = materialRef
      ? linkedTextIds.has(String(link.text_id))
      : linkedMaterialIds.has(String(link.material_id));
    if (sourceEndpointStillExists || !externalEndpointExists || externalEndpointAlreadyLinked) return [];

    restoredExternalMaterialLinkCount += 1;
    return [{
      ...link,
      material_id: materialRef?.id ?? link.material_id,
      text_id: textRef?.id ?? link.text_id,
    }];
  });
  if (duplicatedLinks.length) {
    next.material_text_links = [...(next.material_text_links || []), ...duplicatedLinks];
  }

  let orderedLayout = next;
  let previousInsertedRef = targetScopeBeforePaste.at(-1) ?? null;
  refs.forEach((sourceRef, index) => {
    const afterRef = insertAfterSources ? sourceRef : previousInsertedRef;
    orderedLayout = insertNodeInScope(orderedLayout, nextRefs[index], {
      parentGroupId,
      afterRef,
    });
    previousInsertedRef = nextRefs[index];
  });
  return {
    layout: orderedLayout,
    refs: nextRefs,
    externalMaterialLinkCount,
    restoredExternalMaterialLinkCount,
  };
}

export function createLayoutClipboard(
  layout,
  refs,
  { operation = "copy", sourcePageId = null } = {},
) {
  if (!layout || !(refs || []).length) return null;
  return {
    sourceLayout: JSON.parse(JSON.stringify(layout)),
    refs: refs.map(ref => ({ type: ref.type, id: ref.id })),
    operation,
    sourcePageId,
  };
}

export function pasteLayoutNodes(
  layout,
  clipboard,
  {
    parentGroupId = null,
    offset = 20,
    restoreExternalMaterialLinks = false,
    asMove = false,
  } = {},
) {
  return cloneLayoutNodes(layout, clipboard?.sourceLayout, clipboard?.refs, {
    parentGroupId,
    offset,
    restoreExternalMaterialLinks:
      clipboard?.operation === "cut" && restoreExternalMaterialLinks,
    asMove: clipboard?.operation === "cut" && asMove,
  });
}

export function duplicateLayoutNodes(
  layout,
  refs,
  { parentGroupId = null, offset = 20 } = {},
) {
  return cloneLayoutNodes(layout, layout, refs, {
    parentGroupId,
    offset,
    insertAfterSources: true,
  });
}
