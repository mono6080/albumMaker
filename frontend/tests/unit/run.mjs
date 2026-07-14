import assert from "node:assert/strict";

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
  GROUP_CONTRACT,
  LayoutGroupError,
  addElementToGroup,
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  getFlattenedRenderElements,
  getGroupById,
  getGroupBounds,
  getGroupForElement,
  groupElements,
  linkMaterialText,
  moveGroup,
  projectNormalizedBoxToSticker,
  reorderGroupChild,
  reorderRootNode,
  rotateGroup,
  scaleGroupUniform,
  ungroupElements,
  unlinkMaterialText,
  validateLayoutGroups,
} from "../../src/utils/layoutGroups.js";
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
    text_bubbles: [{ id: 3 }],
    text_labels: [{ id: 4 }],
    stickers: [{ id: 5, z_index: 10 }],
  };

  assert.deepEqual(
    getAllElementsSorted(layout).map(element => `${element.type}:${element.data.id}`),
    ["photo:1", "sticker:5", "bubble:3", "text:4", "photo:2"],
  );
  assert.equal(getNextZIndex(layout), 251);
});


test("render layout updates and display models stay stable", () => {
  const layout = {
    photo_slots: [{ id: 1, x: 48, y: 96, width: 240, height: 180, border_width: 8 }],
    text_bubbles: [{ id: 2, x: 20 }],
    text_labels: [{ id: 3, x: 96, y: 340, width: 360, height: 96, text: "Label" }],
    stickers: [],
    footer: { text: "Footer" },
  };

  const next = applyElementsToLayout(layout, [{ type: "bubble", data: { id: 2, x: 99 } }]);
  assert.equal(next.text_bubbles[0].x, 99);
  assert.equal(next.photo_slots[0].x, 48);

  const box = getDisplayBox(layout.photo_slots[0]);
  const model = buildRenderLayoutModel(layout, 1);
  assert.equal(box.centerX, toDisplayCoord(168));
  assert.deepEqual(model.elements.map(element => element.type), ["photo", "bubble", "text", "footer"]);
  assert.equal(model.elements[0].placeholderText, "P2·1");
  assert.equal(model.elements[2].text, "Label");
  assert.equal(model.elements[2].textRole, TEXT_LABEL_ROLES.FILLABLE);
  assert.equal(model.elements[2].isFillable, true);
  assert.equal(model.elements[3].text, "Footer");
});


test("group traversal keeps legacy order and renders grouped children exactly once in ref order", () => {
  const legacy = {
    photo_slots: [{ id: "photo", z_index: 0 }],
    text_bubbles: [{ id: "bubble", z_index: 30 }],
    text_labels: [{ id: "text", z_index: 12 }],
    stickers: [
      { id: "sticker", z_index: 10 },
      { id: "outside", z_index: 40 },
    ],
  };
  assert.deepEqual(
    buildRootRenderNodes(legacy).map(node => node.type + ":" + node.id),
    ["photo:photo", "sticker:sticker", "text:text", "bubble:bubble", "sticker:outside"],
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
    ["photo:photo", "group:group", "bubble:bubble", "sticker:outside"],
  );
  const flattened = getFlattenedRenderElements(grouped);
  assert.deepEqual(
    flattened.map(node => node.type + ":" + node.id),
    ["photo:photo", "text:text", "sticker:sticker", "bubble:bubble", "sticker:outside"],
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


test("group and ungroup preserve child geometry, style, path, and effective stacking", () => {
  const layout = {
    photo_slots: [],
    text_bubbles: [{ id: "outside", z_index: 12 }],
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
      path: "templates/t/stickers/bubble.png",
      filename: "bubble.png",
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
    text_bubbles: [],
    text_labels: [{ id: "text", z_index: 2 }],
    stickers: [{ id: "sticker", z_index: 0 }],
  };
  const nonAdjacentOriginal = structuredClone(nonAdjacent);
  assert.throws(
    () => groupElements(nonAdjacent, [
      { type: "sticker", id: "sticker" },
      { type: "text", id: "text" },
    ], { groupId: "group" }),
    /不相鄰/,
  );
  assert.deepEqual(nonAdjacent, nonAdjacentOriginal);
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
    }],
    text_bubbles: [{
      id: "bubble",
      z_index: 3,
      x: 20,
      y: 30,
      width: 120,
      height: 60,
      text: "outside",
    }],
    stickers: [{
      id: "sticker",
      z_index: 1,
      x: 80,
      y: 100,
      width: 240,
      height: 90,
      rotation: 15,
      path: "templates/t/stickers/bubble.png",
      filename: "bubble.png",
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

  const linked = linkMaterialText(layout, {
    materialId: "sticker",
    textId: "text",
    groupId: "group",
  });
  assert.deepEqual(layout, original);
  assert.deepEqual(linked.groups[0].links, [{
    kind: "material-text-v1",
    material_id: "sticker",
    text_id: "text",
  }]);
  assert.deepEqual(
    buildRootRenderNodes(linked).map(node => node.type + ":" + node.id),
    ["photo:photo", "group:group", "bubble:bubble"],
  );
  assert.deepEqual(withoutZ(linked.stickers[0]), withoutZ(layout.stickers[0]));
  assert.deepEqual(withoutZ(linked.text_labels[0]), withoutZ(layout.text_labels[0]));

  const rootReordered = reorderRootNode(linked, { type: "group", id: "group" }, 2);
  assert.deepEqual(
    buildRootRenderNodes(rootReordered).map(node => node.type + ":" + node.id),
    ["photo:photo", "bubble:bubble", "group:group"],
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
  assert.deepEqual(childReordered.groups[0].links, rootReordered.groups[0].links);
  assert.deepEqual(
    getFlattenedRenderElements(childReordered).map(node => node.type + ":" + node.id),
    ["photo:photo", "bubble:bubble", "text:text", "sticker:sticker"],
  );
  assert.deepEqual(childReordered.stickers[0], rootReordered.stickers[0]);
  assert.deepEqual(childReordered.text_labels[0], rootReordered.text_labels[0]);

  const unlinked = unlinkMaterialText(childReordered, {
    materialId: "sticker",
    textId: "text",
  });
  assert.deepEqual(unlinked.groups[0].links, []);
  assert.deepEqual(unlinked.groups[0].children, childReordered.groups[0].children);
  assert.deepEqual(unlinked.stickers, childReordered.stickers);
  assert.deepEqual(unlinked.text_labels, childReordered.text_labels);
  const relinked = linkMaterialText(unlinked, {
    materialId: "sticker",
    textId: "text",
  });
  assert.equal(relinked.groups[0].links.length, 1);
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
    ["photo:photo", "bubble:bubble", "text:text"],
  );
  assert.equal(relinked.stickers.length, 1);
  assert.equal(relinked.groups.length, 1);

  const afterGroupDelete = deleteLayoutGroup(relinked, "group");
  assert.equal(afterGroupDelete.groups, undefined);
  assert.equal(afterGroupDelete.stickers.length, 0);
  assert.equal(afterGroupDelete.text_labels.length, 0);
  assert.deepEqual(withoutZ(afterGroupDelete.photo_slots[0]), withoutZ(layout.photo_slots[0]));
  assert.deepEqual(withoutZ(afterGroupDelete.text_bubbles[0]), withoutZ(layout.text_bubbles[0]));

  const threeChildLayout = {
    photo_slots: [],
    text_bubbles: [],
    stickers: [{
      id: "sticker",
      z_index: 0,
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      path: "templates/t/stickers/bubble.png",
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
  assert.deepEqual(afterLinkedTextDelete.groups[0].links, []);
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
    ...layout.groups[0],
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
  assert.equal(scaled.text_labels[0].font_size, 30);
  assert.equal(scaled.text_labels[0].letter_spacing, 1.8);
  assert.equal(scaled.text_labels[0].line_height, 1.4);
  assert.equal(scaled.text_labels[0].text_shadow_offset_x, 3);
  assert.equal(scaled.text_labels[0].text_shadow_offset_y, -4.5);
  assert.equal(scaled.text_labels[0].text_shadow_blur, 6);
  assert.deepEqual(freeRatioLayout.stickers[0], {
    ...layout.stickers[0],
    width: 120,
    height: 30,
  });
});


test("group scale preserves null and empty legacy style values while scaling numeric lengths", () => {
  const layout = {
    group_contract: GROUP_CONTRACT,
    stickers: [{
      id: "sticker",
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      rotation: 0,
      path: "templates/t/stickers/bubble.png",
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
  assert.equal(scaled.text_labels[0].font_size, 30);
  assert.equal(scaled.text_labels[0].letter_spacing, null);
  assert.equal(scaled.text_labels[0].text_shadow_offset_x, "");
  assert.equal(scaled.text_labels[0].text_shadow_offset_y, 3);
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
    path: "templates/t/stickers/bubble.png",
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
