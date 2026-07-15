import assert from "node:assert/strict";
import * as layoutGroupPublicApi from "../../src/utils/layoutGroups.js";
import { buildEditorLayoutModel } from "../../src/utils/editorLayoutModel.js";
import { buildLayoutGraph } from "../../src/utils/layoutGroupContractGraph.js";
import { getAllElementsSorted } from "../../src/utils/renderLayoutModel.js";
import {
  GROUP_CONTRACT,
  NESTED_GROUP_CONTRACT,
  LayoutGroupError,
  buildRootRenderNodes,
  getFlattenedRenderElements,
  getGroupById,
  getGroupBounds,
  getGroupForElement,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import { test } from "./harness.mjs";


test("layoutGroups facade preserves the public export surface", () => {
  assert.deepEqual(Object.keys(layoutGroupPublicApi).sort(), [
    "GROUP_CONTRACT",
    "LayoutGroupError",
    "MATERIAL_TEXT_LINK_KIND",
    "NESTED_GROUP_CONTRACT",
    "addElementToGroup",
    "assertValidLayoutGroups",
    "buildLayoutGraph",
    "buildRootRenderNodes",
    "canonicalElementKey",
    "deleteLayoutElement",
    "deleteLayoutGroup",
    "ensureNestedWorldV2",
    "flattenRenderNodes",
    "getAncestorGroupIds",
    "getDescendantLeafRefs",
    "getFlattenedRenderElements",
    "getGroupAncestorPath",
    "getGroupBounds",
    "getGroupById",
    "getGroupForElement",
    "getMaterialTextLinkForNode",
    "getMaterialTextLinks",
    "getNodeBounds",
    "getNodeParent",
    "getScopeNodes",
    "groupElements",
    "insertNodeInScope",
    "linkMaterialText",
    "moveGroup",
    "normalizeRootZIndices",
    "projectNormalizedBoxToSticker",
    "removeInvalidMaterialTextLinks",
    "reorderGroupChild",
    "reorderNode",
    "reorderRootNode",
    "resolveHitToDirectChild",
    "rotateGroup",
    "scaleGroupUniform",
    "transformGroup",
    "ungroupElements",
    "unlinkMaterialText",
    "validateLayoutGroups",
  ]);
});


test("editor layout model builds one graph and reuses it for render and query views", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [{
      id: "root-photo",
      x: 0,
      y: 0,
      width: 80,
      height: 60,
      z_index: 0,
    }],
    text_labels: [{
      id: "group-text",
      x: 100,
      y: 10,
      width: 120,
      height: 40,
      z_index: 1,
      visible: false,
    }],
    stickers: [{
      id: "group-sticker",
      x: 90,
      y: 70,
      width: 140,
      height: 50,
      z_index: 2,
    }],
    groups: [{
      id: "group",
      z_index: 1,
      selection_rotation: 0,
      children: [
        { type: "text", id: "group-text" },
        { type: "sticker", id: "group-sticker" },
      ],
    }],
  };
  let buildCount = 0;
  const model = buildEditorLayoutModel(layout, {
    buildGraph: (...args) => {
      buildCount += 1;
      return buildLayoutGraph(...args);
    },
  });

  assert.equal(buildCount, 1);
  assert.deepEqual(
    model.rootRenderNodes.map(node => `${node.type}:${node.id}`),
    ["photo:root-photo", "group:group"],
  );
  assert.deepEqual(
    model.flattenedLeaves.map(node => `${node.type}:${node.id}`),
    ["photo:root-photo", "text:group-text", "sticker:group-sticker"],
  );
  assert.deepEqual(
    model.visibleFlattenedLeaves.map(node => `${node.type}:${node.id}`),
    ["photo:root-photo", "sticker:group-sticker"],
  );
  assert.deepEqual(model.getScopeNodes("group"), [
    { type: "text", id: "group-text" },
    { type: "sticker", id: "group-sticker" },
  ]);
  assert.deepEqual(model.getDescendantLeafRefs("group"), [
    { type: "text", id: "group-text" },
    { type: "sticker", id: "group-sticker" },
  ]);
  assert.equal(model.getNodeLayerState({ type: "text", id: "group-text" }).isVisible, false);
  assert.equal(model.getNodeLayerState({ type: "group", id: "group" }).isLocked, false);
  assert.equal(model.getGroupBounds("group").width, 140);
  assert.equal(model.getRenderNode({ type: "group", id: "group" }).kind, "group");
  assert.deepEqual(model.elementCounts, { photo: 1, text: 1, sticker: 1 });
  const visiblePhotoOrdinals = model.getVisibleElementOrdinals("photo");
  assert.equal(visiblePhotoOrdinals.get("root-photo"), 1);
  assert.equal(model.getVisibleElementOrdinals("photo"), visiblePhotoOrdinals);
  assert.equal(model.getCollectionElementOrdinal("text", "group-text"), 1);
  assert.equal(buildCount, 1);
});


test("editor layout model keeps legacy unsafe IDs and String collision first-match semantics", () => {
  const unsafeNumberId = Number.MAX_SAFE_INTEGER + 1;
  const objectId = { legacy: "object-id" };
  const layout = {
    photo_slots: [
      { id: unsafeNumberId, marker: "unsafe-number", z_index: 0 },
      { id: null, marker: "null", z_index: 1 },
      { id: objectId, marker: "object", z_index: 2 },
      { id: 1, marker: "collision-first", z_index: 3 },
      { id: "1", marker: "collision-second", z_index: 4 },
    ],
    text_labels: [],
    stickers: [],
  };
  let buildCount = 0;
  const model = buildEditorLayoutModel(layout, {
    buildGraph: (...args) => {
      buildCount += 1;
      return buildLayoutGraph(...args);
    },
  });

  assert.equal(model.rootRenderNodes.length, layout.photo_slots.length);
  assert.deepEqual(
    model.rootRenderNodes.map(node => node.data.marker),
    ["unsafe-number", "null", "object", "collision-first", "collision-second"],
  );
  const scopeRefs = model.getScopeNodes(null);
  const scopeNodes = scopeRefs.map(ref => model.getRenderNode(ref));
  const visibleScopeNodes = scopeRefs.map(ref => model.getRenderNode(ref, { visibleOnly: true }));
  assert.equal(scopeNodes.length, layout.photo_slots.length);
  assert.equal(visibleScopeNodes.length, layout.photo_slots.length);
  assert.equal(scopeNodes.every(Boolean), true);
  assert.equal(visibleScopeNodes.every(Boolean), true);

  assert.equal(model.getRenderNode({ type: "photo", id: unsafeNumberId }).data.marker, "unsafe-number");
  assert.equal(model.getRenderNode({ type: "photo", id: null }).data.marker, "null");
  assert.equal(model.getRenderNode({ type: "photo", id: { another: "object" } }).data.marker, "object");
  assert.equal(model.getRenderNode({ type: "photo", id: "1" }).data.marker, "collision-first");
  assert.equal(model.getRenderNode({ type: "photo", id: 1 }).data.marker, "collision-first");
  assert.equal(model.getNodeData({ type: "photo", id: unsafeNumberId }).marker, "unsafe-number");
  assert.equal(model.getNodeData({ type: "photo", id: null }).marker, "null");
  assert.equal(model.getNodeData({ type: "photo", id: { another: "object" } }).marker, "object");
  assert.equal(model.getNodeData({ type: "photo", id: "1" }).marker, "collision-first");
  assert.equal(model.getNodeLayerState({ type: "photo", id: null }).isVisible, true);
  assert.equal(buildCount, 1);
});


test("group traversal keeps legacy order and renders grouped children exactly once in ref order", () => {
  const legacy = {
    photo_slots: [{ id: "photo", z_index: 0 }],
    text_labels: [{ id: "text", z_index: 12 }],
    stickers: [
      { id: "sticker", z_index: 10 },
      { id: "outside", z_index: 40 },
    ],
  };
  assert.deepEqual(
    buildRootRenderNodes(legacy).map(node => node.type + ":" + node.id),
    ["photo:photo", "sticker:sticker", "text:text", "sticker:outside"],
  );

  const grouped = {
    ...legacy,
    group_contract: GROUP_CONTRACT,
    groups: [{
      id: "group",
      z_index: 15,
      selection_rotation: 0,
      children: [
        { type: "text", id: "text" },
        { type: "sticker", id: "sticker" },
      ],
      links: [],
    }],
  };
  assert.deepEqual(
    buildRootRenderNodes(grouped).map(node => node.type + ":" + node.id),
    ["photo:photo", "group:group", "sticker:outside"],
  );
  const flattened = getFlattenedRenderElements(grouped);
  assert.deepEqual(
    flattened.map(node => node.type + ":" + node.id),
    ["photo:photo", "text:text", "sticker:sticker", "sticker:outside"],
  );
  assert.equal(flattened.filter(node => node.id === "text").length, 1);
  assert.equal(flattened.filter(node => node.id === "sticker").length, 1);
  assert.deepEqual(
    getAllElementsSorted(grouped).map(node => node.type + ":" + node.data.id),
    flattened.map(node => node.type + ":" + node.id),
  );
});


test("group validation reports canonical ID collisions, missing refs, and multi-membership", () => {
  const validGroup = {
    id: "group",
    z_index: 0,
    selection_rotation: 0,
    children: [
      { type: "sticker", id: 2 },
      { type: "text", id: 1 },
    ],
    links: [],
  };
  const collision = validateLayoutGroups({
    group_contract: GROUP_CONTRACT,
    text_labels: [{ id: 1 }],
    stickers: [{ id: 2 }, { id: "2" }],
    groups: [validGroup],
  });
  assert.equal(collision.valid, false);
  assert.ok(collision.errors.some(error => (
    error.path === "stickers[1].id"
    && error.child_type === "sticker"
    && error.child_id === "2"
  )));

  const missing = validateLayoutGroups({
    group_contract: GROUP_CONTRACT,
    text_labels: [{ id: 1 }],
    stickers: [{ id: 2 }],
    groups: [{
      ...validGroup,
      children: [
        { type: "sticker", id: 999 },
        { type: "text", id: 1 },
      ],
    }],
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => (
    error.path === "groups[0].children[0]"
    && error.group_id === "group"
    && error.child_type === "sticker"
    && error.child_id === 999
  )));

  const multiMembership = validateLayoutGroups({
    group_contract: GROUP_CONTRACT,
    text_labels: [{ id: 1 }, { id: 3 }],
    stickers: [{ id: 2 }],
    groups: [
      validGroup,
      {
        id: "other",
        z_index: 1,
        selection_rotation: 0,
        children: [
          { type: "sticker", id: 2 },
          { type: "text", id: 3 },
        ],
        links: [],
      },
    ],
  });
  assert.equal(multiMembership.valid, false);
  assert.ok(multiMembership.errors.some(error => (
    error.path === "groups[1].children[0]"
    && error.group_id === "other"
    && error.child_type === "sticker"
    && error.child_id === 2
  )));
});


test("malformed groups fall back atomically and never leak through group queries or bounds", () => {
  const prototypeTypeLayout = {
    group_contract: GROUP_CONTRACT,
    text_labels: [{ id: "text", z_index: 1 }],
    stickers: [{ id: "sticker", z_index: 0 }],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "toString", id: "sticker" },
        { type: "text", id: "text" },
      ],
      links: [],
    }],
  };
  const prototypeValidation = validateLayoutGroups(prototypeTypeLayout);
  assert.equal(prototypeValidation.valid, false);
  assert.ok(prototypeValidation.errors.some(error => (
    error.path === "groups[0].children[0].type"
    && error.child_type === "toString"
  )));
  const prototypeWarnings = [];
  assert.deepEqual(
    buildRootRenderNodes(prototypeTypeLayout, {
      onWarning: warning => prototypeWarnings.push(warning),
    }).map(node => node.type + ":" + node.id),
    ["sticker:sticker", "text:text"],
  );
  assert.equal(prototypeWarnings.length, 1);
  assert.equal(getGroupById(prototypeTypeLayout, "group"), null);
  assert.equal(getGroupForElement(prototypeTypeLayout, { type: "text", id: "text" }), null);
  assert.throws(() => getGroupBounds(prototypeTypeLayout, "group"), LayoutGroupError);

  const missingRefLayout = {
    group_contract: GROUP_CONTRACT,
    text_labels: [{ id: "text", z_index: 1 }],
    stickers: [{ id: "sticker", z_index: 0 }],
    groups: [{
      id: "missing-ref-group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: "sticker" },
        { type: "text", id: "missing" },
      ],
      links: [],
    }],
  };
  const missingWarnings = [];
  const missingFallback = buildRootRenderNodes(missingRefLayout, {
    onWarning: warning => missingWarnings.push(warning),
  });
  assert.deepEqual(
    missingFallback.map(node => node.type + ":" + node.id),
    ["sticker:sticker", "text:text"],
  );
  assert.equal(new Set(missingFallback.map(node => node.type + ":" + node.id)).size, 2);
  assert.equal(missingWarnings.length, 1);
  assert.equal(getGroupById(missingRefLayout, "missing-ref-group"), null);
  assert.equal(getGroupForElement(missingRefLayout, { type: "sticker", id: "sticker" }), null);
  assert.throws(
    () => getGroupBounds(missingRefLayout, missingRefLayout.groups[0]),
    LayoutGroupError,
  );
});


test("duplicate child validation does not misreport same-group membership as another group", () => {
  const result = validateLayoutGroups({
    group_contract: GROUP_CONTRACT,
    text_labels: [],
    stickers: [{ id: "sticker" }],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: "sticker" },
        { type: "sticker", id: "sticker" },
      ],
      links: [],
    }],
  });
  assert.equal(result.valid, false);
  assert.equal(
    result.errors.filter(error => error.message === "duplicate child ref in group").length,
    1,
  );
  assert.equal(
    result.errors.filter(error => error.message === "child already belongs to another group").length,
    0,
  );
});


test("iterative validation and traversal handle deep forests and cycles without recursion", () => {
  const depth = 5000;
  const stickers = Array.from({ length: depth + 1 }, (_, id) => ({ id: "leaf-" + id }));
  const groups = Array.from({ length: depth }, (_, index) => ({
    id: "g-" + index,
    z_index: index,
    selection_rotation: 0,
    children: index === depth - 1
      ? [{ type: "sticker", id: "leaf-" + index }, { type: "sticker", id: "leaf-" + depth }]
      : [{ type: "sticker", id: "leaf-" + index }, { type: "group", id: "g-" + (index + 1) }],
  }));
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    stickers,
    groups,
  };
  assert.equal(validateLayoutGroups(layout).valid, true);
  assert.equal(getFlattenedRenderElements(layout).length, depth + 1);
  assert.equal(getFlattenedRenderElements(layout, { visibleOnly: true }).length, depth + 1);
  const cyclic = structuredClone(layout);
  cyclic.groups[depth - 1].children[1] = { type: "group", id: "g-0" };
  const result = validateLayoutGroups(cyclic);
  assert.equal(result.topologyValid, false);
  assert.ok(result.errors.some(error => error.message === "group cycle detected"));
});


test("legacy ungrouped and v1 pages tolerate unaddressable photo IDs", () => {
  const legacy = { photo_slots: [{}] };
  assert.deepEqual(buildRootRenderNodes(legacy).map(node => node.type), ["photo"]);
  const v1 = {
    ...legacy,
    group_contract: GROUP_CONTRACT,
    stickers: [{ id: "s", z_index: 0 }],
    text_labels: [{ id: "t", z_index: 1 }],
    groups: [{
      id: "g", z_index: 2, selection_rotation: 0,
      children: [{ type: "sticker", id: "s" }, { type: "text", id: "t" }],
      links: [],
    }],
  };
  assert.equal(validateLayoutGroups(v1).valid, true);
  assert.deepEqual(buildRootRenderNodes(v1).map(node => node.type), ["photo", "group"]);
});


test("unsupported orphan markers and unsafe numeric IDs are rejected", () => {
  for (const layout of [
    { group_contract: "bogus-contract" },
    { group_contract: "bogus-contract", groups: [] },
  ]) {
    const result = validateLayoutGroups(layout);
    assert.equal(result.topologyValid, false);
    assert.ok(result.errors.some(error => error.path === "group_contract"));
  }
  assert.equal(validateLayoutGroups({ group_contract: GROUP_CONTRACT, groups: [] }).valid, true);
  assert.equal(validateLayoutGroups({ group_contract: NESTED_GROUP_CONTRACT }).valid, true);
  const unsafe = validateLayoutGroups({
    group_contract: NESTED_GROUP_CONTRACT,
    stickers: [{ id: Number.MAX_SAFE_INTEGER + 1 }],
    text_labels: [{ id: "t" }],
    groups: [{
      id: "g",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: Number.MAX_SAFE_INTEGER + 1 },
        { type: "text", id: "t" },
      ],
    }],
  });
  assert.equal(unsafe.valid, false);
  assert.ok(unsafe.errors.some(error => error.path === "stickers[0].id"));
});
