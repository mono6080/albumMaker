// 班級總覽的學生卡片：縮圖列（點縮圖預覽）＋ 姓名與內容進度 ＋ 單人下載動作。
// 可編輯者主要區是進編輯頁的 Link；唯讀角色改為開啟預覽的 button。
// 完成判斷式一律走 utils/reviewCompletion（與 hook 閘門同一來源）。

import { Link } from "react-router-dom";
import { CheckCircle2, Download, FolderArchive, ImageDown, Loader2, Pencil, RotateCcw } from "lucide-react";
import {
  appendPreviewCacheVersion,
  buildStudentPagePreviewUrl as previewUrl,
} from "../api/urls";
import { isStudentContentComplete } from "../utils/reviewCompletion";
import { Button, IconButton, Surface } from "./ui";
import ReviewPreviewImage from "./ReviewPreviewImage";

export default function StudentReviewCard({
  student,
  projectId,
  pageCount,
  ts,
  templateRevision,
  canEditCurrentProject,
  canDownloadCurrentProject,
  canReopenProject,
  isProjectCompleted,
  photoProgress,
  textProgress,
  isRendering,
  isImageRendering,
  isImageShareReady,
  isPhotosDownloading,
  getVisiblePageIndexes,
  onPreview,
  onDownloadPdf,
  onDownloadImages,
  onDownloadPhotos,
  onCompleteStudent,
  onReopenStudent,
}) {
  const isContentComplete = isStudentContentComplete(photoProgress, textProgress);
  // 三種下載互斥：任一進行中即整排鎖住，避免同時觸發多個大檔請求
  const isStudentBusy = isRendering || isImageRendering || isPhotosDownloading;
  const hasRenderedOutput = Boolean(student.output_filename);
  // 有效完成 predicate（與後端一致）：該生 completed_at 或全班 completed_at 任一成立
  const isStudentMarkedCompleted = Boolean(student.completed_at);
  const isStudentEffectivelyCompleted = isStudentMarkedCompleted || isProjectCompleted;
  const canStartDownload = isStudentEffectivelyCompleted && (canEditCurrentProject || hasRenderedOutput);
  const studentSkippedPages = new Set(
    (student.pages_data || []).filter(p => p.skip).map(p => p.page_index)
  );

  // 內容進度 badge：可編輯（Link）與唯讀（button）兩個分支共用同一份 JSX
  const contentProgressBadges = (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
      {isStudentEffectivelyCompleted && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 font-medium text-white"
          title={isStudentMarkedCompleted
            ? `標記完成於 ${new Date(student.completed_at).toLocaleString("zh-TW")}`
            : "由全班完成標記涵蓋"}
        >
          <CheckCircle2 className="h-3 w-3" />
          {isStudentMarkedCompleted ? "已標記完成" : "全班完成"}
        </span>
      )}
      {photoProgress.total > 0 && (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
          photoProgress.filled === photoProgress.total
            ? "bg-emerald-50 text-emerald-700"
            : "bg-amber-50 text-amber-700"
        }`}>
          {photoProgress.filled === photoProgress.total
            ? "✓ 照片齊"
            : `照片 ${photoProgress.filled}/${photoProgress.total}`}
        </span>
      )}
      {textProgress.total > 0 && (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
          textProgress.filled === textProgress.total
            ? "bg-emerald-50 text-emerald-700"
            : "bg-amber-50 text-amber-700"
        }`}>
          {textProgress.filled === textProgress.total
            ? "✓ 文字齊"
            : `文字 ${textProgress.filled}/${textProgress.total}`}
        </span>
      )}
    </div>
  );

  return (
    <Surface
      data-guide="review-student-card"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 420px" }}
      padding="none"
      className={`overflow-hidden transition-all hover:shadow-md ${
        isContentComplete ? "border-emerald-100" : "border-gray-200"
      }`}
    >
      {/* Thumbnail strip — 跳過已刪除的頁面；點縮圖即預覽 */}
      <div data-guide="review-preview-student" className="flex gap-1 p-3 bg-gray-50 border-b border-gray-100 overflow-x-auto">
        {Array.from({ length: pageCount }, (_, i) => {
          if (studentSkippedPages.has(i)) return null;
          return (
            <button
              key={i}
              onClick={() => onPreview(student.id, i)}
              className="flex-shrink-0 w-20 rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 hover:shadow-sm transition-all group"
            >
              <ReviewPreviewImage
                src={appendPreviewCacheVersion(
                  previewUrl(projectId, student.id, i, 0.4),
                  ts,
                  templateRevision,
                )}
                alt={`p${i + 1}`}
                className="w-full h-24 object-cover"
              />
              <div className="text-center text-xs text-gray-400 py-0.5 group-hover:text-indigo-500">
                第 {i + 1} 頁
              </div>
            </button>
          );
        })}
      </div>

      {/* Student info：主要區可點（老師→編輯；其他角色→預覽），動作收成右側小 icon */}
      <div className="flex items-center gap-2 p-4">
        {canEditCurrentProject ? (
          <Link
            to={`/projects/${projectId}/students/${student.id}/edit`}
            className="group/main min-w-0 flex-1"
          >
            <div className="truncate font-semibold text-gray-900 transition-colors group-hover/main:text-indigo-700">
              {student.name}
            </div>
            {contentProgressBadges}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onPreview(student.id, getVisiblePageIndexes(student)[0] ?? 0)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="truncate font-semibold text-gray-900">{student.name}</div>
            {contentProgressBadges}
          </button>
        )}
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {canEditCurrentProject && (
            <Link
              to={`/projects/${projectId}/students/${student.id}/edit`}
              aria-label="編輯"
              title="編輯"
              data-guide="review-edit-student"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-indigo-500 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
            >
              <Pencil className="h-4 w-4" />
            </Link>
          )}
          {/* 完成後，唯讀角色可下載既有產物，但不能觸發需要 can_edit 的重新渲染。 */}
          {canDownloadCurrentProject && (
            <>
              <IconButton
                label={
                  !isStudentEffectivelyCompleted
                    ? "請先標記此學生完成，才能下載 PDF"
                    : isRendering
                      ? "PDF 產生中"
                      : canStartDownload
                        ? "下載 PDF"
                        : "尚未產生 PDF"
                }
                onClick={() => onDownloadPdf(student.id)}
                disabled={isStudentBusy || !canStartDownload}
                data-guide="review-download-student"
                variant="success"
              >
                {isRendering
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Download className="h-4 w-4" />}
              </IconButton>
              <IconButton
                label={
                  !isStudentEffectivelyCompleted
                    ? "請先標記此學生完成，才能下載圖片"
                    : isImageShareReady
                      ? "開始分享圖片"
                      : canStartDownload
                        ? "下載圖片"
                        : "尚未產生圖片"
                }
                onClick={() => onDownloadImages(student.id)}
                disabled={isStudentBusy || !canStartDownload}
                variant="info"
              >
                {isImageRendering
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <ImageDown className="h-4 w-4" />}
              </IconButton>
              {/* 上傳照片 ZIP 是原始素材、與交件無關，不受標記完成閘門限制 */}
              <IconButton
                label="下載上傳照片"
                onClick={() => onDownloadPhotos(student.id)}
                disabled={isStudentBusy}
                variant="neutral"
              >
                {isPhotosDownloading
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <FolderArchive className="h-4 w-4" />}
              </IconButton>
            </>
          )}
        </div>
      </div>

      {/* 個別完成動作列：老師標記完成；退回僅主管/admin（與全班退回同權限來源） */}
      {((canEditCurrentProject && !isStudentEffectivelyCompleted)
        || (canReopenProject && isStudentMarkedCompleted)) && (
        <div className="border-t border-gray-100 px-4 py-2.5">
          {canEditCurrentProject && !isStudentEffectivelyCompleted && (
            <Button
              type="button"
              onClick={() => onCompleteStudent(student)}
              // 前置條件與後端一致：照片與文字都填滿才能標記完成
              disabled={!isContentComplete}
              title={isContentComplete
                ? undefined
                : `照片或文字尚未填齊（照片 ${photoProgress.filled}/${photoProgress.total}、文字 ${textProgress.filled}/${textProgress.total}），補齊後才能標記完成`}
              variant="successSoft"
              size="sm"
              fullWidth
            >
              <CheckCircle2 className="h-4 w-4" />
              {isContentComplete ? "標記完成" : "內容未填齊，暫不能標記完成"}
            </Button>
          )}
          {canReopenProject && isStudentMarkedCompleted && (
            <Button
              type="button"
              onClick={() => onReopenStudent(student)}
              variant="neutral"
              size="sm"
              fullWidth
            >
              <RotateCcw className="h-4 w-4" />
              退回此學生
            </Button>
          )}
        </div>
      )}
    </Surface>
  );
}
