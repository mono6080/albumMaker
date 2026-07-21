// 班級總覽的老師可填文字進度。
// 後端鏡像：backend/services/student_progress.py 的
// summarize_student_progress；契約由前端 text-progress 與後端 roster 測試釘住。

import {
  getLabelEntryTextOverride,
  TEXT_ALIGN_VALUES,
} from "./labelTextEntries.js";
import { getFillableTextLabels } from "./textLabelRoles.js";

function hasTextAlignOverride(entry) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && TEXT_ALIGN_VALUES.includes(entry.text_align);
}

function effectiveProgressText(studentEntry, projectEntry, textLabel) {
  const projectText = getLabelEntryTextOverride(projectEntry);
  let studentText = getLabelEntryTextOverride(studentEntry);

  // 舊版可能把模板預設字存成個人覆寫；有全班文字時沿用正式合併規則。
  if (
    projectText !== undefined
    && studentText === String(textLabel.text ?? "")
    && !hasTextAlignOverride(studentEntry)
  ) {
    studentText = undefined;
  }

  return studentText === undefined ? projectText : studentText;
}

/**
 * @param {Array} pagesData 學生頁面資料
 * @param {Array} templatePages 模板頁面
 * @param {Object} projectLabelTexts 全班文字，格式為 pageIndex → labelId → entry
 * @returns {{ filled: number, total: number }}
 */
export function computeStudentTextProgress(
  pagesData,
  templatePages,
  projectLabelTexts,
) {
  const pageDataByIndex = new Map(
    (pagesData || []).map(pageData => [pageData.page_index, pageData]),
  );
  let filled = 0;
  let total = 0;

  (templatePages || []).forEach((templatePage, pageIndex) => {
    const pageData = pageDataByIndex.get(pageIndex);
    if (pageData?.skip) return;

    const textLabels = getFillableTextLabels(templatePage.layout);
    const studentLabelTexts = pageData?.label_texts || {};
    const pageProjectLabelTexts = projectLabelTexts?.[String(pageIndex)] || {};
    total += textLabels.length;

    textLabels.forEach(textLabel => {
      const labelId = String(textLabel.id);
      const effectiveText = effectiveProgressText(
        studentLabelTexts[labelId],
        pageProjectLabelTexts[labelId],
        textLabel,
      );
      if (String(effectiveText ?? "").trim()) filled += 1;
    });
  });

  return { filled, total };
}
