import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NESTED_GROUP_CONTRACT,
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  getAncestorGroupIds,
  getDescendantLeafRefs,
  getFlattenedRenderElements,
  getGroupById,
  getScopeNodes,
  groupElements,
  reorderGroupChild,
  rotateGroup,
  resolveHitToDirectChild,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import { getMarqueeSelectableRefs } from "../../src/utils/marqueeSelection.js";
import { test } from "./harness.mjs";


test("shared nested fixture traverses and scopes every leaf exactly once", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/nested_group_layout.json", import.meta.url),
    "utf8",
  ));
  assert.equal(validateLayoutGroups(layout).valid, true);
  assert.deepEqual(
    buildRootRenderNodes(layout).map(node => node.type + ":" + node.id),
    ["photo:photo-root", "group:outer", "text:text-root"],
  );
  assert.deepEqual(
    getFlattenedRenderElements(layout).map(node => node.type + ":" + node.id),
    [
      "photo:photo-root",
      "photo:photo-inner",
      "text:text-inner",
      "sticker:sticker-outer",
      "text:text-root",
    ],
  );
  assert.deepEqual(getScopeNodes(layout, "outer"), [
    { type: "group", id: "inner" },
    { type: "sticker", id: "sticker-outer" },
  ]);
  assert.deepEqual(
    getAncestorGroupIds(layout, { type: "text", id: "text-inner" }),
    ["outer", "inner"],
  );
  assert.deepEqual(getDescendantLeafRefs(layout, "outer"), [
    { type: "photo", id: "photo-inner" },
    { type: "text", id: "text-inner" },
    { type: "sticker", id: "sticker-outer" },
  ]);
  assert.deepEqual(
    resolveHitToDirectChild(layout, null, { type: "text", id: "text-inner" }),
    { type: "group", id: "outer" },
  );
  assert.deepEqual(
    getMarqueeSelectableRefs(layout, { x: 50, y: 50, width: 320, height: 500 }),
    [{ type: "group", id: "outer" }],
  );
  assert.deepEqual(
    getMarqueeSelectableRefs(
      layout,
      { x: 50, y: 50, width: 320, height: 500 },
      { parentGroupId: "outer" },
    ),
    [{ type: "group", id: "inner" }],
  );
});


test("nested non-adjacent grouping occupies the topmost selected direct-node slot", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/nested_group_layout.json", import.meta.url),
    "utf8",
  ));
  layout.text_labels.push({
    id: "text-nested-selected",
    x: 200,
    y: 500,
    width: 180,
    height: 60,
    text: "nested selected",
    z_index: 20,
  });
  layout.text_labels.push({
    id: "text-nested-above",
    x: 230,
    y: 570,
    width: 190,
    height: 70,
    text: "nested above",
    z_index: 21,
  });
  getGroupById(layout, "outer").children = [
    { type: "group", id: "inner" },
    { type: "sticker", id: "sticker-outer" },
    { type: "text", id: "text-nested-selected" },
    { type: "text", id: "text-nested-above" },
  ];
  const original = structuredClone(layout);

  const grouped = groupElements(layout, [
    { type: "text", id: "text-nested-selected" },
    { type: "group", id: "inner" },
  ], {
    groupId: "nested-selection",
    parentGroupId: "outer",
  });

  assert.deepEqual(getGroupById(grouped, "outer").children, [
    { type: "sticker", id: "sticker-outer" },
    { type: "group", id: "nested-selection" },
    { type: "text", id: "text-nested-above" },
  ]);
  assert.deepEqual(getGroupById(grouped, "nested-selection").children, [
    { type: "group", id: "inner" },
    { type: "text", id: "text-nested-selected" },
  ]);
  assert.deepEqual(
    buildRootRenderNodes(grouped).map(node => node.type + ":" + node.id),
    ["photo:photo-root", "group:outer", "text:text-root"],
  );
  assert.equal(validateLayoutGroups(grouped).valid, true);
  assert.deepEqual(layout, original);
});


test("nested reorder and rotation preserve graph semantics", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/nested_group_layout.json", import.meta.url),
    "utf8",
  ));
  const original = structuredClone(layout);

  const reordered = reorderGroupChild(
    layout,
    "outer",
    { type: "sticker", id: "sticker-outer" },
    0,
  );
  assert.deepEqual(getScopeNodes(reordered, "outer"), [
    { type: "sticker", id: "sticker-outer" },
    { type: "group", id: "inner" },
  ]);
  assert.deepEqual(getScopeNodes(reordered, "inner"), [
    { type: "photo", id: "photo-inner" },
    { type: "text", id: "text-inner" },
  ]);

  const rotated = rotateGroup(reordered, "outer", 30);
  assert.deepEqual(getScopeNodes(rotated, "outer"), getScopeNodes(reordered, "outer"));
  assert.deepEqual(getScopeNodes(rotated, "inner"), getScopeNodes(reordered, "inner"));
  assert.deepEqual(
    getFlattenedRenderElements(rotated).map(node => node.type + ":" + node.id),
    [
      "photo:photo-root",
      "sticker:sticker-outer",
      "photo:photo-inner",
      "text:text-inner",
      "text:text-root",
    ],
  );
  assert.equal(getGroupById(rotated, "outer").selection_rotation, 30);
  assert.equal(getGroupById(rotated, "inner").selection_rotation, 30);
  assert.equal(rotated.stickers.find(item => item.id === "sticker-outer").rotation, 34);
  assert.equal(rotated.photo_slots.find(item => item.id === "photo-inner").rotation, 38);
  assert.equal(rotated.text_labels.find(item => item.id === "text-inner").rotation, 24);
  assert.deepEqual(
    rotated.photo_slots.find(item => item.id === "photo-root"),
    original.photo_slots.find(item => item.id === "photo-root"),
  );
  assert.deepEqual(
    rotated.text_labels.find(item => item.id === "text-root"),
    original.text_labels.find(item => item.id === "text-root"),
  );
  assert.deepEqual(rotated.material_text_links, original.material_text_links);
  assert.equal(validateLayoutGroups(rotated).valid, true);
  assert.deepEqual(layout, original);
});


test("deleting a nested group recursively removes its subtree and related material links", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [
      { id: "photo-inside", x: 0, y: 0, width: 100, height: 80, z_index: 0 },
    ],
    text_labels: [
      { id: "text-inside", x: 10, y: 10, width: 80, height: 30, z_index: 1 },
      { id: "text-outside", x: 200, y: 10, width: 80, height: 30, z_index: 1 },
      { id: "text-keep", x: 200, y: 60, width: 80, height: 30, z_index: 2 },
    ],
    stickers: [
      { id: "material-inside", x: 0, y: 100, width: 100, height: 50, z_index: 2 },
      { id: "material-outside", x: 200, y: 100, width: 100, height: 50, z_index: 3 },
      { id: "material-keep", x: 200, y: 170, width: 100, height: 50, z_index: 4 },
    ],
    groups: [
      {
        id: "deep",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "sticker", id: "material-inside" },
          { type: "text", id: "text-inside" },
        ],
      },
      {
        id: "target",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "group", id: "deep" },
          { type: "photo", id: "photo-inside" },
        ],
      },
      {
        id: "outer",
        z_index: 0,
        selection_rotation: 0,
        children: [
          { type: "group", id: "target" },
          { type: "sticker", id: "material-outside" },
          { type: "sticker", id: "material-keep" },
        ],
      },
    ],
    material_text_links: [
      {
        kind: "material-text-v1",
        material_id: "material-inside",
        text_id: "text-outside",
      },
      {
        kind: "material-text-v1",
        material_id: "material-outside",
        text_id: "text-inside",
      },
      {
        kind: "material-text-v1",
        material_id: "material-keep",
        text_id: "text-keep",
      },
    ],
  };
  const original = structuredClone(layout);
  assert.equal(validateLayoutGroups(layout).valid, true);

  const deleted = deleteLayoutGroup(layout, "target");

  assert.equal(getGroupById(deleted, "target"), null);
  assert.equal(getGroupById(deleted, "deep"), null);
  assert.deepEqual(deleted.photo_slots, []);
  assert.deepEqual(deleted.stickers.map(item => item.id), ["material-outside", "material-keep"]);
  assert.deepEqual(deleted.text_labels.map(item => item.id), ["text-outside", "text-keep"]);
  assert.deepEqual(getGroupById(deleted, "outer").children, [
    { type: "sticker", id: "material-outside" },
    { type: "sticker", id: "material-keep" },
  ]);
  assert.deepEqual(deleted.material_text_links, [{
    kind: "material-text-v1",
    material_id: "material-keep",
    text_id: "text-keep",
  }]);
  assert.deepEqual(
    getFlattenedRenderElements(deleted).map(node => node.type + ":" + node.id),
    [
      "sticker:material-outside",
      "sticker:material-keep",
      "text:text-outside",
      "text:text-keep",
    ],
  );
  assert.equal(validateLayoutGroups(deleted).valid, true);
  assert.deepEqual(layout, original);
});


test("nested select-all grouping collapses its old parent and delete collapses one-child ancestors", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/nested_group_layout.json", import.meta.url),
    "utf8",
  ));
  const regrouped = groupElements(layout, getScopeNodes(layout, "outer"), {
    groupId: "replacement",
    parentGroupId: "outer",
  });
  assert.equal(getGroupById(regrouped, "outer"), null);
  assert.deepEqual(getGroupById(regrouped, "replacement").children, [
    { type: "group", id: "inner" },
    { type: "sticker", id: "sticker-outer" },
  ]);
  assert.deepEqual(
    buildRootRenderNodes(regrouped).map(node => node.type + ":" + node.id),
    ["photo:photo-root", "group:replacement", "text:text-root"],
  );

  const deleted = deleteLayoutElement(layout, { type: "text", id: "text-inner" });
  assert.equal(getGroupById(deleted, "inner"), null);
  assert.deepEqual(getGroupById(deleted, "outer").children, [
    { type: "photo", id: "photo-inner" },
    { type: "sticker", id: "sticker-outer" },
  ]);
  assert.equal(validateLayoutGroups(deleted).valid, true);
});
