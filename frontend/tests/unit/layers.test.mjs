import assert from "node:assert/strict";
import {
  NESTED_GROUP_CONTRACT,
  buildRootRenderNodes,
  flattenRenderNodes,
  getAncestorGroupIds,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import {
  getLayoutNodeData,
  getNodeLayerState,
  getVisibleLayoutElementOrdinals,
  getVisibleLayoutElements,
  updateLayoutNodeMetadata,
} from "../../src/utils/layoutLayerState.js";
import { test } from "./harness.mjs";


test("layer state inherits ancestor visibility and lock metadata", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [
      { id: "nested-photo", x: 10, y: 10, width: 80, height: 60 },
      { id: "root-photo", x: 200, y: 10, width: 80, height: 60 },
    ],
    text_labels: [{ id: "nested-text", x: 10, y: 90, width: 80, height: 30 }],
    stickers: [{ id: "outer-sticker", x: 100, y: 10, width: 40, height: 40 }],
    groups: [
      {
        id: "inner",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "photo", id: "nested-photo" },
          { type: "text", id: "nested-text" },
        ],
      },
      {
        id: "outer",
        z_index: 1,
        selection_rotation: 0,
        visible: false,
        locked: true,
        children: [
          { type: "group", id: "inner" },
          { type: "sticker", id: "outer-sticker" },
        ],
      },
    ],
  };

  assert.equal(validateLayoutGroups(layout).valid, true);
  assert.deepEqual(getAncestorGroupIds(layout, { type: "photo", id: "nested-photo" }), ["outer", "inner"]);
  assert.deepEqual(getNodeLayerState(layout, { type: "photo", id: "nested-photo" }), {
    data: layout.photo_slots[0],
    isVisible: false,
    isLocked: true,
  });
  assert.deepEqual(getNodeLayerState(layout, { type: "group", id: "inner" }), {
    data: layout.groups[0],
    isVisible: false,
    isLocked: true,
  });
  assert.deepEqual(getNodeLayerState(layout, { type: "photo", id: "root-photo" }), {
    data: layout.photo_slots[1],
    isVisible: true,
    isLocked: false,
  });
});


test("layer metadata updates leaves and groups and removes undefined fields", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [
      { id: 1, x: 10, y: 20, width: 80, height: 60 },
      { id: 2, x: 100, y: 20, width: 80, height: 60 },
    ],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      layer_name: "舊群組名稱",
      children: [
        { type: "photo", id: 1 },
        { type: "photo", id: 2 },
      ],
    }],
  };

  const updatedLeaf = updateLayoutNodeMetadata(layout, { type: "photo", id: "1" }, {
    layer_name: "主視覺",
    visible: false,
    locked: true,
  });
  assert.deepEqual(getLayoutNodeData(updatedLeaf, { type: "photo", id: 1 }), {
    ...layout.photo_slots[0],
    layer_name: "主視覺",
    visible: false,
    locked: true,
  });
  assert.deepEqual(layout.photo_slots[0], { id: 1, x: 10, y: 20, width: 80, height: 60 });

  const cleanedLeaf = updateLayoutNodeMetadata(updatedLeaf, { type: "photo", id: 1 }, {
    layer_name: undefined,
    locked: undefined,
    visible: true,
  });
  const leaf = getLayoutNodeData(cleanedLeaf, { type: "photo", id: 1 });
  assert.equal(Object.hasOwn(leaf, "layer_name"), false);
  assert.equal(Object.hasOwn(leaf, "locked"), false);
  assert.equal(leaf.visible, true);

  const updatedGroup = updateLayoutNodeMetadata(layout, { type: "group", id: "group" }, {
    layer_name: undefined,
    visible: false,
  });
  const group = getLayoutNodeData(updatedGroup, { type: "group", id: "group" });
  assert.equal(Object.hasOwn(group, "layer_name"), false);
  assert.equal(group.visible, false);
  assert.equal(layout.groups[0].layer_name, "舊群組名稱");
});


test("visible layout elements omit hidden leaves and hidden group subtrees", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [
      { id: "collection-first", x: 400, y: 0, width: 80, height: 60, z_index: 10 },
      { id: "nested-photo", x: 0, y: 0, width: 80, height: 60 },
      { id: "visible-photo", x: 200, y: 0, width: 80, height: 60, z_index: 2 },
      { id: "hidden-photo", x: 300, y: 0, width: 80, height: 60, visible: false },
    ],
    text_labels: [{ id: "nested-text", x: 0, y: 80, width: 80, height: 30 }],
    stickers: [{ id: "outer-sticker", x: 100, y: 0, width: 40, height: 40 }],
    groups: [
      {
        id: "inner",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "photo", id: "nested-photo" },
          { type: "text", id: "nested-text" },
        ],
      },
      {
        id: "outer",
        z_index: 1,
        selection_rotation: 0,
        visible: false,
        children: [
          { type: "group", id: "inner" },
          { type: "sticker", id: "outer-sticker" },
        ],
      },
    ],
  };

  assert.deepEqual(getVisibleLayoutElements(layout).map(item => item.id), [
    "visible-photo",
    "collection-first",
  ]);
  assert.deepEqual(getVisibleLayoutElements(layout, "photo").map(item => item.id), [
    "collection-first",
    "visible-photo",
  ]);
  assert.deepEqual(
    [...getVisibleLayoutElementOrdinals(layout, "photo")],
    [["collection-first", 1], ["visible-photo", 2]],
  );
  assert.deepEqual(getVisibleLayoutElements(layout, "text"), []);
});


test("visible render traversal removes hidden groups before flattening their descendants", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [
      { id: "hidden-group-photo", z_index: 0 },
      { id: "root-visible", z_index: 5 },
    ],
    text_labels: [
      { id: "nested-text", z_index: 1 },
      { id: "direct-hidden", z_index: 2, visible: false },
    ],
    stickers: [
      { id: "nested-sticker", z_index: 3 },
      { id: "direct-visible", z_index: 4 },
    ],
    groups: [
      {
        id: "inner",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "text", id: "nested-text" },
          { type: "sticker", id: "nested-sticker" },
        ],
      },
      {
        id: "hidden-outer",
        z_index: 1,
        selection_rotation: 0,
        visible: false,
        children: [
          { type: "group", id: "inner" },
          { type: "photo", id: "hidden-group-photo" },
        ],
      },
      {
        id: "visible-group",
        z_index: 2,
        selection_rotation: 0,
        children: [
          { type: "text", id: "direct-hidden" },
          { type: "sticker", id: "direct-visible" },
        ],
      },
    ],
  };

  const allRoots = buildRootRenderNodes(layout);
  assert.deepEqual(allRoots.map(node => `${node.type}:${node.id}`), [
    "group:hidden-outer",
    "group:visible-group",
    "photo:root-visible",
  ]);
  assert.deepEqual(
    flattenRenderNodes(allRoots, { visibleOnly: true }).map(node => `${node.type}:${node.id}`),
    ["sticker:direct-visible", "photo:root-visible"],
  );

  const visibleRoots = buildRootRenderNodes(layout, { visibleOnly: true });
  assert.deepEqual(visibleRoots.map(node => `${node.type}:${node.id}`), [
    "group:visible-group",
    "photo:root-visible",
  ]);
  assert.deepEqual(
    flattenRenderNodes(visibleRoots).map(node => `${node.type}:${node.id}`),
    ["sticker:direct-visible", "photo:root-visible"],
  );
});
