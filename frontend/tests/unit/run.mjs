import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDownloadAllImagesZipUrl,
  buildDownloadAllZipUrl,
  buildDownloadImageUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildPhotoThumbnailUrl,
  buildPhotoUrl,
  buildProjectPagePreviewUrl,
  buildStickerUrl,
  buildStudentPagePreviewUrl,
  buildTemplatePagePreviewUrl,
  buildTemplateSpreadPreviewUrl,
} from "../../src/api/urls.js";
import { getCanvasElementRefFromTarget } from "../../src/components/canvas/canvasHover.js";
import { getApiPath, getFilenameFromDisposition, isMobileDevice } from "../../src/utils/browserFiles.js";
import { buildItems, clampPan, getPhotoCropBox, normalizePhotoData, photoDims } from "../../src/utils/photoUtils.js";
import {
  PHOTO_SLOT_CONTENT_BOX_MODE,
  getPhotoContentRect,
  getPhotoFrameRect,
} from "../../src/utils/photoFrameGeometry.js";
import {
  matchPersonalFilesToSlots,
  matchByNamePageSlot,
  matchByNameSlotSequence,
} from "../../src/utils/photoMatcher.js";
import {
  CANVAS_DISPLAY_WIDTH,
  CANVAS_REAL_WIDTH,
  applyElementsToLayout,
  buildRenderLayoutModel,
  getAllElementsSorted,
  getDisplayBox,
  getInitialStickerSize,
  getNextZIndex,
  toDisplayCoord,
  toRealCoord,
} from "../../src/utils/renderLayoutModel.js";
import {
  createLayoutClipboard,
  duplicateLayoutNodes,
  pasteLayoutNodes,
} from "../../src/utils/layoutDuplication.js";
import {
  GROUP_CONTRACT,
  MATERIAL_TEXT_LINK_KIND,
  NESTED_GROUP_CONTRACT,
  LayoutGroupError,
  addElementToGroup,
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  flattenRenderNodes,
  getAncestorGroupIds,
  getDescendantLeafRefs,
  getFlattenedRenderElements,
  getGroupById,
  getGroupBounds,
  getGroupForElement,
  getScopeNodes,
  groupElements,
  linkMaterialText,
  moveGroup,
  projectNormalizedBoxToSticker,
  reorderGroupChild,
  reorderRootNode,
  rotateGroup,
  removeInvalidMaterialTextLinks,
  resolveHitToDirectChild,
  scaleGroupUniform,
  ungroupElements,
  unlinkMaterialText,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
import {
  getLayoutNodeData,
  getNodeLayerState,
  getVisibleLayoutElementOrdinals,
  getVisibleLayoutElements,
  updateLayoutNodeMetadata,
} from "../../src/utils/layoutLayerState.js";
import {
  alignLayoutNodes,
  canMatchSelectionSize,
  distributeLayoutNodes,
  getAxisAlignedNodeBounds,
} from "../../src/utils/layoutSelectionOperations.js";
import { getMarqueeSelectableRefs } from "../../src/utils/marqueeSelection.js";
import { insertTextToken } from "../../src/utils/textVariables.js";
import {
  DEFAULT_UI_FONT_SCALE,
  UI_FONT_SCALE_MAX,
  UI_FONT_SCALE_MIN,
  normalizeUiFontScale,
} from "../../src/utils/uiPreferences.js";
import {
  TEXT_LABEL_ROLES,
  filterFillableLabelTexts,
  getFillableTextLabels,
  getTextLabelRole,
  isFillableTextLabel,
} from "../../src/utils/textLabelRoles.js";


const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}


test("canvas hover resolves the nearest selectable Konva ancestor", () => {
  const stage = {};
  const groupNode = {
    id: () => "group-family-a",
    getParent: () => stage,
  };
  const elementNode = {
    id: () => "text-label-42",
    getParent: () => groupNode,
  };
  const hitRect = {
    id: () => "",
    getParent: () => elementNode,
    getStage: () => stage,
  };

  assert.deepEqual(getCanvasElementRefFromTarget(hitRect), { type: "text", id: "label-42" });
  assert.deepEqual(getCanvasElementRefFromTarget(groupNode, stage), { type: "group", id: "family-a" });
  assert.equal(getCanvasElementRefFromTarget(stage, stage), null);
});


test("API URL builders keep route contracts stable", () => {
  assert.equal(buildTemplatePagePreviewUrl(1, 2), "/api/templates/1/pages/2/preview");
  assert.equal(buildTemplateSpreadPreviewUrl(1, 0), "/api/templates/1/spread-preview/0");
  assert.equal(buildStickerUrl(1, "star.png"), "/api/templates/1/stickers/star.png");
  assert.equal(buildProjectPagePreviewUrl(3, 0), "/api/projects/3/preview/0");
  assert.equal(buildStudentPagePreviewUrl(3, 4, 1), "/api/projects/3/students/4/preview/1");
  assert.equal(buildPhotoUrl(3, 4, 1, 9), "/api/projects/3/students/4/pages/1/photos/9");
  assert.equal(buildPhotoUrl(3, 4, 1, 9, "path/with space.png"), "/api/projects/3/students/4/pages/1/photos/9?v=path%2Fwith%20space.png");
  assert.equal(buildPhotoThumbnailUrl(3, 4, 1, 9), "/api/projects/3/students/4/pages/1/photos/9/thumbnail");
  assert.equal(buildPhotoThumbnailUrl(3, 4, 1, 9, "rev-2"), "/api/projects/3/students/4/pages/1/photos/9/thumbnail?v=rev-2");
  assert.equal(buildDownloadPdfUrl(3, 4), "/api/projects/3/students/4/pdf?mode=print");
  assert.equal(buildDownloadPdfUrl(3, 4, "screen"), "/api/projects/3/students/4/pdf?mode=screen");
  assert.equal(buildDownloadImagesZipUrl(3, 4), "/api/projects/3/students/4/images?mode=print");
  assert.equal(buildDownloadImagesZipUrl(3, 4, "screen"), "/api/projects/3/students/4/images?mode=screen");
  assert.equal(buildDownloadImageUrl(3, 4, 2), "/api/projects/3/students/4/images/2?mode=print");
  assert.equal(buildDownloadImageUrl(3, 4, 2, "screen"), "/api/projects/3/students/4/images/2?mode=screen");
  assert.equal(buildDownloadAllZipUrl(3, "screen"), "/api/projects/3/download/all?mode=screen");
  assert.equal(buildDownloadAllImagesZipUrl(3), "/api/projects/3/download/all/images?mode=print");
  assert.equal(buildDownloadAllImagesZipUrl(3, "screen"), "/api/projects/3/download/all/images?mode=screen");
});


test("browser file helpers normalize API paths and download filenames", () => {
  assert.equal(getApiPath("/api/projects/1/download"), "/projects/1/download");
  assert.equal(getApiPath("/projects/1/download"), "/projects/1/download");
  assert.equal(
    getFilenameFromDisposition("attachment; filename*=UTF-8''%E7%9B%B8%E5%86%8A.jpg", "fallback.jpg"),
    "相冊.jpg",
  );
  assert.equal(
    getFilenameFromDisposition('attachment; filename="album.jpg"', "fallback.jpg"),
    "album.jpg",
  );
  assert.equal(getFilenameFromDisposition("", "fallback.jpg"), "fallback.jpg");
  assert.equal(isMobileDevice(), false);
});


test("photo utilities normalize records and build slot items", () => {
  assert.deepEqual(normalizePhotoData(null), null);
  assert.deepEqual(normalizePhotoData("projects/p.jpg"), {
    path: "projects/p.jpg",
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    brightness: 1.0,
    contrast: 1.0,
  });
  assert.deepEqual(normalizePhotoData({ path: "projects/p.jpg", scale: 1.4, offset_x: -0.2, offset_y: 0.3 }), {
    path: "projects/p.jpg",
    scale: 1.4,
    offsetX: -0.2,
    offsetY: 0.3,
    brightness: 1.0,
    contrast: 1.0,
  });
  assert.deepEqual(
    normalizePhotoData({ path: "projects/p.jpg", scale: 1, offset_x: 0, offset_y: 0, brightness: 1.3, contrast: 0.9 }),
    { path: "projects/p.jpg", scale: 1, offsetX: 0, offsetY: 0, brightness: 1.3, contrast: 0.9 },
  );

  const items = buildItems(
    [
      { pi: 0, slotId: 1, slotIndex: 0, slotW: 320, slotH: 240, border: true, borderW: 10 },
      { pi: 1, slotId: 2, slotIndex: 0 },
    ],
    {
      pages_data: [
        {
          page_index: 0,
          photos: {
            "1": { path: "projects/p.jpg", scale: 1.2, offset_x: 0.1, offset_y: -0.1 },
          },
        },
      ],
    },
  );

  assert.equal(items[0].serverPath, "projects/p.jpg");
  assert.deepEqual(items[0].transform, { scale: 1.2, offsetX: 0.1, offsetY: -0.1, brightness: 1.0, contrast: 1.0 });
  assert.equal(items[0].slotW, 320);
  assert.equal(items[0].border, true);
  assert.equal(items[1].serverPath, null);
  assert.deepEqual(items[1].transform, { scale: 1.0, offsetX: 0, offsetY: 0, brightness: 1.0, contrast: 1.0 });
});


test("photo sizing cover-fits the crop box and clamps visible overflow", () => {
  assert.deepEqual(photoDims(100, 100, 2, 1), { w: 200, h: 100 });
  assert.deepEqual(photoDims(100, 100, 0.5, 1), { w: 100, h: 200 });
  assert.deepEqual(photoDims(200, 100, 1.5, 1), { w: 200, h: 133.33333333333334 });
  assert.deepEqual(photoDims(100, 200, 0.75, 1), { w: 150, h: 200 });
  assert.deepEqual(clampPan(200, -200, 100, 100, 2, 1), { panX: 50, panY: -0 });
  assert.deepEqual(clampPan(-200, 200, 100, 100, 0.5, 1), { panX: -0, panY: 50 });
  assert.deepEqual(clampPan(200, 200, 200, 100, 1.5, 1), { panX: 0, panY: 16.66666666666667 });
});


test("photo crop boxes match backend bordered slot geometry", () => {
  assert.deepEqual(getPhotoCropBox({ slotW: 150, slotH: 120, border: true, borderW: 8 }), {
    x: 8,
    y: 8,
    right: 8,
    bottom: 24,
    width: 134,
    height: 88,
  });
  assert.deepEqual(getPhotoCropBox({ slotW: 150, slotH: 120, border: false, borderW: 8 }), {
    x: 0,
    y: 0,
    right: 0,
    bottom: 0,
    width: 150,
    height: 120,
  });
});


test("photo frame geometry supports migrated content-box layouts", () => {
  const frameSlot = { x: 40, y: 52, width: 150, height: 120, border: true, border_width: 8 };
  const contentRect = getPhotoContentRect(frameSlot);
  assert.deepEqual(contentRect, { x: 48, y: 60, width: 134, height: 88 });

  const contentSlot = {
    ...contentRect,
    border: true,
    border_width: 8,
    dimensionMode: PHOTO_SLOT_CONTENT_BOX_MODE,
  };
  assert.deepEqual(getPhotoFrameRect(contentSlot), { x: 40, y: 52, width: 150, height: 120 });
  assert.deepEqual(getPhotoCropBox({
    slotW: contentRect.width,
    slotH: contentRect.height,
    border: true,
    borderW: 8,
    dimensionMode: PHOTO_SLOT_CONTENT_BOX_MODE,
  }), {
    x: 8,
    y: 8,
    right: 8,
    bottom: 24,
    width: 134,
    height: 88,
  });
});


test("photo matcher maps filenames to explicit page-slot targets", () => {
  const students = [
    { id: 1, name: "王小明", order_index: 0 },
    { id: 2, name: "小明", order_index: 1 },
    { id: 3, name: "陳美花", order_index: 2 },
  ];
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1-1.jpg"),
    file("王小明1-2.heic"),
    file("小明2-1.png"),
    file("王小明9-9.jpg"),
    file("阿華1-1.jpg"),
  ];

  const result = matchByNamePageSlot(students, files, pages);
  assert.deepEqual(
    result.assignments.map(({ studentId, pageIndex, slotId, file }) => `${studentId}:${pageIndex}:${slotId}:${file.name}`),
    [
      "1:0:101:王小明1-1.jpg",
      "1:0:102:王小明1-2.heic",
      "2:1:201:小明2-1.png",
    ],
  );
  assert.deepEqual(result.unmatched, [3]);
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明9-9.jpg:找不到對應照片格",
    "阿華1-1.jpg:找不到學生姓名",
  ]);
  assert.deepEqual(result.unused.map((item) => item.name), ["王小明9-9.jpg", "阿華1-1.jpg"]);
});


test("photo matcher maps filenames to global slot sequence targets", () => {
  const students = [
    { id: 1, name: "王小明", order_index: 0 },
    { id: 2, name: "小明", order_index: 1 },
  ];
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1.jpg"),
    file("王小明02.jpg"),
    file("小明3.png"),
    file("王小明01.heic"),
    file("小明4.jpg"),
  ];

  const result = matchByNameSlotSequence(students, files, pages);
  assert.deepEqual(
    result.assignments.map(({ studentId, pageIndex, slotId, file }) => `${studentId}:${pageIndex}:${slotId}:${file.name}`),
    [
      "1:0:101:王小明1.jpg",
      "1:0:102:王小明02.jpg",
      "2:1:201:小明3.png",
    ],
  );
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明01.heic:同一學生同一格重複配對",
    "小明4.jpg:找不到對應照片格",
  ]);
  assert.deepEqual(result.unused.map((item) => item.name), ["王小明01.heic", "小明4.jpg"]);
});


test("photo matcher maps personal multi-upload filenames by numeric suffix only", () => {
  const pages = [
    { layout: { photo_slots: [{ id: 101 }, { id: 102 }] } },
    { layout: { photo_slots: [{ id: 201 }] } },
  ];
  const file = (name) => ({ name });
  const files = [
    file("王小明1-2.jpg"),
    file("王小明3.heic"),
    file("1-1.png"),
    file("生活照.jpg"),
    file("王小明.jpg"),
    file("王小明4.jpg"),
  ];

  const result = matchPersonalFilesToSlots(files, pages);
  assert.deepEqual(
    result.assignments.map(({ pageIndex, slotId, file }) => `${pageIndex}:${slotId}:${file.name}`),
    [
      "0:102:王小明1-2.jpg",
      "1:201:王小明3.heic",
      "0:101:1-1.png",
    ],
  );
  assert.deepEqual(result.unused.map((item) => item.name), ["生活照.jpg", "王小明.jpg"]);
  assert.deepEqual(result.invalid.map(({ file, reason }) => `${file.name}:${reason}`), [
    "王小明4.jpg:找不到對應照片格",
  ]);
});


test("render layout coordinate helpers keep the A4 display scale stable", () => {
  assert.equal(CANVAS_DISPLAY_WIDTH, 530);
  assert.equal(CANVAS_REAL_WIDTH, 794);
  assert.equal(toDisplayCoord(794), 530);
  assert.equal(toRealCoord(530), 794);
});


test("sticker initial sizing preserves uploaded image aspect ratio", () => {
  assert.deepEqual(getInitialStickerSize(600, 300), { width: 150, height: 75 });
  assert.deepEqual(getInitialStickerSize(300, 600), { width: 75, height: 150 });
  assert.deepEqual(getInitialStickerSize(120, 120), { width: 150, height: 150 });
  assert.deepEqual(getInitialStickerSize(null, 0), { width: 150, height: 150 });
});


test("render layout sorting applies default z-index bands and explicit overrides", () => {
  const layout = {
    photo_slots: [{ id: 1 }, { id: 2, z_index: 250 }],
    text_labels: [{ id: 4 }],
    stickers: [{ id: 5, z_index: 10 }],
  };

  assert.deepEqual(
    getAllElementsSorted(layout).map(element => `${element.type}:${element.data.id}`),
    ["photo:1", "sticker:5", "text:4", "photo:2"],
  );
  assert.equal(getNextZIndex(layout), 251);
});


test("render layout updates and display models stay stable", () => {
  const layout = {
    photo_slots: [{ id: 1, x: 48, y: 96, width: 240, height: 180, border_width: 8 }],
    text_labels: [{ id: 3, x: 96, y: 340, width: 360, height: 96, text: "Label" }],
    stickers: [],
    footer: { text: "Footer" },
  };

  const next = applyElementsToLayout(layout, [{ type: "text", data: { ...layout.text_labels[0], x: 99 } }]);
  assert.equal(next.text_labels[0].x, 99);
  assert.equal(next.photo_slots[0].x, 48);

  const box = getDisplayBox(layout.photo_slots[0]);
  const model = buildRenderLayoutModel(layout, 1);
  assert.equal(box.centerX, toDisplayCoord(168));
  assert.deepEqual(model.elements.map(element => element.type), ["photo", "text", "footer"]);
  assert.equal(model.elements[0].placeholderText, "P2·1");
  assert.equal(model.elements[1].text, "Label");
  assert.equal(model.elements[1].textRole, TEXT_LABEL_ROLES.FILLABLE);
  assert.equal(model.elements[1].isFillable, true);
  assert.equal(model.elements[2].text, "Footer");
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


test("render placeholders number only visible photo slots in collection order", () => {
  const layout = {
    photo_slots: [
      { id: "hidden", visible: false, x: 0, y: 0, width: 80, height: 60, z_index: 0 },
      { id: "second", x: 100, y: 0, width: 80, height: 60, z_index: 20 },
      { id: "first", x: 200, y: 0, width: 80, height: 60, z_index: 10 },
    ],
    text_labels: [],
    stickers: [],
  };

  const model = buildRenderLayoutModel(layout, 0);
  assert.deepEqual(
    model.elements.map(element => [element.id, element.placeholderText]),
    [["first", "P1·2"], ["second", "P1·1"]],
  );
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


test("selection alignment uses rotated axis-aligned bounds", () => {
  const layout = {
    stickers: [
      { id: "anchor", x: 0, y: 0, width: 20, height: 20, rotation: 0 },
      { id: "rotated", x: 100, y: 0, width: 40, height: 20, rotation: 90 },
    ],
  };
  const refs = [
    { type: "sticker", id: "anchor" },
    { type: "sticker", id: "rotated" },
  ];

  assert.equal(getAxisAlignedNodeBounds(layout, refs[1]).left, 110);
  const aligned = alignLayoutNodes(layout, refs, "left");
  assert.equal(getLayoutNodeData(aligned, refs[0]).x, 0);
  assert.equal(getLayoutNodeData(aligned, refs[1]).x, -10);
  assert.equal(getAxisAlignedNodeBounds(aligned, refs[0]).left, 0);
  assert.equal(Math.abs(getAxisAlignedNodeBounds(aligned, refs[1]).left), 0);
});


test("selection distribution gives three objects equal edge gaps", () => {
  const layout = {
    text_labels: [
      { id: "first", x: 0, y: 10, width: 10, height: 20 },
      { id: "middle", x: 30, y: 10, width: 20, height: 20 },
      { id: "last", x: 100, y: 10, width: 30, height: 20 },
    ],
  };
  const refs = ["first", "middle", "last"].map(id => ({ type: "text", id }));
  const distributed = distributeLayoutNodes(layout, refs, "horizontal");
  const bounds = refs.map(ref => getAxisAlignedNodeBounds(distributed, ref));

  assert.deepEqual(bounds.map(item => item.left), [0, 45, 100]);
  assert.equal(bounds[1].left - bounds[0].right, 35);
  assert.equal(bounds[2].left - bounds[1].right, 35);
});


test("selection operations leave the whole selection unchanged when a node is hidden or locked", () => {
  const hiddenLayout = {
    stickers: [
      { id: "visible", x: 0, y: 0, width: 20, height: 20 },
      { id: "hidden", x: 100, y: 0, width: 20, height: 20, visible: false },
    ],
  };
  const hiddenRefs = [
    { type: "sticker", id: "visible" },
    { type: "sticker", id: "hidden" },
  ];
  assert.equal(alignLayoutNodes(hiddenLayout, hiddenRefs, "left"), hiddenLayout);

  const lockedLayout = {
    text_labels: [
      { id: "first", x: 0, y: 0, width: 20, height: 20 },
      { id: "middle", x: 40, y: 0, width: 20, height: 20, locked: true },
      { id: "last", x: 100, y: 0, width: 20, height: 20 },
    ],
  };
  const lockedRefs = ["first", "middle", "last"].map(id => ({ type: "text", id }));
  assert.equal(distributeLayoutNodes(lockedLayout, lockedRefs, "horizontal"), lockedLayout);
  assert.deepEqual(lockedLayout.text_labels.map(item => item.x), [0, 40, 100]);
});


test("matching selection size accepts only compatible visible unlocked leaf types", () => {
  const layout = {
    photo_slots: [
      { id: "wide-a", width: 400, height: 200 },
      { id: "wide-b", width: 200, height: 100 },
      { id: "square", width: 100, height: 100 },
      { id: "locked-wide", width: 300, height: 150, locked: true },
    ],
    text_labels: [
      { id: "text-a", width: 100, height: 40 },
      { id: "text-b", width: 200, height: 90 },
      { id: "hidden-text", width: 100, height: 40, visible: false },
    ],
    stickers: [{ id: "sticker", width: 100, height: 40 }],
  };
  const ref = (type, id) => ({ type, id });

  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("text", "text-b")]), true);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "wide-b")]), true);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "square")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("sticker", "sticker")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("text", "hidden-text")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "locked-wide")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("group", "one"), ref("group", "two")]), false);
});


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
    const { z_index: ignored, ...stable } = element;
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
    const { z_index: ignored, ...stable } = element;
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


test("text label roles keep static labels out of fillable payloads", () => {
  const layout = {
    text_labels: [
      { id: 1, text: "Old label without role" },
      { id: 2, text: "Fixed heading", text_role: TEXT_LABEL_ROLES.STATIC },
      { id: 3, text: "Legacy locked label", editable: false },
    ],
  };

  assert.equal(getTextLabelRole(layout.text_labels[0]), TEXT_LABEL_ROLES.FILLABLE);
  assert.equal(getTextLabelRole(layout.text_labels[1]), TEXT_LABEL_ROLES.STATIC);
  assert.equal(isFillableTextLabel(layout.text_labels[2]), false);
  assert.deepEqual(getFillableTextLabels(layout).map(label => label.id), [1]);
  assert.deepEqual(
    filterFillableLabelTexts(layout.text_labels, { 1: "Class text", 2: "Ignored", 3: "Ignored" }),
    { 1: "Class text" },
  );
});


test("text variable insertion respects caret and selected ranges", () => {
  assert.deepEqual(insertTextToken("今天很棒", 2, 2), { text: "今天{name}很棒", caret: 8 });
  assert.deepEqual(insertTextToken("姓名：___", 3, 6), { text: "姓名：{name}", caret: 9 });
  assert.deepEqual(insertTextToken("開頭", undefined, undefined), { text: "開頭{name}", caret: 8 });
});


test("UI font scale settings clamp to the supported range", () => {
  assert.equal(normalizeUiFontScale("bad"), DEFAULT_UI_FONT_SCALE);
  assert.equal(normalizeUiFontScale(0.5), UI_FONT_SCALE_MIN);
  assert.equal(normalizeUiFontScale(2), UI_FONT_SCALE_MAX);
  assert.equal(normalizeUiFontScale(1.126), 1.13);
});


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


let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
