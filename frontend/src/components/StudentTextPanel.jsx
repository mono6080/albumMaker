// 學生個別編輯頁 — 對應文字面板子元件
// 顯示當前頁面的所有文字方塊，支援個別覆寫與字數提示

import { Type } from "lucide-react";
import AlbumPageNav from "./AlbumPageNav";
import CompositionTextarea from "./CompositionTextarea";

export default function StudentTextPanel({
  activePage,
  pageCount,
  onPageChange,
  activePageLayout,
  projectLabelTexts,
  student,
  getLabelText,
  onLabelChange,
  onScheduleSave,
}) {
  return (
    <div className="space-y-4">
      <AlbumPageNav page={activePage} total={pageCount} onChange={onPageChange} />
      {activePageLayout?.text_labels?.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-indigo-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              第 {activePage + 1} 頁文字
            </h3>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">
              ({"{name}"} 自動代入姓名)
            </span>
          </div>
          <div className="space-y-3">
            {activePageLayout.text_labels.map(label => {
              const rawDefaultText =
                projectLabelTexts[String(activePage)]?.[String(label.id)] ?? label.text ?? "";
              const displayDefaultText = rawDefaultText.replace("{name}", student.name);
              const currentValue = getLabelText(activePage, label.id);
              const len = currentValue.length;
              return (
                <div key={label.id} className="flex gap-3">
                  <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-1">
                    <span className="text-xs font-bold text-indigo-400">{label.id}</span>
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-gray-400 mb-1">
                      預設：{displayDefaultText.substring(0, 25)}
                    </div>
                    <CompositionTextarea
                      rows={2}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                      placeholder={displayDefaultText}
                      value={currentValue}
                      onChange={value => onLabelChange(activePage, label.id, value)}
                      onScheduleSave={onScheduleSave}
                      maxLength={200}
                    />
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
        <div className="text-center py-12 text-gray-300 text-sm">此頁沒有文字方塊</div>
      )}
    </div>
  );
}
