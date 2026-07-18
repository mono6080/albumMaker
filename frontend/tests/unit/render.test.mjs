import assert from "node:assert/strict";
import { PHOTO_SCALE_MAX } from "../../src/constants/photoTransform.js";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  CANVAS_REAL_HEIGHT,
  CANVAS_REAL_WIDTH,
  CANVAS_SCENE_PIXEL_RATIO,
  applyElementsToLayout,
  buildRenderLayoutModel,
  getAllElementsSorted,
  getDisplayBox,
  getInitialStickerSize,
  getNextZIndex,
  toDisplayCoord,
  toRealCoord,
} from "../../src/utils/renderLayoutModel.js";
import { TEXT_LABEL_ROLES } from "../../src/utils/textLabelRoles.js";
import { test } from "./harness.mjs";


test("photo zoom maximum mirrors the shared design token", () => {
  assert.equal(PHOTO_SCALE_MAX, 3);
});


test("render layout coordinate helpers keep the A4 display scale stable", () => {
  assert.equal(CANVAS_DISPLAY_WIDTH, 530);
  assert.equal(CANVAS_REAL_WIDTH, 794);
  assert.equal(toDisplayCoord(794), 530);
  assert.equal(toRealCoord(530), 794);
  assert.ok(Math.abs(CANVAS_SCENE_PIXEL_RATIO - CANVAS_REAL_WIDTH / CANVAS_DISPLAY_WIDTH)
    <= Number.EPSILON);
  assert.equal(Math.trunc(CANVAS_DISPLAY_WIDTH * CANVAS_SCENE_PIXEL_RATIO), CANVAS_REAL_WIDTH);
  assert.equal(Math.trunc(CANVAS_DISPLAY_HEIGHT * CANVAS_SCENE_PIXEL_RATIO), CANVAS_REAL_HEIGHT);
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


test("template stage models resolve name tokens in labels and footer", () => {
  const model = buildRenderLayoutModel({
    photo_slots: [],
    text_labels: [{
      id: "token-label",
      x: 0,
      y: 0,
      width: 500,
      height: 100,
      text: "標題：{name}／{full_name}",
    }],
    stickers: [],
    footer: { text: "頁尾：{name}／{full_name}" },
  });

  assert.equal(model.elements[0].text, "標題：（相本稱呼）／（完整姓名）");
  assert.equal(model.elements[1].text, "頁尾：（相本稱呼）／（完整姓名）");
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
