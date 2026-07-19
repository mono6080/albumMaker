import { Link } from "react-router-dom";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  ImageDown,
  Loader2,
  MessageCircle,
  Monitor,
  Package,
  Pencil,
  Printer,
  RotateCcw,
} from "lucide-react";

import { Button, SegmentedControl, Surface } from "../ui";

function ProgressMetric({
  label,
  filled,
  total,
  emptyMessage,
  completeMessage,
  ariaLabel,
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-gray-600">{label}</span>
        {total === 0 ? (
          <span className="text-gray-400">{emptyMessage}</span>
        ) : (
          <>
            <span className={`font-semibold tabular-nums ${filled === total ? "text-emerald-600" : "text-gray-700"}`}>
              {filled} / {total} 格
            </span>
            {filled === total && (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                {completeMessage}
              </span>
            )}
          </>
        )}
      </div>
      {total > 0 && (
        <div
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={filled}
          aria-valuetext={`已填 ${filled}／${total} 格`}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100"
        >
          <div
            className={`h-full rounded-full transition-all ${filled === total ? "bg-emerald-500" : "bg-indigo-500"}`}
            style={{ width: `${(filled / total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function ProjectReviewProgress({
  projectId,
  workStage,
  classPhotoFilled,
  classPhotoTotal,
  classTextFilled,
  classTextTotal,
  incompleteStudentCount,
  commentsCount,
  canEditCurrentProject,
  canDownloadCurrentProject,
  hasRenderedStudents,
  canReopenProject,
  canDownloadPrint,
  isBatchRendering,
  renderingAll,
  renderingAllImages,
  renderAllProgress,
  renderAllImagesProgress,
  isAllImagesShareReady,
  outputMode,
  onOutputModeChange,
  onFilterIncomplete,
  onCompleteProject,
  onReopenProject,
  onDownloadAll,
  onDownloadAllImages,
}) {
  return (
    <Surface className="mb-4" data-guide="review-progress">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-1 text-[11px] font-medium lg:flex-shrink-0">
          {[
            { step: 1, label: "製作" },
            { step: 2, label: "全班完成" },
            { step: 3, label: "交件" },
          ].map(({ step, label }, index) => (
            <span key={step} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="h-3 w-3 text-gray-300" />}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 ${
                  workStage === step
                    ? "bg-indigo-600 text-white"
                    : workStage > step
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {workStage > step ? "✓" : `${step}．`}{label}
              </span>
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1 space-y-2.5 lg:border-l lg:border-gray-100 lg:pl-4">
          <ProgressMetric
            label="照片進度"
            filled={classPhotoFilled}
            total={classPhotoTotal}
            emptyMessage="此模板沒有照片格"
            completeMessage="全班照片齊"
            ariaLabel="全班照片完成度"
          />
          <ProgressMetric
            label="文字進度"
            filled={classTextFilled}
            total={classTextTotal}
            emptyMessage="此模板沒有可填文字"
            completeMessage="全班文字齊"
            ariaLabel="全班文字完成度"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {incompleteStudentCount > 0 ? (
              <button
                type="button"
                onClick={onFilterIncomplete}
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-100"
              >
                <Clock className="h-3 w-3" />
                尚未完成 {incompleteStudentCount} 位
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />
                全班內容齊
              </span>
            )}
            {commentsCount > 0 && (
              <a
                href="#review-comments"
                className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 font-medium text-violet-700 transition-colors hover:bg-violet-100"
              >
                <MessageCircle className="h-3 w-3" />
                {commentsCount} 則審閱意見
              </a>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-gray-100 lg:pl-4">
          {workStage === 1 && (
            canEditCurrentProject ? (
              <>
                <Button as={Link} to={`/projects/${projectId}/edit`} variant="primary" fullWidth>
                  <Pencil className="h-4 w-4" />
                  繼續製作（{incompleteStudentCount} 位未完成）
                </Button>
                {(classPhotoFilled > 0 || classTextFilled > 0) && (
                  <Button onClick={onCompleteProject} disabled={isBatchRendering} variant="successSoft" size="sm" fullWidth>
                    <CheckCircle2 className="h-4 w-4" />
                    直接標記全班完成
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500">製作中：還有 {incompleteStudentCount} 位學生未完成。</p>
            )
          )}
          {workStage === 2 && (
            canEditCurrentProject ? (
              <>
                <Button onClick={onCompleteProject} disabled={isBatchRendering} variant="success" fullWidth>
                  <CheckCircle2 className="h-4 w-4" />
                  全班完成
                </Button>
                <p className="text-xs leading-relaxed text-gray-400">
                  照片與文字已備齊。標記完成後內容鎖定，並開放 PDF／圖片下載；需主管或管理員退回才能修改。
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500">照片與文字已備齊，待老師標記全班完成。</p>
            )
          )}
          {workStage === 3 && (
            <>
              <p className="text-sm font-medium text-emerald-700">
                ✓ 已標記全班完成，內容鎖定{canEditCurrentProject ? "；請下載交件。" : "。"}
              </p>
              {canReopenProject && (
                <Button onClick={onReopenProject} variant="neutral" size="sm" fullWidth>
                  <RotateCcw className="h-4 w-4" />
                  退回修改
                </Button>
              )}
            </>
          )}

          {workStage >= 2 && canDownloadCurrentProject && (canEditCurrentProject || hasRenderedStudents) && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button
                  onClick={onDownloadAll}
                  disabled={isBatchRendering || workStage !== 3}
                  title={workStage === 3 ? undefined : "請先標記全班完成，才能下載 PDF"}
                  data-guide="review-download-all"
                  variant={workStage === 3 ? "success" : "neutral"}
                  size="sm"
                  className="flex-1"
                >
                  {renderingAll ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {renderAllProgress ? `${renderAllProgress.current}/${renderAllProgress.total}` : "產生中..."}
                    </>
                  ) : (
                    <><Package className="h-4 w-4" />PDF ZIP</>
                  )}
                </Button>
                <Button
                  onClick={onDownloadAllImages}
                  disabled={isBatchRendering || workStage !== 3}
                  title={workStage === 3 ? undefined : "請先標記全班完成，才能下載圖片"}
                  variant={workStage === 3 ? "info" : "neutral"}
                  size="sm"
                  className="flex-1"
                >
                  {renderingAllImages ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {renderAllImagesProgress ? `${renderAllImagesProgress.current}/${renderAllImagesProgress.total}` : "產生中..."}
                    </>
                  ) : (
                    <><ImageDown className="h-4 w-4" />{isAllImagesShareReady ? "開始分享" : "全部圖片"}</>
                  )}
                </Button>
              </div>
              {canDownloadPrint && (
                <SegmentedControl
                  value={outputMode}
                  onChange={onOutputModeChange}
                  size="sm"
                  options={[
                    { value: "print", label: "列印畫質", icon: Printer },
                    { value: "screen", label: "螢幕畫質", icon: Monitor },
                  ]}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </Surface>
  );
}
