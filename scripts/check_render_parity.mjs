import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  CANVAS_REAL_HEIGHT,
  CANVAS_REAL_WIDTH,
  buildRenderLayoutModel,
  toDisplayCoord,
} from "../frontend/src/utils/renderLayoutModel.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(repoRoot, "tests/fixtures/render_smoke_layout.json");
const layout = JSON.parse(await readFile(fixturePath, "utf8"));
const tokenFixturePath = resolve(
  repoRoot,
  "tests/fixtures/template_text_variable_parity.json",
);
const tokenLayout = JSON.parse(await readFile(tokenFixturePath, "utf8"));

function assertClose(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);
}

function assertPointInside(point, box) {
  assert.ok(point.x >= box.x, `${point.x} < ${box.x}`);
  assert.ok(point.y >= box.y, `${point.y} < ${box.y}`);
  assert.ok(point.x <= box.x + box.width, `${point.x} > ${box.x + box.width}`);
  assert.ok(point.y <= box.y + box.height, `${point.y} > ${box.y + box.height}`);
}

assert.equal(layout.canvas_width, CANVAS_REAL_WIDTH);
assert.equal(layout.canvas_height, CANVAS_REAL_HEIGHT);

const model = buildRenderLayoutModel(layout, 0);

assert.equal(model.stage.width, CANVAS_DISPLAY_WIDTH);
assert.equal(model.stage.height, CANVAS_DISPLAY_HEIGHT);
assertClose(model.stage.scale, CANVAS_DISPLAY_WIDTH / CANVAS_REAL_WIDTH);

assert.deepEqual(model.elements.map(element => element.type), ["photo", "text", "footer"]);

const [photo, text, footer] = model.elements;
assert.equal(photo.innerFill, "#EEEEEE");
assert.equal(photo.placeholderText, "P1·1");
assertPointInside({ x: toDisplayCoord(55), y: toDisplayCoord(67) }, photo.innerBox);

assert.equal(text.text, "Default label");
assert.equal(text.fontColor, "#1F2937");
assert.equal(text.align, "center");
assertPointInside({ x: toDisplayCoord(180), y: toDisplayCoord(292) }, text.box);

assert.equal(footer.text, "Footer for （相本稱呼）");
assert.equal(footer.fontColor, "#2563EB");
assertPointInside({ x: toDisplayCoord(70), y: toDisplayCoord(1080) }, footer.box);

const tokenModel = buildRenderLayoutModel(tokenLayout, 0);
const tokenText = tokenModel.elements.find(element => element.type === "text");
const tokenFooter = tokenModel.elements.find(element => element.type === "footer");
assert.equal(tokenText.text, tokenLayout.expected_text_label);
assert.equal(tokenFooter.text, tokenLayout.expected_footer);
assert.ok(!tokenText.text.includes("{name}"));
assert.ok(!tokenText.text.includes("{full_name}"));
assert.ok(!tokenFooter.text.includes("{name}"));
assert.ok(!tokenFooter.text.includes("{full_name}"));

console.log("render parity fixtures match frontend stage model and template name tokens");
