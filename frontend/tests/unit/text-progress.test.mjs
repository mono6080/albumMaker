import assert from "node:assert/strict";

import { computeStudentTextProgress } from "../../src/utils/textProgress.js";
import { test } from "./harness.mjs";


function textTemplatePages(textLabelCount = 12) {
  return [{
    layout: {
      photo_slots: [],
      text_labels: Array.from({ length: textLabelCount }, (_, index) => ({
        id: index + 1,
        text: `模板範例 ${index + 1}`,
      })),
      stickers: [],
    },
  }];
}


test("text progress combines class text with every student's individual text", () => {
  const templatePages = textTemplatePages();
  const projectLabelTexts = {
    0: Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [String(index + 1), `全班 ${index + 1}`]),
    ),
  };
  const firstStudent = computeStudentTextProgress(
    [{ page_index: 0, label_texts: { 12: "甲的個人文字" } }],
    templatePages,
    projectLabelTexts,
  );
  const secondStudent = computeStudentTextProgress(
    [{ page_index: 0, label_texts: { 12: "乙的個人文字" } }],
    templatePages,
    projectLabelTexts,
  );

  assert.deepEqual(firstStudent, { filled: 12, total: 12 });
  assert.deepEqual(secondStudent, { filled: 12, total: 12 });
  assert.deepEqual({
    filled: firstStudent.filled + secondStudent.filled,
    total: firstStudent.total + secondStudent.total,
  }, { filled: 24, total: 24 });

  const missingSecondStudent = computeStudentTextProgress(
    [{ page_index: 0, label_texts: {} }],
    templatePages,
    projectLabelTexts,
  );
  assert.deepEqual({
    filled: firstStudent.filled + missingSecondStudent.filled,
    total: firstStudent.total + missingSecondStudent.total,
  }, { filled: 23, total: 24 });
});


test("text progress uses individual text first and inherits class text for style-only entries", () => {
  const templatePages = textTemplatePages(3);
  const progress = computeStudentTextProgress(
    [{
      page_index: 0,
      label_texts: {
        1: "   ",
        2: { text_align: "left" },
        3: { text: "個人文字" },
      },
    }],
    templatePages,
    { 0: { 1: "全班文字", 2: "全班文字", 3: "" } },
  );

  assert.deepEqual(progress, { filled: 2, total: 3 });
});


test("text progress excludes template defaults, static, hidden, and skipped-page text", () => {
  const templatePages = [
    {
      layout: {
        photo_slots: [],
        text_labels: [
          { id: 1, text: "模板範例不算填寫" },
          { id: 2, text: "固定標題", text_role: "static" },
          { id: 3, text: "隱藏文字", visible: false },
        ],
        stickers: [],
      },
    },
    {
      layout: {
        photo_slots: [],
        text_labels: [{ id: 4, text: "被跳過頁面" }],
        stickers: [],
      },
    },
  ];
  const progress = computeStudentTextProgress(
    [{ page_index: 1, skip: true, label_texts: { 4: "已有文字" } }],
    templatePages,
    {},
  );

  assert.deepEqual(progress, { filled: 0, total: 1 });
});
