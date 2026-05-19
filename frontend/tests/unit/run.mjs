import assert from "node:assert/strict";

import {
  buildDownloadAllImagesZipUrl,
  buildDownloadAllZipUrl,
  buildDownloadImageUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildPhotoUrl,
  buildProjectPagePreviewUrl,
  buildStickerUrl,
  buildStudentPagePreviewUrl,
  buildTemplatePagePreviewUrl,
  buildTemplateSpreadPreviewUrl,
} from "../../src/api/urls.js";
import { getApiPath, getFilenameFromDisposition, isMobileDevice } from "../../src/utils/browserFiles.js";
import { buildItems, clampPan, normalizePhotoData, photoDims } from "../../src/utils/photoUtils.js";
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
import { insertTextToken } from "../../src/utils/textVariables.js";
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
  });
  assert.deepEqual(normalizePhotoData({ path: "projects/p.jpg", scale: 1.4, offset_x: -0.2, offset_y: 0.3 }), {
    path: "projects/p.jpg",
    scale: 1.4,
    offsetX: -0.2,
    offsetY: 0.3,
  });

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
  assert.deepEqual(items[0].transform, { scale: 1.2, offsetX: 0.1, offsetY: -0.1 });
  assert.equal(items[0].slotW, 320);
  assert.equal(items[0].border, true);
  assert.equal(items[1].serverPath, null);
  assert.deepEqual(items[1].transform, { scale: 1.0, offsetX: 0, offsetY: 0 });
});


test("photo sizing cover-fills crop boxes and clamps visible overflow", () => {
  assert.deepEqual(photoDims(100, 100, 2, 1), { w: 200, h: 100 });
  assert.deepEqual(photoDims(100, 100, 0.5, 1), { w: 100, h: 200 });
  assert.deepEqual(clampPan(200, -200, 100, 100, 2, 1), { panX: 50, panY: -0 });
  assert.deepEqual(clampPan(-200, 200, 100, 100, 0.5, 1), { panX: -0, panY: 50 });
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
