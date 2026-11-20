// 學生個別編輯頁 — 預覽面板子元件
// 顯示單頁預覽圖、頁面刪除 / 還原控制與強制重新整理按鈕
// 頁碼導航統一由 StudentEdit 的全域 AlbumPageNav 控制
// 刪除頁面必須填寫原因（學期匯出會列出每本相本缺了哪幾頁、為什麼）

import { useState } from "react";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import FormModal from "./FormModal";
import PagePreview from "./PagePreview";
import { Button, FormField, fieldControlClass } from "./ui";

// 與後端 PAGE_SKIP_REASON_MAX_LENGTH 同步
const SKIP_REASON_MAX_LENGTH = 100;

function PageSkipReasonModal({ isOpen, pageNumber, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const trimmedReason = reason.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!trimmedReason || isSubmitting) return;
    setIsSubmitting(true);
    const ok = await onConfirm(trimmedReason);
    setIsSubmitting(false);
    if (ok) setReason("");
  };

  return (
    <FormModal isOpen={isOpen} title={`刪除第 ${pageNumber} 頁`} onClose={onClose} maxWidthClass="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-600">
          刪除後這一頁不會出現在 PDF，之後可以還原。原因會列在學期匯出的缺頁清單中。
        </p>
        <FormField label="刪除原因（必填）">
          <input
            type="text"
            autoFocus
            value={reason}
            maxLength={SKIP_REASON_MAX_LENGTH}
            onChange={event => setReason(event.target.value)}
            placeholder="例如：該期請假未到校、照片不足"
            className={fieldControlClass}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button type="submit" variant="danger" size="sm" disabled={!trimmedReason || isSubmitting}>
            <Trash2 className="w-3.5 h-3.5" />確認刪除
          </Button>
        </div>
      </form>
    </FormModal>
  );
}

export default function StudentPreviewPanel({
  activePage,
  projectId,
  studentId,
  pageTimestamps,
  isCurrentPageSkipped,
  currentPageSkipReason = "",
  onPageSkip,
  onRefresh,
  timestampSeed = 0,
  templateRevision = null,
  // 專案完成鎖定：頁面刪除/還原屬內容修改，鎖定時停用
  isLocked = false,
}) {
  const [isReasonModalOpen, setIsReasonModalOpen] = useState(false);

  const confirmSkip = async (reason) => {
    const ok = await onPageSkip(activePage, true, reason);
    if (ok) setIsReasonModalOpen(false);
    return ok;
  };

  return (
    <div className="space-y-3">
      {/* 已刪除頁的還原提示（刪除動作降級到頁尾，避免一級位置誤觸） */}
      {isCurrentPageSkipped && (
        <div className="flex flex-wrap items-center gap-2" data-guide="student-page-skip">
          <div className="min-w-0 text-xs">
            <p className="text-red-400 font-medium">此頁已刪除（不會出現在 PDF）</p>
            <p className="mt-0.5 break-words text-gray-500">
              原因：{currentPageSkipReason || "未填寫"}
            </p>
          </div>
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
          templateRevision={templateRevision}
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
            onClick={() => setIsReasonModalOpen(true)}
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
      <PageSkipReasonModal
        isOpen={isReasonModalOpen}
        pageNumber={activePage + 1}
        onClose={() => setIsReasonModalOpen(false)}
        onConfirm={confirmSkip}
      />
    </div>
  );
}
