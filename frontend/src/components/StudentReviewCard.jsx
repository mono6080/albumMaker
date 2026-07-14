// 班級總覽的學生卡片：縮圖列（點縮圖預覽）＋ 姓名與照片進度 ＋ 單人下載動作。
// 可編輯者主要區是進編輯頁的 Link；唯讀角色改為開啟預覽的 button。

import { Link } from "react-router-dom";
import { Download, ImageDown, Loader2, Pencil } from "lucide-react";
import {
  appendPreviewCacheVersion,
  buildStudentPagePreviewUrl as previewUrl,
} from "../api/urls";
import { IconButton, Surface } from "./ui";
import ReviewPreviewImage from "./ReviewPreviewImage";

export default function StudentReviewCard({
  student,
  projectId,
  pageCount,
  ts,
  templateRevision,
  canEditCurrentProject,
  photoProgress,
  isRendering,
  isImageRendering,
  isImageShareReady,
  getVisiblePageIndexes,
  onPreview,
  onDownloadPdf,
  onDownloadImages,
}) {
  const isStudentPhotoComplete = photoProgress.total === 0 || photoProgress.filled === photoProgress.total;
  const isStudentBusy = isRendering || isImageRendering;
  const studentSkippedPages = new Set(
    (student.pages_data || []).filter(p => p.skip).map(p => p.page_index)
  );

  // 照片進度 badge：可編輯（Link）與唯讀（button）兩個分支共用同一份 JSX
  const photoProgressBadge = (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
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
    </div>
  );

  return (
    <Surface
      data-guide="review-student-card"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 420px" }}
      padding="none"
      className={`overflow-hidden transition-all hover:shadow-md ${
        isStudentPhotoComplete ? "border-emerald-100" : "border-gray-200"
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
            {photoProgressBadge}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onPreview(student.id, getVisiblePageIndexes(student)[0] ?? 0)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="truncate font-semibold text-gray-900">{student.name}</div>
            {photoProgressBadge}
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
          {/* 下載前要先渲染（owner/admin 限定），唯讀角色點了必 403，直接不顯示 */}
          {canEditCurrentProject && (
            <>
              <IconButton
                label={isRendering ? "PDF 產生中" : "下載 PDF"}
                onClick={() => onDownloadPdf(student.id)}
                disabled={isStudentBusy}
                data-guide="review-download-student"
                variant="success"
              >
                {isRendering
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Download className="h-4 w-4" />}
              </IconButton>
              <IconButton
                label={isImageShareReady ? "開始分享圖片" : "下載圖片"}
                onClick={() => onDownloadImages(student.id)}
                disabled={isStudentBusy}
                variant="info"
              >
                {isImageRendering
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <ImageDown className="h-4 w-4" />}
              </IconButton>
            </>
          )}
        </div>
      </div>
    </Surface>
  );
}
