// 全班共用文字面板 — 純位移自 ClassEdit
// 與個別編輯的文字面板同款樣式（共用 TextLabelFieldRow），只差資料層是專案層級；
// label_texts 的讀寫操作由頁面層的 useLabelTextsEditor 提供、以 props 傳入

import { Type } from "lucide-react";
import TextLabelFieldRow from "./TextLabelFieldRow";
import { AutoSaveStatus } from "./ui";

export default function ClassTextPanel({
  activePage,
  textLabels,
  saveStatus,
  disabled,
  getLabelText,
  getLabelAlign,
  hasLabelTextOverride,
  setLabelText,
  setLabelAlign,
  restoreDefaultLabelText,
  onScheduleSave,
}) {
  return (
    <div data-guide="class-text-panel" className="space-y-4">
      {textLabels.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-indigo-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              第 {activePage + 1} 頁文字
            </h3>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">
              ({"{name}"}=相本稱呼、{"{full_name}"}=完整姓名，清空會輸出空白)
            </span>
            <AutoSaveStatus status={saveStatus} className="ml-auto" />
          </div>
          <div className="space-y-3">
            {textLabels.map(label => {
              const templateDefaultText = label.text ?? "";
              const defaultAlign = label.text_align ?? "center";
              return (
                <TextLabelFieldRow
                  key={label.id}
                  labelId={label.id}
                  value={getLabelText(activePage, label.id)}
                  placeholder={templateDefaultText}
                  defaultText={templateDefaultText}
                  inheritedValue={templateDefaultText}
                  hasOverride={hasLabelTextOverride(activePage, label.id)}
                  align={getLabelAlign(activePage, label.id, defaultAlign)}
                  disabled={disabled}
                  onChange={value => setLabelText(activePage, label.id, value, defaultAlign)}
                  onAlignChange={value => setLabelAlign(activePage, label.id, value, defaultAlign)}
                  onRestoreDefault={() => restoreDefaultLabelText(activePage, label.id, defaultAlign)}
                  onScheduleSave={onScheduleSave}
                  buttonGuideId="class-text-insert-name"
                />
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
