import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  buildRenderLayoutModel,
  getAllElementsSorted,
  getFooterModel,
  toDisplayCoord,
} from "../frontend/src/utils/renderLayoutModel.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(resolve(repoRoot, "frontend/package.json"));
const { default: Konva } = await import(pathToFileURL(frontendRequire.resolve("konva")).href);
await import(pathToFileURL(frontendRequire.resolve("konva/canvas-backend")).href);

const fixturePath = resolve(repoRoot, "tests/fixtures/render_smoke_layout.json");
const layout = JSON.parse(await readFile(fixturePath, "utf8"));

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function assertPixelNear(canvas, realX, realY, expectedHex, tolerance = 4) {
  const x = Math.round(toDisplayCoord(realX));
  const y = Math.round(toDisplayCoord(realY));
  const [r, g, b] = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
  const [er, eg, eb] = hexToRgb(expectedHex);
  assert.ok(
    Math.abs(r - er) <= tolerance && Math.abs(g - eg) <= tolerance && Math.abs(b - eb) <= tolerance,
    `pixel ${x},${y} was rgb(${r}, ${g}, ${b}), expected ${expectedHex}`,
  );
}

function countNonWhitePixels(canvas, realBox) {
  const x = Math.round(toDisplayCoord(realBox.x));
  const y = Math.round(toDisplayCoord(realBox.y));
  const width = Math.max(1, Math.round(toDisplayCoord(realBox.width)));
  const height = Math.max(1, Math.round(toDisplayCoord(realBox.height)));
  const data = canvas.getContext("2d").getImageData(x, y, width, height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) count += 1;
  }
  return count;
}

function makeGroup(box) {
  return new Konva.Group({
    x: box.centerX,
    y: box.centerY,
    offsetX: box.offsetX,
    offsetY: box.offsetY,
    width: box.width,
    height: box.height,
    rotation: box.rotation,
    listening: false,
  });
}

function addPhotoSlot(layer, data, elemIndex, pageIndex) {
  const model = buildRenderLayoutModel({ photo_slots: [data] }, pageIndex).elements[0];
  const group = makeGroup(model.box);
  const hasBorder = data.border !== false;
  const borderWidth = toDisplayCoord(data.border_width ?? 8);

  group.add(new Konva.Rect({
    width: model.box.width,
    height: model.box.height,
    fill: hasBorder ? "#ffffff" : "#EEEEEE",
    stroke: hasBorder ? "#e2e8f0" : "#CCCCCC",
    strokeWidth: 1,
    listening: false,
  }));

  if (hasBorder) {
    group.add(new Konva.Rect({
      x: borderWidth,
      y: borderWidth,
      width: Math.max(1, model.box.width - borderWidth * 2),
      height: Math.max(1, model.box.height - borderWidth * 4),
      fill: "#EEEEEE",
      listening: false,
    }));
  }

  group.add(new Konva.Text({
    x: 0,
    y: 0,
    width: model.box.width,
    height: model.box.height,
    text: `P${pageIndex + 1}·${elemIndex + 1}`,
    fontSize: 10,
    fill: "#AAAAAA",
    align: "center",
    verticalAlign: "middle",
    listening: false,
  }));
  layer.add(group);
}

function addBubble(layer, data) {
  const model = buildRenderLayoutModel({ text_bubbles: [data] }).elements[0];
  const group = makeGroup(model.box);
  const radius = data.border_radius != null
    ? toDisplayCoord(data.border_radius)
    : Math.round(Math.min(model.box.width, model.box.height) / 5);

  group.add(new Konva.Rect({
    width: model.box.width,
    height: model.box.height,
    fill: model.fill,
    stroke: data.border_color,
    strokeWidth: model.borderWidth,
    cornerRadius: radius,
    listening: false,
  }));
  group.add(new Konva.Text({
    x: 4,
    y: 4,
    width: model.box.width - 8,
    height: model.box.height - 8,
    text: model.text,
    fontSize: model.fontSize,
    fill: model.fontColor,
    align: "center",
    verticalAlign: "middle",
    wrap: "word",
    listening: false,
  }));
  layer.add(group);
}

function addTextLabel(layer, data) {
  const model = buildRenderLayoutModel({ text_labels: [data] }).elements[0];
  const group = makeGroup(model.box);
  group.add(new Konva.Rect({
    width: model.box.width,
    height: model.box.height,
    fill: "transparent",
    stroke: "#AAAAAA",
    strokeWidth: 1,
    dash: [4, 3],
    listening: false,
  }));
  group.add(new Konva.Text({
    x: 4,
    y: 0,
    width: model.box.width - 8,
    height: model.box.height,
    text: model.text,
    fontSize: model.fontSize,
    fill: model.fontColor,
    align: model.align,
    verticalAlign: "middle",
    wrap: "word",
    lineHeight: model.lineHeight,
    listening: false,
  }));
  layer.add(group);
}

function addFooter(layer, footer) {
  if (!footer?.text) return;
  const model = getFooterModel(footer);
  layer.add(new Konva.Text({
    x: model.box.x,
    y: model.box.y,
    width: model.box.width,
    height: model.box.height,
    text: model.text,
    fontSize: model.fontSize,
    fill: model.fontColor,
    verticalAlign: "middle",
    listening: false,
  }));
}

const stage = new Konva.Stage({ width: CANVAS_DISPLAY_WIDTH, height: CANVAS_DISPLAY_HEIGHT });
const layer = new Konva.Layer();
stage.add(layer);
layer.add(new Konva.Rect({
  x: 0,
  y: 0,
  width: CANVAS_DISPLAY_WIDTH,
  height: CANVAS_DISPLAY_HEIGHT,
  fill: "#ffffff",
  listening: false,
}));

for (const { type, data, index } of getAllElementsSorted(layout)) {
  if (type === "photo") addPhotoSlot(layer, data, index, 0);
  if (type === "bubble") addBubble(layer, data);
  if (type === "text") addTextLabel(layer, data);
}
addFooter(layer, layout.footer);
layer.draw();

const canvas = stage.toCanvas({ pixelRatio: 1 });
assert.equal(canvas.width, CANVAS_DISPLAY_WIDTH);
assert.equal(canvas.height, CANVAS_DISPLAY_HEIGHT);

assertPixelNear(canvas, 55, 67, "#EEEEEE");
assertPixelNear(canvas, 308, 70, "#FDE68A");
assert.ok(countNonWhitePixels(canvas, { x: 58, y: 250, width: 300, height: 82 }) > 20);
assert.ok(countNonWhitePixels(canvas, { x: 36, y: 1058, width: 250, height: 44 }) > 10);

console.log("render parity fixture draws expected Konva canvas regions");
