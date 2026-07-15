import assert from "node:assert/strict";
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
import { test } from "./harness.mjs";


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
