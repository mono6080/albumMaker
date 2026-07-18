import assert from "node:assert/strict";
import { MAX_LABEL_TEXT_LENGTH } from "../../src/constants/textContent.js";
import {
  ALBUM_NAME_PREVIEW_PLACEHOLDER,
  FULL_NAME_PREVIEW_PLACEHOLDER,
  FULL_NAME_VARIABLE,
  NAME_VARIABLE,
  insertTextToken,
  replaceStudentNameVariables,
  resolveStudentNameVariables,
  resolveTemplatePreviewTextVariables,
} from "../../src/utils/textVariables.js";
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
import {
  getTextLabelRenderModel,
  getTemplateTextLabelRenderModel,
  measureTextLabelCjkCapacity,
} from "../../src/utils/textRenderModel.js";
import { test } from "./harness.mjs";

class CapacityKonvaText {
  constructor(props) {
    this.props = props;
    CapacityKonvaText.constructionCount += 1;
    const characterWidth = props.fontSize + (props.letterSpacing ?? 0);
    this.textArr = props.text
      ? [{ text: props.text, width: props.text.length * characterWidth }]
      : [];
  }

  destroy() {
    this.destroyed = true;
  }

  static constructionCount = 0;
}


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
  assert.deepEqual(
    insertTextToken("完整：", 3, 3, FULL_NAME_VARIABLE),
    { text: "完整：{full_name}", caret: 14 },
  );
});


test("student name variables use backend effective album name and replace every occurrence", () => {
  assert.equal(NAME_VARIABLE, "{name}");
  assert.equal(FULL_NAME_VARIABLE, "{full_name}");
  assert.equal(
    replaceStudentNameVariables(
      "{name}／{full_name}／{name}／{full_name}",
      { name: "王大明", album_name: "大明", effective_album_name: "大明" },
    ),
    "大明／王大明／大明／王大明",
  );
  assert.equal(
    replaceStudentNameVariables("{name}／{full_name}", { name: "完整姓名" }),
    "完整姓名／完整姓名",
  );
});


test("student name variables mirror backend raw, replacement, and final length limits", () => {
  const tokenCrossingRawLimit = `${"甲".repeat(197)}{name}`;
  assert.equal(
    resolveStudentNameVariables(tokenCrossingRawLimit, "完整姓名", "稱呼"),
    tokenCrossingRawLimit.slice(0, MAX_LABEL_TEXT_LENGTH),
  );

  const albumNameCrossingReplacementLimit = `${"甲".repeat(199)}{full_name}`;
  assert.equal(
    resolveStudentNameVariables("{name}", "完整姓名", albumNameCrossingReplacementLimit),
    `${"甲".repeat(199)}{`,
  );

  assert.equal(
    resolveStudentNameVariables(
      "{name}{full_name}",
      "乙".repeat(150),
      "甲".repeat(150),
    ),
    `${"甲".repeat(150)}${"乙".repeat(50)}`,
  );
  assert.equal(
    resolveStudentNameVariables("{name}", "完整姓名", "😀".repeat(201)),
    "😀".repeat(MAX_LABEL_TEXT_LENGTH),
  );
  assert.equal(resolveStudentNameVariables(null, "完整姓名", "稱呼"), "");
});


test("template Canvas name variables use the backend preview placeholders", () => {
  const rawText = "標題：{name}／{full_name}／{name}";
  const expected = "標題：（相本稱呼）／（完整姓名）／（相本稱呼）";

  assert.equal(ALBUM_NAME_PREVIEW_PLACEHOLDER, "（相本稱呼）");
  assert.equal(FULL_NAME_PREVIEW_PLACEHOLDER, "（完整姓名）");
  assert.equal(resolveTemplatePreviewTextVariables(rawText), expected);
  assert.equal(
    getTemplateTextLabelRenderModel({
      width: 500,
      height: 100,
      text: rawText,
    }).text,
    expected,
  );
});


test("label text length mirrors the shared design token", () => {
  assert.equal(MAX_LABEL_TEXT_LENGTH, 200);
});


test("text render model keeps canonical frame, full text, and declared typography", () => {
  const text = "這是一段超過六十個字的文字，用來確認編輯器不再截斷內容，並且使用原始文字框寬度和字級進行排版。"
    + "The complete tail must stay visible to the layout engine.";
  const model = getTextLabelRenderModel({
    width: 183.75,
    height: 91.5,
    text,
    font_size: 10,
    line_height: 1.3,
    letter_spacing: 2,
  });

  assert.equal(model.text, text);
  assert.equal(model.width, 183.75);
  assert.equal(model.height, 91.5);
  assert.equal(model.fontSize, 10);
  assert.equal(model.lineHeight, 1.3);
  assert.equal(model.letterSpacing, 2);
  assert.ok(model.fontFamily.includes("Album Noto Sans TC"));
  assert.ok(model.canvasScale < 1);
});

test("linked material text capacity finds the largest fitting full-width character count", () => {
  CapacityKonvaText.constructionCount = 0;
  assert.equal(measureTextLabelCjkCapacity({
    width: 100,
    height: 50,
    font_size: 20,
    line_height: 1,
    letter_spacing: 0,
  }, CapacityKonvaText), 10);
  assert.equal(measureTextLabelCjkCapacity({
    width: 100,
    height: 50,
    font_size: 20,
    line_height: 1,
    letter_spacing: 5,
  }, CapacityKonvaText), 8);
  assert.equal(CapacityKonvaText.constructionCount, 2);
});


test("linked material text capacity handles tiny frames, transient numbers, and large frames in O(1)", () => {
  CapacityKonvaText.constructionCount = 0;
  assert.equal(measureTextLabelCjkCapacity({
    width: 100,
    height: 19,
    font_size: 20,
    line_height: 1,
    letter_spacing: 0,
  }, CapacityKonvaText), 0);
  assert.equal(measureTextLabelCjkCapacity({
    width: 19,
    height: 100,
    font_size: 20,
    line_height: 1,
    letter_spacing: 0,
  }, CapacityKonvaText), 0);
  assert.equal(measureTextLabelCjkCapacity({
    width: 100,
    height: 100,
    font_size: "",
    line_height: 1,
    letter_spacing: 0,
  }, CapacityKonvaText), null);
  assert.equal(measureTextLabelCjkCapacity({
    width: 100,
    height: 100,
    font_size: 20,
    line_height: Number.NaN,
    letter_spacing: 0,
  }, CapacityKonvaText), null);
  assert.equal(measureTextLabelCjkCapacity({
    width: 794,
    height: 1123,
    font_size: 10,
    line_height: 0.8,
    letter_spacing: 0,
  }, CapacityKonvaText), 11060);
  assert.equal(CapacityKonvaText.constructionCount, 3);
});


test("UI font scale settings clamp to the supported range", () => {
  assert.equal(normalizeUiFontScale("bad"), DEFAULT_UI_FONT_SCALE);
  assert.equal(normalizeUiFontScale(0.5), UI_FONT_SCALE_MIN);
  assert.equal(normalizeUiFontScale(2), UI_FONT_SCALE_MAX);
  assert.equal(normalizeUiFontScale(1.126), 1.13);
});
