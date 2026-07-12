// 對應文字（label_texts）編輯 Hook
// 封裝 ClassEdit / StudentEdit 共用的 labelTexts state 與讀寫操作，
// 維護 label_texts 三層覆蓋的不變量：entry 為 undefined 時必須刪除 key，
// 「恢復預設」才會真正回落到下一層（專案共用 / 模板預設）。
// 儲存流程（useAutoSave）不在此 Hook 內，由各頁自行串接。

import { useState } from "react";
import {
  getLabelEntryAlign,
  getLabelEntryTextOverride,
  hasLabelEntryTextOverride,
  withLabelEntryAlign,
  withLabelEntryText,
  withoutLabelEntryText,
} from "../utils/labelTextEntries";

/**
 * 對應文字編輯 Hook。
 *
 * @returns {{
 *   labelTexts: Object,            // { [pageIndex]: { [labelId]: text | { text, text_align } } }
 *   setLabelTexts: Function,       // 載入資料時由頁面灌初值
 *   getLabelEntry: Function,       // (pageIndex, labelId) => 原始 entry
 *   getLabelText: Function,        // (pageIndex, labelId) => 覆蓋文字（無覆蓋為 ""）
 *   getLabelAlign: Function,       // (pageIndex, labelId, fallbackAlign?) => 對齊值
 *   hasLabelTextOverride: Function,// (pageIndex, labelId) => 是否有文字覆蓋
 *   updateLabelEntry: Function,    // (pageIndex, labelId, getNextEntry) 低階更新
 *   setLabelText: Function,        // (pageIndex, labelId, textValue, fallbackAlign?)
 *   setLabelAlign: Function,       // (pageIndex, labelId, textAlign, fallbackAlign?)
 *   restoreDefaultLabelText: Function, // (pageIndex, labelId, fallbackAlign?) 恢復預設
 * }}
 */
export function useLabelTextsEditor() {
  const [labelTexts, setLabelTexts] = useState({});

  const getLabelEntry = (pageIndex, labelId) =>
    labelTexts[pageIndex]?.[String(labelId)];

  const getLabelText = (pageIndex, labelId) =>
    getLabelEntryTextOverride(getLabelEntry(pageIndex, labelId)) ?? "";

  const getLabelAlign = (pageIndex, labelId, fallbackAlign = "center") =>
    getLabelEntryAlign(getLabelEntry(pageIndex, labelId), fallbackAlign);

  const hasLabelTextOverride = (pageIndex, labelId) =>
    hasLabelEntryTextOverride(getLabelEntry(pageIndex, labelId));

  const updateLabelEntry = (pageIndex, labelId, getNextEntry) => {
    const labelIdKey = String(labelId);
    setLabelTexts(prevTexts => {
      const currentPageTexts = { ...(prevTexts[pageIndex] || {}) };
      const nextEntry = getNextEntry(currentPageTexts[labelIdKey]);
      if (nextEntry === undefined) {
        delete currentPageTexts[labelIdKey];
      } else {
        currentPageTexts[labelIdKey] = nextEntry;
      }
      return { ...prevTexts, [pageIndex]: currentPageTexts };
    });
  };

  const setLabelText = (pageIndex, labelId, textValue, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryText(currentEntry, textValue, fallbackAlign)
    );
  };

  const setLabelAlign = (pageIndex, labelId, textAlign, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryAlign(currentEntry, textAlign, fallbackAlign)
    );
  };

  const restoreDefaultLabelText = (pageIndex, labelId, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withoutLabelEntryText(currentEntry, fallbackAlign)
    );
  };

  return {
    labelTexts,
    setLabelTexts,
    getLabelEntry,
    getLabelText,
    getLabelAlign,
    hasLabelTextOverride,
    updateLabelEntry,
    setLabelText,
    setLabelAlign,
    restoreDefaultLabelText,
  };
}
