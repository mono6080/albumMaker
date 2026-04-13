// 學生個別編輯頁 — 預覽面板子元件
// 顯示單頁預覽圖、頁面刪除 / 還原控制與強制重新整理按鈕

import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import AlbumPageNav from "./AlbumPageNav";
import PagePreview from "./PagePreview";

export default function StudentPreviewPanel({
  activePage,
  pageCount,
  onPageChange,
  projectId,
  studentId,
  pageTimestamps,
  isCurrentPageSkipped,
  onPageSkip,
  onRefresh,
}) {
  return (
    <div className="space-y-3">
      <AlbumPageNav page={activePage} total={pageCount} onChange={onPageChange} />
      {/* 刪除 / 還原頁面 */}
      <div className="flex items-center justify-between">
        {isCurrentPageSkipped ? (
          <div className="flex items-center gap-2 flex-1">
            <span className="text-xs text-red-400 font-medium">此頁已刪除（不會出現在 PDF）</span>
            <button
              onClick={() => onPageSkip(activePage, false)}
              className="flex items-center gap-1 text-xs text-indigo-600 border border-indigo-300 px-2 py-1 rounded-lg hover:bg-indigo-50 transition-colors ml-auto"
            >
              <RotateCcw className="w-3 h-3" />還原此頁
            </button>
          </div>
        ) : (
          <button
            onClick={() => onPageSkip(activePage, true)}
            className="flex items-center gap-1 text-xs text-red-500 border border-red-200 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors ml-auto"
          >
            <Trash2 className="w-3 h-3" />刪除此頁
          </button>
        )}
      </div>
      <div className={`relative ${isCurrentPageSkipped ? "opacity-40" : ""}`}>
        <PagePreview
          projectId={projectId}
          studentId={studentId}
          pageIndex={activePage}
          timestamp={pageTimestamps[activePage] ?? 0}
        />
        {isCurrentPageSkipped && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-red-100 text-red-500 text-sm font-medium px-3 py-1 rounded-full border border-red-200">已刪除</span>
          </div>
        )}
      </div>
      <div className="flex justify-center">
        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 py-1.5 px-3 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </button>
      </div>
    </div>
  );
}
