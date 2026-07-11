// 學生個別編輯頁 — 對應文字面板子元件
// 顯示當前頁面的所有文字方塊，支援個別覆寫與字數提示
// 頁碼導航統一由 StudentEdit 的全域 AlbumPageNav 控制

import { Type } from "lucide-react";
import TextAlignControl from "./TextAlignControl";
import TextVariableTextarea from "./TextVariableTextarea";
import { AutoSaveStatus } from "./ui";
import { getLabelEntryAlign, getLabelEntryText } from "../utils/labelTextEntries";
import { getFillableTextLabels } from "../utils/textLabelRoles";

export default function StudentTextPanel({
  activePage,
  activePageLayout,
  projectLabelTexts,
  student,
  getLabelText,
  getLabelAlign,
  hasLabelTextOverride = () => false,
  onLabelChange,
  onLabelAlignChange,
  onRestoreDefault = () => {},
  onScheduleSave,
  saveStatus = "idle",
  // 專案完成鎖定：文字輸入與操作鈕整組唯讀
  isLocked = false,
}) {
  const fillableTextLabels = getFillableTextLabels(activePageLayout);

  return (
    <div className="space-y-4">
      {fillableTextLabels.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm" data-guide="student-text-fields">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-indigo-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              第 {activePage + 1} 頁文字
            </h3>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">
              ({"{name}"} 自動代入姓名，清空會輸出空白)
            </span>
            <AutoSaveStatus status={saveStatus} className="ml-auto" />
          </div>
          <div className="space-y-3">
            {fillableTextLabels.map(label => {
              const projectEntry = projectLabelTexts[String(activePage)]?.[String(label.id)];
              const rawDefaultText =
                getLabelEntryText(projectEntry, label.text ?? "");
              const displayDefaultText = rawDefaultText.replace("{name}", student.name);
              const defaultAlign = getLabelEntryAlign(projectEntry, label.text_align ?? "center");
              const currentValue = getLabelText(activePage, label.id);
              const currentAlign = getLabelAlign(activePage, label.id, defaultAlign);
              const hasOverride = hasLabelTextOverride(activePage, label.id);
              const len = currentValue.length;
              return (
                <div key={label.id} className="flex gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-1">
                    <span className="text-xs font-bold text-indigo-400">{label.id}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <TextVariableTextarea
                      rows={2}
                      disabled={isLocked}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none disabled:opacity-60"
                      placeholder={displayDefaultText}
                      value={currentValue}
                      defaultText={displayDefaultText}
                      inheritedValue={rawDefaultText}
                      hasOverride={hasOverride}
                      onChange={value => onLabelChange(activePage, label.id, value, defaultAlign)}
                      onRestoreDefault={() => onRestoreDefault(activePage, label.id, defaultAlign)}
                      onScheduleSave={onScheduleSave}
                      buttonGuideId="student-text-insert-name"
                      maxLength={200}
                    />
                    {!isLocked && (
                      <TextAlignControl
                        value={currentAlign}
                        onChange={value => onLabelAlignChange(activePage, label.id, value, defaultAlign)}
                        onScheduleSave={onScheduleSave}
                        className="mt-2"
                      />
                    )}
                    {len > 0 && (
                      <div className={`text-right text-xs mt-0.5 ${len >= 180 ? "text-red-500" : "text-gray-300"}`}>
                        {len}/200
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-gray-300 text-sm">此頁沒有可填文字</div>
      )}
    </div>
  );
}
