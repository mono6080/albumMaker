// 學生個別編輯頁 — 預覽面板子元件
// 顯示單頁預覽圖、頁面刪除 / 還原控制與強制重新整理按鈕
// 頁碼導航統一由 StudentEdit 的全域 AlbumPageNav 控制

import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import PagePreview from "./PagePreview";
import { Button } from "./ui";

export default function StudentPreviewPanel({
  activePage,
  projectId,
  studentId,
  pageTimestamps,
  isCurrentPageSkipped,
  onPageSkip,
  onRefresh,
  timestampSeed = 0,
  // 專案完成鎖定：頁面刪除/還原屬內容修改，鎖定時停用
  isLocked = false,
}) {
  return (
    <div className="space-y-3">
      {/* 已刪除頁的還原提示（刪除動作降級到頁尾，避免一級位置誤觸） */}
      {isCurrentPageSkipped && (
        <div className="flex flex-wrap items-center gap-2" data-guide="student-page-skip">
          <span className="min-w-0 text-xs text-red-400 font-medium">此頁已刪除（不會出現在 PDF）</span>
          <Button
            onClick={() => onPageSkip(activePage, false)}
            disabled={isLocked}
            variant="secondary"
            size="xs"
            className="ml-auto whitespace-nowrap"
          >
            <RotateCcw className="w-3 h-3" />還原此頁
          </Button>
        </div>
      )}
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
      <div className="flex items-center justify-center gap-2">
        <Button
          onClick={onRefresh}
          variant="ghost"
          size="xs"
          className="whitespace-nowrap"
        >
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </Button>
        {!isCurrentPageSkipped && (
          <Button
            onClick={() => onPageSkip(activePage, true)}
            disabled={isLocked}
            variant="ghost"
            size="xs"
            className="whitespace-nowrap text-gray-400 hover:bg-red-50 hover:text-red-500"
            data-guide="student-page-skip"
          >
            <Trash2 className="w-3 h-3" />刪除此頁
          </Button>
        )}
      </div>
    </div>
  );
}
