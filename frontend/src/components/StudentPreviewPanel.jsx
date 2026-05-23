// 學生個別編輯頁 — 預覽面板子元件
// 顯示單頁預覽圖、頁面刪除 / 還原控制與強制重新整理按鈕

import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import AlbumPageNav from "./AlbumPageNav";
import PagePreview from "./PagePreview";
import { Button } from "./ui";

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
  timestampSeed = 0,
}) {
  return (
    <div className="space-y-3">
      <div data-guide="student-page-nav">
        <AlbumPageNav page={activePage} total={pageCount} onChange={onPageChange} />
      </div>
      {/* 刪除 / 還原頁面 */}
      <div className="flex items-center justify-between" data-guide="student-page-skip">
        {isCurrentPageSkipped ? (
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
            <span className="min-w-0 text-xs text-red-400 font-medium">此頁已刪除（不會出現在 PDF）</span>
            <Button
              onClick={() => onPageSkip(activePage, false)}
              variant="secondary"
              size="xs"
              className="ml-auto whitespace-nowrap"
            >
              <RotateCcw className="w-3 h-3" />還原此頁
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => onPageSkip(activePage, true)}
            variant="dangerSoft"
            size="xs"
            className="ml-auto whitespace-nowrap"
          >
            <Trash2 className="w-3 h-3" />刪除此頁
          </Button>
        )}
      </div>
      <div className={`relative ${isCurrentPageSkipped ? "opacity-40" : ""}`} data-guide="student-page-preview">
        <PagePreview
          projectId={projectId}
          studentId={studentId}
          pageIndex={activePage}
          timestamp={pageTimestamps[activePage] ?? timestampSeed}
        />
        {isCurrentPageSkipped && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-red-100 text-red-500 text-sm font-medium px-3 py-1 rounded-full border border-red-200">已刪除</span>
          </div>
        )}
      </div>
      <div className="flex justify-center">
        <Button
          onClick={onRefresh}
          variant="ghost"
          size="xs"
          className="whitespace-nowrap"
        >
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </Button>
      </div>
    </div>
  );
}
