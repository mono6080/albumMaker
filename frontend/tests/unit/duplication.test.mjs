import assert from "node:assert/strict";
import { createLayoutClipboard, duplicateLayoutNodes, pasteLayoutNodes } from "../../src/utils/layoutDuplication.js";
import {
  GROUP_CONTRACT,
  MATERIAL_TEXT_LINK_KIND,
  NESTED_GROUP_CONTRACT,
  deleteLayoutElement,
  getDescendantLeafRefs,
  getScopeNodes,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import { getLayoutNodeData } from "../../src/utils/layoutLayerState.js";
import { test } from "./harness.mjs";


test("duplicating multiple leaves offsets copies and inserts each after its source in the same scope", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [{
      id: 101,
      x: 10,
      y: 20,
      width: 80,
      height: 60,
      layer_name: "主照片",
    }],
    text_labels: [{
      id: 201,
      x: 100,
      y: 120,
      width: 160,
      height: 40,
      text: "標題",
    }],
    stickers: [{ id: 301, x: 300, y: 50, width: 40, height: 40 }],
    groups: [{
      id: "scope",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "photo", id: 101 },
        { type: "text", id: 201 },
        { type: "sticker", id: 301 },
      ],
    }],
  };
  const snapshot = JSON.parse(JSON.stringify(layout));
  const sourceRefs = [
    { type: "photo", id: 101 },
    { type: "text", id: 201 },
  ];
  const originalRandom = Math.random;
  const randomValues = [0.1, 0.2];
  let randomIndex = 0;
  Math.random = () => randomValues[randomIndex++];

  let result;
  try {
    result = duplicateLayoutNodes(layout, sourceRefs, {
      parentGroupId: "scope",
      offset: 15,
    });
  } finally {
    Math.random = originalRandom;
  }

  assert.deepEqual(result.refs, [
    { type: "photo", id: 19000 },
    { type: "text", id: 28000 },
  ]);
  assert.deepEqual(getScopeNodes(result.layout, "scope"), [
    { type: "photo", id: 101 },
    { type: "photo", id: 19000 },
    { type: "text", id: 201 },
    { type: "text", id: 28000 },
    { type: "sticker", id: 301 },
  ]);
  assert.deepEqual(getLayoutNodeData(result.layout, result.refs[0]), {
    ...layout.photo_slots[0],
    id: 19000,
    x: 25,
    y: 35,
    layer_name: "主照片 副本",
  });
  const textCopy = getLayoutNodeData(result.layout, result.refs[1]);
  assert.deepEqual(textCopy, {
    ...layout.text_labels[0],
    id: 28000,
    x: 115,
    y: 135,
  });
  assert.equal(Object.hasOwn(textCopy, "layer_name"), false);
  assert.equal(validateLayoutGroups(result.layout).valid, true);
  assert.deepEqual(layout, snapshot);
});


test("duplicating a deep group recursively clones descendants and remaps material-text links", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [{
      id: "photo",
      x: 200,
      y: 30,
      width: 100,
      height: 80,
    }],
    text_labels: [{
      id: "caption",
      x: 20,
      y: 90,
      width: 120,
      height: 40,
      text: "原文字",
      layer_name: "說明文字",
    }],
    stickers: [{
      id: "material",
      x: 20,
      y: 20,
      width: 120,
      height: 60,
      layer_name: "對話素材",
    }],
    groups: [
      {
        id: "inner",
        z_index: 0,
        selection_rotation: 0,
        layer_name: "素材組",
        children: [
          { type: "sticker", id: "material" },
          { type: "text", id: "caption" },
        ],
      },
      {
        id: "outer",
        z_index: 1,
        selection_rotation: 0,
        layer_name: "主群組",
        children: [
          { type: "group", id: "inner" },
          { type: "photo", id: "photo" },
        ],
      },
    ],
    material_text_links: [{
      kind: MATERIAL_TEXT_LINK_KIND,
      material_id: "material",
      text_id: "caption",
    }],
  };
  const snapshot = JSON.parse(JSON.stringify(layout));
  const originalRandom = Math.random;
  const randomValues = [0.1, 0.2, 0.3, 0.4, 0.5];
  let randomIndex = 0;
  Math.random = () => randomValues[randomIndex++];

  let result;
  try {
    result = duplicateLayoutNodes(layout, [{ type: "group", id: "outer" }], {
      offset: 20,
    });
  } finally {
    Math.random = originalRandom;
  }

  assert.deepEqual(result.refs, [{ type: "group", id: 19000 }]);
  assert.deepEqual(getScopeNodes(result.layout, null), [
    { type: "group", id: "outer" },
    { type: "group", id: 19000 },
  ]);
  const outerCopy = getLayoutNodeData(result.layout, result.refs[0]);
  const innerCopy = getLayoutNodeData(result.layout, { type: "group", id: 28000 });
  assert.deepEqual(outerCopy.children, [
    { type: "group", id: 28000 },
    { type: "photo", id: 55000 },
  ]);
  assert.equal(outerCopy.layer_name, "主群組 副本");
  assert.deepEqual(innerCopy.children, [
    { type: "sticker", id: 37000 },
    { type: "text", id: 46000 },
  ]);
  assert.equal(innerCopy.layer_name, "素材組 副本");
  assert.deepEqual(getDescendantLeafRefs(result.layout, 19000), [
    { type: "sticker", id: 37000 },
    { type: "text", id: 46000 },
    { type: "photo", id: 55000 },
  ]);
  assert.deepEqual(getLayoutNodeData(result.layout, { type: "sticker", id: 37000 }), {
    ...layout.stickers[0],
    id: 37000,
    x: 40,
    y: 40,
    layer_name: "對話素材 副本",
  });
  assert.deepEqual(getLayoutNodeData(result.layout, { type: "text", id: 46000 }), {
    ...layout.text_labels[0],
    id: 46000,
    x: 40,
    y: 110,
    layer_name: "說明文字 副本",
  });
  assert.deepEqual(getLayoutNodeData(result.layout, { type: "photo", id: 55000 }), {
    ...layout.photo_slots[0],
    id: 55000,
    x: 220,
    y: 50,
  });
  assert.deepEqual(result.layout.material_text_links, [
    layout.material_text_links[0],
    {
      kind: MATERIAL_TEXT_LINK_KIND,
      material_id: 37000,
      text_id: 46000,
    },
  ]);
  assert.equal(validateLayoutGroups(result.layout).valid, true);
  assert.deepEqual(layout, snapshot);
});


test("cut paste restores a one-ended material link only on the first same-page move", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [],
    stickers: [{
      id: "material",
      x: 20,
      y: 30,
      width: 120,
      height: 60,
      layer_name: "對話素材",
    }],
    text_labels: [{ id: "caption", x: 30, y: 100, width: 140, height: 50, text: "原文字" }],
    groups: [],
    material_text_links: [{
      kind: MATERIAL_TEXT_LINK_KIND,
      material_id: "material",
      text_id: "caption",
    }],
  };
  const clipboard = createLayoutClipboard(layout, [{ type: "sticker", id: "material" }], {
    operation: "cut",
    sourcePageId: 7,
  });
  const cutLayout = deleteLayoutElement(layout, { type: "sticker", id: "material" });
  const originalRandom = Math.random;
  const randomValues = [0.1, 0.2];
  let randomIndex = 0;
  Math.random = () => randomValues[randomIndex++];

  let moved;
  let repeated;
  try {
    moved = pasteLayoutNodes(cutLayout, clipboard, {
      offset: 0,
      restoreExternalMaterialLinks: true,
      asMove: true,
    });
    repeated = pasteLayoutNodes(moved.layout, clipboard, {
      offset: 20,
      restoreExternalMaterialLinks: false,
    });
  } finally {
    Math.random = originalRandom;
  }

  const movedMaterialId = moved.refs[0].id;
  const repeatedMaterialId = repeated.refs[0].id;
  const movedMaterial = getLayoutNodeData(moved.layout, moved.refs[0]);
  const repeatedMaterial = getLayoutNodeData(repeated.layout, repeated.refs[0]);
  assert.equal(clipboard.operation, "cut");
  assert.equal(clipboard.sourcePageId, 7);
  assert.equal(movedMaterial.x, layout.stickers[0].x);
  assert.equal(movedMaterial.y, layout.stickers[0].y);
  assert.equal(movedMaterial.layer_name, "對話素材");
  assert.deepEqual(moved.layout.material_text_links, [{
    kind: MATERIAL_TEXT_LINK_KIND,
    material_id: movedMaterialId,
    text_id: "caption",
  }]);
  assert.equal(moved.externalMaterialLinkCount, 1);
  assert.equal(moved.restoredExternalMaterialLinkCount, 1);
  assert.equal(repeatedMaterial.x, 40);
  assert.equal(repeatedMaterial.layer_name, "對話素材 副本");
  assert.deepEqual(repeated.layout.material_text_links, [{
    kind: MATERIAL_TEXT_LINK_KIND,
    material_id: movedMaterialId,
    text_id: "caption",
  }]);
  assert.notEqual(repeatedMaterialId, movedMaterialId);
  assert.equal(repeated.externalMaterialLinkCount, 1);
  assert.equal(repeated.restoredExternalMaterialLinkCount, 0);
  assert.equal(validateLayoutGroups(repeated.layout).valid, true);
});


test("copying one material-link endpoint never recreates its external link", () => {
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [],
    stickers: [{ id: 11, x: 20, y: 30, width: 120, height: 60 }],
    text_labels: [{ id: 22, x: 30, y: 100, width: 140, height: 50, text: "原文字" }],
    groups: [],
    material_text_links: [{
      kind: MATERIAL_TEXT_LINK_KIND,
      material_id: 11,
      text_id: 22,
    }],
  };
  const clipboard = createLayoutClipboard(layout, [{ type: "sticker", id: 11 }]);
  const targetLayout = deleteLayoutElement(layout, { type: "sticker", id: 11 });
  const result = pasteLayoutNodes(targetLayout, clipboard, {
    offset: 20,
    restoreExternalMaterialLinks: true,
  });

  assert.equal(clipboard.operation, "copy");
  assert.equal(result.externalMaterialLinkCount, 1);
  assert.equal(result.restoredExternalMaterialLinkCount, 0);
  assert.equal(result.layout.material_text_links, undefined);
  assert.equal(validateLayoutGroups(result.layout).valid, true);
});

test("pasting a legacy linked group upgrades an ungrouped target and remaps links", () => {
  const sourceLayout = {
    group_contract: GROUP_CONTRACT,
    photo_slots: [],
    stickers: [{ id: 11, x: 10, y: 20, width: 80, height: 60 }],
    text_labels: [{ id: 22, x: 20, y: 90, width: 100, height: 40, text: "舊文字" }],
    groups: [{
      id: "legacy",
      z_index: 0,
      selection_rotation: 0,
      children: [{ type: "sticker", id: 11 }, { type: "text", id: 22 }],
      links: [{ kind: MATERIAL_TEXT_LINK_KIND, material_id: 11, text_id: 22 }],
    }],
  };
  const targetLayout = {
    photo_slots: [{ id: 99, x: 300, y: 300, width: 100, height: 80, z_index: 0 }],
    text_labels: [],
    stickers: [],
  };
  const clipboard = createLayoutClipboard(sourceLayout, [{ type: "group", id: "legacy" }]);
  const originalRandom = Math.random;
  const randomValues = [0.1, 0.2, 0.3];
  let randomIndex = 0;
  Math.random = () => randomValues[randomIndex++];

  let result;
  try {
    result = pasteLayoutNodes(targetLayout, clipboard, { offset: 25 });
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(result.layout.group_contract, NESTED_GROUP_CONTRACT);
  assert.deepEqual(getScopeNodes(result.layout, null), [
    { type: "photo", id: 99 },
    { type: "group", id: 19000 },
  ]);
  const pastedGroup = getLayoutNodeData(result.layout, { type: "group", id: 19000 });
  assert.equal(Object.hasOwn(pastedGroup, "links"), false);
  assert.deepEqual(pastedGroup.children, [
    { type: "sticker", id: 28000 },
    { type: "text", id: 37000 },
  ]);
  assert.deepEqual(result.layout.material_text_links, [{
    kind: MATERIAL_TEXT_LINK_KIND,
    material_id: 28000,
    text_id: 37000,
  }]);
  assert.equal(getLayoutNodeData(result.layout, { type: "sticker", id: 28000 }).x, 35);
  assert.equal(getLayoutNodeData(result.layout, { type: "text", id: 37000 }).y, 115);
  assert.equal(validateLayoutGroups(result.layout).valid, true);
  assert.equal(Object.hasOwn(targetLayout, "group_contract"), false);
});


test("duplicating a very deep group uses iterative graph cloning", () => {
  const depth = 5000;
  const stickers = Array.from({ length: depth + 1 }, (_, index) => ({
    id: `deep-leaf-${index}`,
    x: index,
    y: 0,
    width: 20,
    height: 20,
  }));
  const groups = Array.from({ length: depth }, (_, index) => ({
    id: `deep-group-${index}`,
    z_index: index,
    selection_rotation: 0,
    children: index === depth - 1
      ? [
          { type: "sticker", id: `deep-leaf-${index}` },
          { type: "sticker", id: `deep-leaf-${depth}` },
        ]
      : [
          { type: "sticker", id: `deep-leaf-${index}` },
          { type: "group", id: `deep-group-${index + 1}` },
        ],
  }));
  const layout = {
    group_contract: NESTED_GROUP_CONTRACT,
    photo_slots: [],
    text_labels: [],
    stickers,
    groups,
  };
  const originalRandom = Math.random;
  let nextGeneratedId = 10000;
  Math.random = () => ((nextGeneratedId++ - 10000) + 0.1) / 90000;

  let result;
  try {
    result = duplicateLayoutNodes(layout, [{ type: "group", id: "deep-group-0" }]);
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(result.refs.length, 1);
  assert.equal(result.layout.groups.length, depth * 2);
  assert.equal(result.layout.stickers.length, (depth + 1) * 2);
  assert.equal(getDescendantLeafRefs(result.layout, result.refs[0].id).length, depth + 1);
  assert.equal(validateLayoutGroups(result.layout).valid, true);
});
