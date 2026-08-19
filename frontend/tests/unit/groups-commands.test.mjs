import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAllElementsSorted } from "../../src/utils/renderLayoutModel.js";
import {
  GROUP_CONTRACT,
  NESTED_GROUP_CONTRACT,
  LayoutGroupError,
  addElementToGroup,
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  getFlattenedRenderElements,
  getGroupBounds,
  groupElements,
  linkMaterialText,
  moveGroup,
  projectNormalizedBoxToSticker,
  reorderGroupChild,
  reorderRootNode,
  rotateGroup,
  removeInvalidMaterialTextLinks,
  scaleGroupUniform,
  ungroupElements,
  unlinkMaterialText,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import { test } from "./harness.mjs";


test("group and ungroup preserve child geometry, style, path, and effective stacking", () => {
  const layout = {
    photo_slots: [{ id: "outside", z_index: 12 }],
    text_labels: [{
      id: "text",
      x: 120,
      y: 45,
      width: 180,
      height: 70,
      rotation: -15,
      z_index: 11,
      text: "內容",
      font_size: 24,
      font_family: "Noto Sans TC",
      font_color: "#123456",
      line_height: 1.4,
      letter_spacing: 1.25,
    }],
    stickers: [{
      id: "sticker",
      x: 80,
      y: 20,
      width: 260,
      height: 110,
      rotation: 30,
      z_index: 10,
      path: "templates/t/stickers/banner.png",
      filename: "banner.png",
      asset_revision: "sha256:abc",
      opacity: 0.8,
    }],
  };
  const original = structuredClone(layout);
  const stableChild = element => {
    const { z_index: _ignored, ...stable } = element;
    return stable;
  };
  const beforeOrder = getAllElementsSorted(layout).map(node => node.type + ":" + node.data.id);
  const grouped = groupElements(layout, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "text" },
  ], { groupId: "group" });

  assert.deepEqual(layout, original);
  assert.deepEqual(grouped.groups[0].children, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "text" },
  ]);
  assert.deepEqual(stableChild(grouped.stickers[0]), stableChild(layout.stickers[0]));
  assert.deepEqual(stableChild(grouped.text_labels[0]), stableChild(layout.text_labels[0]));
  assert.deepEqual(
    getAllElementsSorted(grouped).map(node => node.type + ":" + node.data.id),
    beforeOrder,
  );

  const ungrouped = ungroupElements(grouped, "group");
  assert.equal(ungrouped.groups, undefined);
  assert.equal(ungrouped.group_contract, undefined);
  assert.deepEqual(stableChild(ungrouped.stickers[0]), stableChild(layout.stickers[0]));
  assert.deepEqual(stableChild(ungrouped.text_labels[0]), stableChild(layout.text_labels[0]));
  assert.deepEqual(
    getAllElementsSorted(ungrouped).map(node => node.type + ":" + node.data.id),
    beforeOrder,
  );

  const nonAdjacent = {
    photo_slots: [{ id: "between", z_index: 1 }],
    text_labels: [{ id: "text", z_index: 2 }],
    stickers: [{ id: "sticker", z_index: 0 }],
  };
  const nonAdjacentOriginal = structuredClone(nonAdjacent);
  const nonAdjacentGrouped = groupElements(nonAdjacent, [
    { type: "text", id: "text" },
    { type: "sticker", id: "sticker" },
  ], { groupId: "group" });
  assert.deepEqual(nonAdjacentGrouped.groups[0].children, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "text" },
  ]);
  assert.equal(nonAdjacentGrouped.groups[0].z_index, 1);
  assert.deepEqual(
    buildRootRenderNodes(nonAdjacentGrouped).map(node => `${node.type}:${node.id}`),
    ["photo:between", "group:group"],
  );
  assert.deepEqual(nonAdjacent, nonAdjacentOriginal);
});


test("non-adjacent grouping uses the topmost selected slot and preserves unselected root order", () => {
  const layout = {
    photo_slots: [
      { id: "photo-low", z_index: 1 },
      { id: "photo-high", z_index: 5 },
    ],
    text_labels: [
      { id: "unselected-text", z_index: 3 },
      { id: "selected-text", z_index: 4 },
    ],
    stickers: [
      { id: "selected-sticker", z_index: 0 },
      { id: "plain-sticker", z_index: 2 },
    ],
  };
  const original = structuredClone(layout);

  const grouped = groupElements(layout, [
    { type: "text", id: "selected-text" },
    { type: "sticker", id: "selected-sticker" },
  ], { groupId: "group" });

  assert.deepEqual(grouped.groups[0].children, [
    { type: "sticker", id: "selected-sticker" },
    { type: "text", id: "selected-text" },
  ]);
  assert.equal(grouped.groups[0].z_index, 3);
  assert.deepEqual(
    buildRootRenderNodes(grouped).map(node => `${node.type}:${node.id}`),
    [
      "photo:photo-low",
      "sticker:plain-sticker",
      "text:unselected-text",
      "group:group",
      "photo:photo-high",
    ],
  );
  assert.deepEqual(layout, original);
});


test("root and child reorder, link lifecycle, and deletion keep command boundaries atomic", () => {
  const layout = {
    photo_slots: [{
      id: "photo",
      z_index: 0,
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    }, {
      id: "outside",
      z_index: 3,
      x: 20,
      y: 30,
      width: 120,
      height: 60,
    }],
    stickers: [{
      id: "sticker",
      z_index: 1,
      x: 80,
      y: 100,
      width: 240,
      height: 90,
      rotation: 15,
      path: "templates/t/stickers/banner.png",
      filename: "banner.png",
    }],
    text_labels: [{
      id: "text",
      z_index: 2,
      x: 110,
      y: 120,
      width: 180,
      height: 55,
      rotation: -5,
      text: "linked text",
      font_size: 22,
    }],
  };
  const original = structuredClone(layout);
  const withoutZ = element => {
    const { z_index: _ignored, ...stable } = element;
    return stable;
  };

  const relationOnly = linkMaterialText(layout, {
    materialId: "sticker",
    textId: "text",
  });
  assert.deepEqual(layout, original);
  assert.equal(relationOnly.groups, undefined);
  assert.equal(relationOnly.group_contract, NESTED_GROUP_CONTRACT);
  assert.deepEqual(relationOnly.material_text_links, [{
    kind: "material-text-v1",
    material_id: "sticker",
    text_id: "text",
  }]);
  const linked = groupElements(relationOnly, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "text" },
  ], { groupId: "group" });
  assert.deepEqual(
    buildRootRenderNodes(linked).map(node => node.type + ":" + node.id),
    ["photo:photo", "group:group", "photo:outside"],
  );
  assert.deepEqual(withoutZ(linked.stickers[0]), withoutZ(layout.stickers[0]));
  assert.deepEqual(withoutZ(linked.text_labels[0]), withoutZ(layout.text_labels[0]));

  const rootReordered = reorderRootNode(linked, { type: "group", id: "group" }, 2);
  assert.deepEqual(
    buildRootRenderNodes(rootReordered).map(node => node.type + ":" + node.id),
    ["photo:photo", "photo:outside", "group:group"],
  );
  assert.deepEqual(rootReordered.stickers[0], linked.stickers[0]);
  assert.deepEqual(rootReordered.text_labels[0], linked.text_labels[0]);
  assert.deepEqual(linked.groups[0].children, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "text" },
  ]);

  const childReordered = reorderGroupChild(
    rootReordered,
    "group",
    { type: "text", id: "text" },
    0,
  );
  assert.deepEqual(childReordered.groups[0].children, [
    { type: "text", id: "text" },
    { type: "sticker", id: "sticker" },
  ]);
  assert.deepEqual(childReordered.material_text_links, rootReordered.material_text_links);
  assert.deepEqual(
    getFlattenedRenderElements(childReordered).map(node => node.type + ":" + node.id),
    ["photo:photo", "photo:outside", "text:text", "sticker:sticker"],
  );
  assert.deepEqual(childReordered.stickers[0], rootReordered.stickers[0]);
  assert.deepEqual(childReordered.text_labels[0], rootReordered.text_labels[0]);

  const unlinked = unlinkMaterialText(childReordered, {
    materialId: "sticker",
    textId: "text",
  });
  assert.equal(unlinked.material_text_links, undefined);
  assert.deepEqual(unlinked.groups[0].children, childReordered.groups[0].children);
  assert.deepEqual(unlinked.stickers, childReordered.stickers);
  assert.deepEqual(unlinked.text_labels, childReordered.text_labels);
  const relinked = linkMaterialText(unlinked, {
    materialId: "sticker",
    textId: "text",
  });
  assert.equal(relinked.material_text_links.length, 1);
  assert.deepEqual(relinked.stickers, unlinked.stickers);
  assert.deepEqual(relinked.text_labels, unlinked.text_labels);

  const beforeInvalidReorder = structuredClone(relinked);
  assert.throws(
    () => reorderRootNode(relinked, { type: "group", id: "group" }, 99),
    LayoutGroupError,
  );
  assert.throws(
    () => reorderGroupChild(relinked, "group", { type: "text", id: "text" }, -1),
    LayoutGroupError,
  );
  assert.deepEqual(relinked, beforeInvalidReorder);

  const afterTwoChildDelete = deleteLayoutElement(relinked, {
    type: "sticker",
    id: "sticker",
  });
  assert.equal(afterTwoChildDelete.groups, undefined);
  assert.equal(afterTwoChildDelete.group_contract, undefined);
  assert.equal(afterTwoChildDelete.stickers.length, 0);
  assert.deepEqual(withoutZ(afterTwoChildDelete.text_labels[0]), withoutZ(layout.text_labels[0]));
  assert.deepEqual(
    getFlattenedRenderElements(afterTwoChildDelete).map(node => node.type + ":" + node.id),
    ["photo:photo", "photo:outside", "text:text"],
  );
  assert.equal(relinked.stickers.length, 1);
  assert.equal(relinked.groups.length, 1);

  const afterGroupDelete = deleteLayoutGroup(relinked, "group");
  assert.equal(afterGroupDelete.groups, undefined);
  assert.equal(afterGroupDelete.stickers.length, 0);
  assert.equal(afterGroupDelete.text_labels.length, 0);
  assert.deepEqual(afterGroupDelete.photo_slots.map(withoutZ), layout.photo_slots.map(withoutZ));

  const threeChildLayout = {
    photo_slots: [],
    stickers: [{
      id: "sticker",
      z_index: 0,
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      path: "templates/t/stickers/banner.png",
    }],
    text_labels: [
      { id: "linked", z_index: 1, x: 20, y: 10, width: 120, height: 30, text: "linked" },
      { id: "survivor", z_index: 2, x: 30, y: 40, width: 130, height: 30, text: "survivor" },
    ],
  };
  let threeChildGroup = groupElements(threeChildLayout, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "linked" },
    { type: "text", id: "survivor" },
  ], { groupId: "three" });
  threeChildGroup = linkMaterialText(threeChildGroup, {
    materialId: "sticker",
    textId: "linked",
  });
  const survivorBeforeDelete = structuredClone(threeChildGroup.text_labels[1]);
  const stickerBeforeDelete = structuredClone(threeChildGroup.stickers[0]);
  const afterLinkedTextDelete = deleteLayoutElement(threeChildGroup, {
    type: "text",
    id: "linked",
  });
  assert.deepEqual(afterLinkedTextDelete.groups[0].children, [
    { type: "sticker", id: "sticker" },
    { type: "text", id: "survivor" },
  ]);
  assert.equal(afterLinkedTextDelete.material_text_links, undefined);
  assert.deepEqual(afterLinkedTextDelete.stickers[0], stickerBeforeDelete);
  assert.deepEqual(afterLinkedTextDelete.text_labels[0], survivorBeforeDelete);
  assert.equal(validateLayoutGroups(afterLinkedTextDelete).valid, true);
});


test("adding a child to an existing group preserves its selection axis and metadata", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{ id: "sticker", x: 0, y: 0, width: 200, height: 80, z_index: 0 }],
    text_labels: [
      { id: "existing", x: 20, y: 10, width: 100, height: 30, z_index: 1 },
      { id: "new", x: 30, y: 20, width: 120, height: 40, z_index: 99 },
    ],
    groups: [{
      id: "group",
      z_index: 4,
      selection_rotation: 37,
      custom_metadata: { keep: true },
      children: [
        { type: "sticker", id: "sticker" },
        { type: "text", id: "existing" },
      ],
      links: [],
    }],
  };
  const original = structuredClone(layout);
  const next = addElementToGroup(layout, "group", { type: "text", id: "new" }, {
    afterRef: { type: "sticker", id: "sticker" },
  });
  assert.deepEqual(layout, original);
  assert.deepEqual(next.groups[0], {
    id: "group",
    z_index: 4,
    selection_rotation: 37,
    custom_metadata: { keep: true },
    children: [
      { type: "sticker", id: "sticker" },
      { type: "text", id: "new" },
      { type: "text", id: "existing" },
    ],
  });
  assert.deepEqual(next.stickers, layout.stickers);
  assert.deepEqual(next.text_labels, layout.text_labels);
  assert.equal(validateLayoutGroups(next).valid, true);
  assert.deepEqual(
    getFlattenedRenderElements(next).map(node => `${node.type}:${node.id}`),
    ["sticker:sticker", "text:new", "text:existing"],
  );
});


test("group bounds include every rotated child corner in the selection axis", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{
      id: "sticker",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      rotation: 0,
    }],
    text_labels: [{
      id: "text",
      x: 110,
      y: 0,
      width: 20,
      height: 40,
      rotation: 90,
    }],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: "sticker" },
        { type: "text", id: "text" },
      ],
      links: [],
    }],
  };
  assert.deepEqual(getGroupBounds(layout, "group"), {
    x: 0,
    y: 0,
    width: 140,
    height: 30,
    centerX: 70,
    centerY: 15,
    rotation: 0,
    corners: [
      { x: 0, y: 0 },
      { x: 140, y: 0 },
      { x: 140, y: 30 },
      { x: 0, y: 30 },
    ],
  });

  const rotatedAxis = {
    ...layout,
    groups: [{ ...layout.groups[0], selection_rotation: 90 }],
  };
  const bounds = getGroupBounds(rotatedAxis, "group");
  assert.equal(bounds.rotation, 90);
  assert.equal(bounds.width, 30);
  assert.equal(bounds.height, 140);
  assert.equal(bounds.centerX, 70);
  assert.equal(bounds.centerY, 15);
});


test("group move, rotate, and uniform scale are immutable and use the derived pivot", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{
      id: "sticker",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      path: "templates/t/stickers/free-ratio.png",
    }],
    text_labels: [{
      id: "text",
      x: 100,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      font_size: 20,
    }],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: "sticker" },
        { type: "text", id: "text" },
      ],
      links: [],
    }],
  };
  const original = structuredClone(layout);
  const moved = moveGroup(layout, "group", { dx: 10, dy: -5 });
  assert.deepEqual(
    moved.stickers.map(({ x, y }) => ({ x, y })),
    [{ x: 10, y: -5 }],
  );
  assert.deepEqual(
    moved.text_labels.map(({ x, y }) => ({ x, y })),
    [{ x: 110, y: -5 }],
  );
  assert.deepEqual(layout, original);

  const rotated = rotateGroup(layout, "group", 90);
  assert.deepEqual(
    rotated.stickers.map(({ x, y, rotation }) => ({ x, y, rotation })),
    [{ x: 50, y: -50, rotation: 90 }],
  );
  assert.deepEqual(
    rotated.text_labels.map(({ x, y, rotation }) => ({ x, y, rotation })),
    [{ x: 50, y: 50, rotation: 90 }],
  );
  assert.equal(rotated.groups[0].selection_rotation, 90);
  assert.deepEqual(layout, original);

  const freeRatioLayout = {
    ...layout,
    stickers: [{
      ...layout.stickers[0],
      width: 120,
      height: 30,
    }],
    text_labels: [{
      ...layout.text_labels[0],
      x: 120,
      width: 80,
      height: 30,
      font_size: 20,
      letter_spacing: 1.2,
      line_height: 1.4,
      text_shadow_offset_x: 2,
      text_shadow_offset_y: -3,
      text_shadow_blur: 4,
    }],
  };
  const scaled = scaleGroupUniform(freeRatioLayout, "group", 1.5);
  assert.equal(scaled.stickers[0].width, 180);
  assert.equal(scaled.stickers[0].height, 45);
  assert.equal(
    scaled.stickers[0].width / scaled.stickers[0].height,
    freeRatioLayout.stickers[0].width / freeRatioLayout.stickers[0].height,
  );
  assert.equal(scaled.stickers[0].path, freeRatioLayout.stickers[0].path);
  assert.equal(scaled.text_labels[0].x, 130);
  assert.equal(scaled.text_labels[0].y, -7.5);
  assert.equal(scaled.text_labels[0].width, 120);
  assert.equal(scaled.text_labels[0].height, 45);
  assert.equal(scaled.text_labels[0].font_size, 20);
  assert.equal(scaled.text_labels[0].letter_spacing, 1.2);
  assert.equal(scaled.text_labels[0].line_height, 1.4);
  assert.equal(scaled.text_labels[0].text_shadow_offset_x, 2);
  assert.equal(scaled.text_labels[0].text_shadow_offset_y, -3);
  assert.equal(scaled.text_labels[0].text_shadow_blur, 4);
  assert.deepEqual(freeRatioLayout.stickers[0], {
    ...layout.stickers[0],
    width: 120,
    height: 30,
  });
});


test("group scale preserves all typography and legacy style values", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{
      id: "sticker",
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      rotation: 0,
      path: "templates/t/stickers/banner.png",
    }],
    text_labels: [{
      id: "text",
      x: 120,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      font_size: 20,
      letter_spacing: null,
      text_shadow_offset_x: "",
      text_shadow_offset_y: 2,
      text_shadow_blur: null,
      line_height: 1.4,
    }],
    groups: [{
      id: "group",
      z_index: 0,
      selection_rotation: 0,
      children: [
        { type: "sticker", id: "sticker" },
        { type: "text", id: "text" },
      ],
      links: [],
    }],
  };
  const original = structuredClone(layout);
  const scaled = scaleGroupUniform(layout, "group", 1.5);
  assert.equal(scaled.text_labels[0].x, 125);
  assert.equal(scaled.text_labels[0].y, -10);
  assert.equal(scaled.text_labels[0].width, 150);
  assert.equal(scaled.text_labels[0].height, 60);
  assert.equal(scaled.text_labels[0].font_size, 20);
  assert.equal(scaled.text_labels[0].letter_spacing, null);
  assert.equal(scaled.text_labels[0].text_shadow_offset_x, "");
  assert.equal(scaled.text_labels[0].text_shadow_offset_y, 2);
  assert.equal(scaled.text_labels[0].text_shadow_blur, null);
  assert.equal(scaled.text_labels[0].line_height, 1.4);
  assert.deepEqual(layout, original);
});


test("normalized analysis boxes project through current stretched sticker geometry without snapping ratio", () => {
  const sticker = {
    id: "sticker",
    x: 80,
    y: 700,
    width: 600,
    height: 200,
    rotation: 30,
    path: "templates/t/stickers/banner.png",
  };
  const original = structuredClone(sticker);
  assert.deepEqual(
    projectNormalizedBoxToSticker(sticker, {
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.6,
    }),
    {
      x: 140,
      y: 740,
      width: 480,
      height: 120,
      rotation: 30,
    },
  );
  assert.deepEqual(sticker, original);

  assert.deepEqual(
    projectNormalizedBoxToSticker({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 90,
    }, {
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.5,
    }),
    {
      x: 75,
      y: -25,
      width: 100,
      height: 50,
      rotation: 90,
    },
  );
  assert.throws(
    () => projectNormalizedBoxToSticker(sticker, {
      x: 0.8,
      y: 0,
      width: 0.3,
      height: 1,
    }),
    /超出素材範圍/,
  );
});


test("v1 transforms upgrade and hoist links while preserving typography", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{ id: "s", x: 0, y: 0, width: 120, height: 80, z_index: 0 }],
    text_labels: [{
      id: "t", x: 120, y: 0, width: 100, height: 80, z_index: 1,
      font_size: 20, line_height: 1.4,
    }],
    groups: [{
      id: "g", z_index: 0, selection_rotation: 0,
      children: [{ type: "sticker", id: "s" }, { type: "text", id: "t" }],
      links: [{ kind: "material-text-v1", material_id: "s", text_id: "t" }],
    }],
  };
  const moved = moveGroup(layout, "g", { dx: 10, dy: 5 });
  assert.equal(moved.group_contract, NESTED_GROUP_CONTRACT);
  assert.equal(Object.hasOwn(moved.groups[0], "links"), false);
  assert.equal(moved.material_text_links.length, 1);
  assert.equal(moved.text_labels[0].font_size, 20);
  assert.equal(moved.text_labels[0].x, 130);
  assert.deepEqual(layout.groups[0].links.length, 1);
});


test("link-only corruption is repairable and photo group scale uses visible frames", () => {
  const layout = JSON.parse(readFileSync(
    new URL("../../../tests/fixtures/nested_group_layout.json", import.meta.url),
    "utf8",
  ));
  layout.material_text_links.push(
    null,
    { kind: "material-text-v1", material_id: "missing", text_id: "text-root" },
    { kind: "material-text-v1", material_id: "sticker-outer", text_id: "missing" },
  );
  const invalid = validateLayoutGroups(layout);
  assert.equal(invalid.topologyValid, true);
  assert.equal(invalid.linkValid, false);
  assert.equal(buildRootRenderNodes(layout).some(node => node.type === "group"), true);
  const repaired = removeInvalidMaterialTextLinks(layout);
  assert.equal(repaired.material_text_links.length, 1);
  assert.equal(validateLayoutGroups(repaired).valid, true);

  const original = structuredClone(repaired);
  const scaled = scaleGroupUniform(repaired, "outer", 1.2);
  assert.equal(scaled.text_labels.find(item => item.id === "text-inner").font_size, 18);
  assert.ok(scaled.photo_slots[0].width > repaired.photo_slots[0].width);
  assert.throws(() => scaleGroupUniform(repaired, "outer", 0.1), LayoutGroupError);
  assert.deepEqual(repaired, original);
});
