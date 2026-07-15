// 批次照片分配精靈
//   Step 1 拖入或選擇多張照片
//   Step 2 選擇配對策略（單一格 / 檔名指定格位 / 手動）
//   Step 3 確認對應表 → 上傳

import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Check, ChevronLeft, ChevronRight, Loader2, X,
} from "lucide-react";

import { Badge, Button, Surface } from "./ui";
import ConfirmModal from "./ConfirmModal";
import { batchUploadPhotos } from "../api/projectApi";
import { compressImageFiles } from "../utils/imageCompression";
import { runWithConcurrency } from "../utils/concurrency";
import { isRetryableUploadError, retryDelayMs } from "../utils/uploadRetry";
import {
  assignFile, clearAssignment, emptyMatch, matchByName, matchByNamePageSlot,
  matchByNameSlotSequence, matchBySequence, swapAssignments,
} from "../utils/photoMatcher";
import { getApiErrorMessage, handleApiError } from "../utils/apiError";
import useDialogA11y from "../hooks/useDialogA11y";
import { getVisibleLayoutElements } from "../utils/layoutLayerState.js";
import {
  BatchPhotoWizardFileStep,
  BatchPhotoWizardReviewStep,
  BatchPhotoWizardStrategyStep,
} from "./batchPhoto/BatchPhotoWizardSteps";
import { getUploadStatusLabel } from "../utils/batchPhotoWizardPresentation";

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
];
const ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".hif"];
const MAX_FILES_PER_BATCH = 60;
const UPLOAD_CHUNK_SIZE = 2;

// ── 小工具 ────────────────────────────────────────────────────────────────

function chunkAssignments(assignments, size) {
  const chunks = [];
  for (let i = 0; i < assignments.length; i += size) {
    chunks.push(assignments.slice(i, i + size));
  }
  return chunks;
}

function mergeBatchOutcome(target, source) {
  target.succeeded.push(...(source.succeeded ?? []));
  target.failed.push(...(source.failed ?? []));
  target.skipped.push(...(source.skipped ?? []));
}

// ── chunk 失敗自動重試 ─────────────────────────────────────────────────────
// 可重試判斷與等待時間共用 utils/uploadRetry.js

const CHUNK_MAX_ATTEMPTS = 3; // 每個 chunk 最多嘗試次數（含第一次）

function chunkFailureReason(error) {
  const detailMessage = getApiErrorMessage(error, "");
  if (detailMessage) return detailMessage;
  if (error?.code === "ECONNABORTED") return "連線逾時（伺服器可能仍在處理，補傳時會自動略過或覆蓋）";
  return "上傳失敗";
}

function getTargetLabel(target) {
  return `P${target.pageIndex + 1} 格${(target.slotIndex ?? 0) + 1}`;
}

function assignmentTarget(assignment, fallbackPageIndex, fallbackSlotId, fallbackSlotIndex) {
  return {
    pageIndex: assignment.pageIndex ?? fallbackPageIndex,
    slotId: assignment.slotId ?? fallbackSlotId,
    slotIndex: assignment.slotIndex ?? fallbackSlotIndex,
  };
}

function groupAssignmentsByTarget(assignments, fallbackPageIndex, fallbackSlotId, fallbackSlotIndex) {
  const groupsByKey = new Map();
  assignments.forEach((assignment) => {
    const target = assignmentTarget(assignment, fallbackPageIndex, fallbackSlotId, fallbackSlotIndex);
    const key = `${target.pageIndex}:${target.slotId}`;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, { ...target, assignments: [] });
    }
    groupsByKey.get(key).assignments.push({
      studentId: assignment.studentId,
      file: assignment.file,
    });
  });
  return [...groupsByKey.values()];
}

function isAcceptedImageFile(file) {
  const lowerName = file.name.toLowerCase();
  return ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

function useObjectUrls(files) {
  const [urls, setUrls] = useState({});
  useEffect(() => {
    const map = {};
    files.forEach((file) => {
      const key = `${file.name}__${file.size}__${file.lastModified}`;
      map[key] = URL.createObjectURL(file);
    });
    setUrls(map);
    return () => Object.values(map).forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  return (file) => urls[`${file.name}__${file.size}__${file.lastModified}`];
}

function ProgressDots({ step, scope }) {
  const steps = scope === "filename"
    ? ["選照片", "檔名規則", "確認匯入"]
    : ["選照片", "對應方式", "確認上傳"];
  return (
    <div className="flex items-center gap-2 text-xs">
      {steps.map((label, index) => {
        const stepNumber = index + 1;
        const active = stepNumber === step;
        const done = stepNumber < step;
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                done
                  ? "bg-emerald-500 text-white"
                  : active
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : stepNumber}
            </span>
            <span className={active ? "font-semibold text-gray-800" : "text-gray-400"}>{label}</span>
            {stepNumber < steps.length && <span className="text-gray-300">→</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── 主元件 ────────────────────────────────────────────────────────────────

export default function BatchPhotoWizard({
  isOpen,
  projectId,
  templateRevision,
  template,
  students,
  scope = "slot",
  pageIndex,   // 由主畫面決定，不可在 Modal 內變更
  slotId,      // 由主畫面決定，不可在 Modal 內變更
  onClose,
  onUploaded,
}) {
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState([]);
  const [strategy, setStrategy] = useState("name");
  const [matchResult, setMatchResult] = useState(emptyMatch([], []));
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [uploadOutcome, setUploadOutcome] = useState(null);
  const [failedChunks, setFailedChunks] = useState([]); // 重試後仍失敗的 chunk，供「補傳」使用
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const fileInputRef = useRef(null);

  // 已選檔案且尚未完成上傳時，誤觸背板/X 會丟掉選擇與手動配對——先確認再關
  const requestClose = () => {
    if (isUploading) return;
    if (files.length > 0 && !uploadOutcome) {
      setIsCloseConfirmOpen(true);
      return;
    }
    onClose();
  };
  const dialogRef = useDialogA11y({
    isOpen,
    onClose: requestClose,
    closeOnEscape: !isUploading && !isCloseConfirmOpen,
  });

  const pages = useMemo(() => template?.pages || [], [template]);
  const isFilenameScope = scope === "filename";
  const activePage = pages[pageIndex];
  const activePageSlots = getVisibleLayoutElements(activePage?.layout, "photo");
  const targetSlot = activePageSlots.find((s) => String(s.id) === String(slotId));
  const targetSlotIndex = activePageSlots.findIndex((s) => String(s.id) === String(slotId));

  // 重置狀態
  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setFiles([]);
    setStrategy(isFilenameScope ? "namePageSlot" : "name");
    setMatchResult(emptyMatch([], []));
    setOverwriteExisting(true);
    setUploadStatus(null);
    setUploadOutcome(null);
    setIsUploading(false);
  }, [isOpen, isFilenameScope]);

  // 策略或檔案變動時重算配對
  useEffect(() => {
    if (strategy === "name") {
      setMatchResult(matchByName(students, files));
    } else if (strategy === "sequence") {
      setMatchResult(matchBySequence(students, files));
    } else if (strategy === "namePageSlot") {
      setMatchResult(matchByNamePageSlot(students, files, pages));
    } else if (strategy === "nameSlotSequence") {
      setMatchResult(matchByNameSlotSequence(students, files, pages));
    } else {
      setMatchResult(emptyMatch(students, files));
    }
  }, [strategy, files, students, pages]);

  const getUrl = useObjectUrls(files);

  if (!isOpen) return null;

  // ── 檔案選擇 ───────────────────────────────────────────────────────────

  const handleFilesSelected = async (fileList) => {
    const incoming = Array.from(fileList);
    const acceptedRaw = incoming.filter(isAcceptedImageFile);
    const rejected = incoming.length - acceptedRaw.length;
    if (rejected > 0) toast.error(`已忽略 ${rejected} 個非 JPEG/PNG/WebP/HEIC 檔案`);

    // 選檔時就先壓縮（>1.5MB 的 JPEG/PNG/WebP 縮到長邊 2560）：
    // 校園 WiFi 上行慢，20 張原圖 80MB → 壓後 ~15MB，傳輸省 ~80%
    const accepted = await compressImageFiles(acceptedRaw);

    // 依檔名去重（同檔名後者覆蓋前者）
    const merged = new Map();
    [...files, ...accepted].forEach((f) => merged.set(f.name, f));
    const next = Array.from(merged.values());

    if (next.length > MAX_FILES_PER_BATCH) {
      toast.error(`一次最多 ${MAX_FILES_PER_BATCH} 張，已截斷`);
      setFiles(next.slice(0, MAX_FILES_PER_BATCH));
    } else {
      setFiles(next);
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) handleFilesSelected(event.dataTransfer.files);
  };

  const removeFile = (file) => {
    setFiles((prev) => prev.filter((f) => f !== file));
  };

  // ── 上傳 ───────────────────────────────────────────────────────────────

  // 逐 chunk 上傳（含自動重試）；chunk 最終失敗不中斷整批，記錄後繼續
  const runUploadChunks = async (uploadChunks, baseOutcome) => {
    const totalAssignments = uploadChunks.reduce((sum, chunk) => sum + chunk.assignments.length, 0);
    const merged = {
      ok: true,
      succeeded: [...(baseOutcome?.succeeded ?? [])],
      failed: [],
      skipped: [...(baseOutcome?.skipped ?? [])],
    };
    const stillFailedChunks = [];
    let completedAssignments = 0;

    setIsUploading(true);
    setUploadStatus({ phase: "uploading", percent: 0 });
    setUploadOutcome(null);
    try {
      // 兩路重疊：一個 chunk 在後端做影像處理時，下一個 chunk 同時在傳輸，
      // 網路與伺服器 CPU 不再互等（整批時間近乎砍半）
      const progressByChunk = new Map();
      let completedChunks = 0;

      const updateAggregateStatus = (phase, retrying, activeChunk) => {
        const partial = [...progressByChunk.values()].reduce((sum, value) => sum + value, 0);
        setUploadStatus({
          phase,
          retrying,
          percent: Math.round(((completedAssignments + partial) / totalAssignments) * 100),
          completed: completedAssignments,
          total: totalAssignments,
          chunk: Math.min(completedChunks + 1, uploadChunks.length),
          chunks: uploadChunks.length,
          targetLabel: activeChunk ? getTargetLabel(activeChunk) : undefined,
        });
      };

      const processChunk = async (chunkIndex) => {
        const chunk = uploadChunks[chunkIndex];
        let response = null;
        let chunkError = null;
        for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
          try {
            progressByChunk.set(chunkIndex, 0);
            updateAggregateStatus("uploading", attempt > 1, chunk);
            response = await batchUploadPhotos(
              projectId,
              templateRevision,
              chunk.pageIndex,
              chunk.slotId,
              chunk.assignments,
              { overwriteExisting },
              pct => {
                progressByChunk.set(chunkIndex, (pct / 100) * chunk.assignments.length);
                updateAggregateStatus(pct >= 100 ? "processing" : "uploading", attempt > 1, chunk);
              },
            );
            chunkError = null;
            break;
          } catch (error) {
            chunkError = error;
            if (!isRetryableUploadError(error) || attempt === CHUNK_MAX_ATTEMPTS) break;
            progressByChunk.set(chunkIndex, 0);
            updateAggregateStatus("uploading", true, chunk);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs(error)));
          }
        }

        if (chunkError) {
          const reason = chunkFailureReason(chunkError);
          merged.failed.push(...chunk.assignments.map(assignment => ({
            student_id: assignment.studentId,
            filename: assignment.file?.name ?? "",
            reason,
          })));
          stillFailedChunks.push(chunk);
        } else {
          mergeBatchOutcome(merged, response.data ?? {});
        }
        progressByChunk.delete(chunkIndex);
        completedAssignments += chunk.assignments.length;
        completedChunks += 1;
        updateAggregateStatus(completedChunks === uploadChunks.length ? "saving" : "uploading", false, chunk);
      };

      await runWithConcurrency(uploadChunks, 2, (_chunk, chunkIndex) => processChunk(chunkIndex));

      setUploadOutcome(merged);
      setFailedChunks(stillFailedChunks);
      const okCount = merged.succeeded.length;
      const failCount = merged.failed.length;
      const skipCount = merged.skipped.length;
      if (failCount === 0) {
        toast.success(`已上傳 ${okCount} 張` + (skipCount > 0 ? `（跳過 ${skipCount}）` : ""));
      } else {
        toast.error(`完成 ${okCount} 張，失敗 ${failCount} 張，可按「補傳失敗照片」重試`);
      }
      // 全部失敗＝什麼都沒改：不觸發 onUploaded（呼叫端據此判斷是否重載/視為已完成）
      if (okCount > 0) onUploaded?.(merged);
    } catch (error) {
      handleApiError(error, "批次上傳失敗");
    } finally {
      setIsUploading(false);
      setUploadStatus(null);
    }
  };

  const handleUpload = async () => {
    if (matchResult.assignments.length === 0) {
      toast.error("沒有可上傳的配對");
      return;
    }
    const groups = groupAssignmentsByTarget(matchResult.assignments, pageIndex, slotId, targetSlotIndex);
    const uploadChunks = groups.flatMap((group) =>
      chunkAssignments(group.assignments, UPLOAD_CHUNK_SIZE).map((chunk) => ({
        ...group,
        assignments: chunk,
      }))
    );
    await runUploadChunks(uploadChunks, null);
  };

  // 只重傳失敗的 chunk；先前成功與跳過的結果保留
  const handleRetryFailed = async () => {
    if (failedChunks.length === 0) return;
    await runUploadChunks(failedChunks, {
      succeeded: uploadOutcome?.succeeded ?? [],
      skipped: uploadOutcome?.skipped ?? [],
    });
  };

  // ── 共用元件 ───────────────────────────────────────────────────────────

  const canGoStep2 = files.length > 0;
  const hasUsableTarget = isFilenameScope || !!targetSlot;
  const canGoStep3 = matchResult.assignments.length > 0 && hasUsableTarget;
  const canAdvanceFromStrategy = strategy === "manual"
    ? hasUsableTarget
    : canGoStep3;

  const renderStepBody = () => {
    if (step === 1) {
      return (
        <BatchPhotoWizardFileStep
          isFilenameScope={isFilenameScope}
          files={files}
          students={students}
          fileInputRef={fileInputRef}
          onDrop={handleDrop}
          onFilesSelected={handleFilesSelected}
          onClearFiles={() => setFiles([])}
          onRemoveFile={removeFile}
          getFileUrl={getUrl}
        />
      );
    }

    if (step === 2) {
      return (
        <BatchPhotoWizardStrategyStep
          isFilenameScope={isFilenameScope}
          strategy={strategy}
          onStrategyChange={setStrategy}
          matchResult={matchResult}
          files={files}
          students={students}
          targetSlot={targetSlot}
        />
      );
    }

    return (
      <BatchPhotoWizardReviewStep
        uploadOutcome={uploadOutcome}
        students={students}
        strategy={strategy}
        matchResult={matchResult}
        overwriteExisting={overwriteExisting}
        onOverwriteExistingChange={setOverwriteExisting}
        uploadStatus={uploadStatus}
        files={files}
        getFileUrl={getUrl}
        onAssign={(studentId, file) => setMatchResult(previous => assignFile(previous, studentId, file))}
        onClearAssignment={studentId => setMatchResult(previous => clearAssignment(previous, studentId))}
        onSwapAssignments={(firstStudentId, secondStudentId) => (
          setMatchResult(previous => swapAssignments(previous, firstStudentId, secondStudentId))
        )}
      />
    );
  };

  // ── 主框架 ────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={isUploading ? undefined : requestClose}
    >
      <Surface
        ref={dialogRef}
        tabIndex={-1}
        variant="dialog"
        padding="lg"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-photo-wizard-title"
      >
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <h2 id="batch-photo-wizard-title" className="text-base font-semibold text-gray-900">
              {isFilenameScope ? "依檔名指定格位" : "批次照片分配"}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {isFilenameScope ? (
                <>
                  檔名需包含學生姓名與格位，例如 <code>小明1-2.jpg</code> 或 <code>小明3.jpg</code>
                </>
              ) : (
                <>
                  目標位置：
                  {targetSlot ? (
                    <>
                      <Badge tone="primary" className="mx-1">第 {pageIndex + 1} 頁</Badge>
                      <Badge tone="info" className="mr-1">格位 {targetSlotIndex + 1}</Badge>
                      <span className="text-gray-400">（{targetSlot.width}×{targetSlot.height}）</span>
                    </>
                  ) : (
                    <span className="ml-1 text-amber-600">未選單一格</span>
                  )}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isUploading}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
            aria-label="關閉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ProgressDots step={step} scope={scope} />

        <div className="min-h-[260px] flex-1 overflow-y-auto pr-1">{renderStepBody()}</div>

        <div className="flex items-center justify-between border-t border-gray-100 pt-3">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1 || isUploading || !!uploadOutcome}
          >
            <ChevronLeft className="h-4 w-4" /> 上一步
          </Button>

          {step < 3 && (
            <Button
              variant="primary"
              onClick={() => setStep((s) => s + 1)}
              disabled={
                (step === 1 && !canGoStep2) ||
                (step === 2 && !canAdvanceFromStrategy)
              }
            >
              下一步 <ChevronRight className="h-4 w-4" />
            </Button>
          )}

          {step === 3 && !uploadOutcome && (
            <Button
              variant="success"
              onClick={handleUpload}
              disabled={isUploading || matchResult.assignments.length === 0 || !hasUsableTarget}
            >
              {isUploading ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {getUploadStatusLabel(uploadStatus)}...</>
              ) : (
                <>上傳 {matchResult.assignments.length} 張</>
              )}
            </Button>
          )}

          {step === 3 && uploadOutcome && failedChunks.length > 0 && (
            <Button variant="success" onClick={handleRetryFailed} disabled={isUploading}>
              補傳失敗的 {failedChunks.reduce((sum, chunk) => sum + chunk.assignments.length, 0)} 張
            </Button>
          )}
          {step === 3 && uploadOutcome && (
            <Button variant="primary" onClick={onClose}>完成</Button>
          )}
        </div>
      </Surface>

      {/* stopPropagation：確認框的點擊不能冒泡到精靈背板，否則取消後又觸發 requestClose */}
      <div onClick={(e) => e.stopPropagation()}>
        <ConfirmModal
          isOpen={isCloseConfirmOpen}
          message="尚未上傳，關閉後已選的照片與配對會消失。確定關閉？"
          confirmLabel="關閉並放棄"
          confirmVariant="danger"
          onConfirm={() => { setIsCloseConfirmOpen(false); onClose(); }}
          onCancel={() => setIsCloseConfirmOpen(false)}
        />
      </div>
    </div>
  );
}
