// 批次照片分配精靈（4 步驟 Modal）
//   Step 1 選頁面與照片格
//   Step 2 拖入或選擇多張照片
//   Step 3 選擇配對策略（依姓名 / 依順序 / 手動）
//   Step 4 確認對應表 → 上傳

import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, Image as ImageIcon,
  Loader2, Upload, X,
} from "lucide-react";

import { Badge, Button, Surface } from "./ui";
import { batchUploadPhotos } from "../api/projectApi";
import {
  assignFile, clearAssignment, emptyMatch, matchByName, matchBySequence, swapAssignments,
} from "../utils/photoMatcher";
import { handleApiError } from "../utils/apiError";

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

function uploadStatusLabel(status) {
  if (!status) return "";
  if (status.phase === "processing") return "處理中";
  if (status.phase === "saving") return "整理結果中";
  return "上傳中";
}

function mergeBatchOutcome(target, source) {
  target.succeeded.push(...(source.succeeded ?? []));
  target.failed.push(...(source.failed ?? []));
  target.skipped.push(...(source.skipped ?? []));
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

function ProgressDots({ step }) {
  const steps = ["選照片", "對應方式", "確認上傳"];
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
  template,
  students,
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
  const fileInputRef = useRef(null);

  const pages = template?.pages || [];
  const activePage = pages[pageIndex];
  const activePageSlots = activePage?.layout?.photo_slots || [];
  const targetSlot = activePageSlots.find((s) => String(s.id) === String(slotId));
  const targetSlotIndex = activePageSlots.findIndex((s) => String(s.id) === String(slotId));

  // 重置狀態
  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setFiles([]);
    setStrategy("name");
    setMatchResult(emptyMatch([], []));
    setOverwriteExisting(true);
    setUploadStatus(null);
    setUploadOutcome(null);
    setIsUploading(false);
  }, [isOpen]);

  // 策略或檔案變動時重算配對
  useEffect(() => {
    if (strategy === "name") {
      setMatchResult(matchByName(students, files));
    } else if (strategy === "sequence") {
      setMatchResult(matchBySequence(students, files));
    } else {
      setMatchResult(emptyMatch(students, files));
    }
  }, [strategy, files, students]);

  const getUrl = useObjectUrls(files);

  if (!isOpen) return null;
  if (!targetSlot) return null; // 父層應確保有效；防呆而已

  // ── 檔案選擇 ───────────────────────────────────────────────────────────

  const handleFilesSelected = (fileList) => {
    const incoming = Array.from(fileList);
    const accepted = incoming.filter(isAcceptedImageFile);
    const rejected = incoming.length - accepted.length;
    if (rejected > 0) toast.error(`已忽略 ${rejected} 個非 JPEG/PNG/WebP/HEIC 檔案`);

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

  const handleUpload = async () => {
    if (matchResult.assignments.length === 0) {
      toast.error("沒有可上傳的配對");
      return;
    }
    setIsUploading(true);
    setUploadStatus({ phase: "uploading", percent: 0 });
    setUploadOutcome(null);
    try {
      const assignments = matchResult.assignments;
      const chunks = chunkAssignments(assignments, UPLOAD_CHUNK_SIZE);
      const merged = {
        ok: true,
        page_index: pageIndex,
        slot_id: slotId,
        succeeded: [],
        failed: [],
        skipped: [],
      };
      let completedAssignments = 0;

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const updateChunkStatus = (phase, chunkPercent) => {
          const weightedProgress = completedAssignments + (chunkPercent / 100) * chunk.length;
          setUploadStatus({
            phase,
            percent: Math.round((weightedProgress / assignments.length) * 100),
            completed: completedAssignments,
            total: assignments.length,
            chunk: chunkIndex + 1,
            chunks: chunks.length,
          });
        };

        updateChunkStatus("uploading", 0);
        const response = await batchUploadPhotos(
          projectId,
          pageIndex,
          slotId,
          chunk,
          { overwriteExisting },
          pct => updateChunkStatus(pct >= 100 ? "processing" : "uploading", pct),
        );
        mergeBatchOutcome(merged, response.data ?? {});
        completedAssignments += chunk.length;
        setUploadStatus({
          phase: chunkIndex === chunks.length - 1 ? "saving" : "uploading",
          percent: Math.round((completedAssignments / assignments.length) * 100),
          completed: completedAssignments,
          total: assignments.length,
          chunk: chunkIndex + 1,
          chunks: chunks.length,
        });
      }

      setUploadOutcome(merged);
      const okCount = merged.succeeded.length;
      const failCount = merged.failed.length;
      const skipCount = merged.skipped.length;
      if (failCount === 0) {
        toast.success(`已上傳 ${okCount} 張` + (skipCount > 0 ? `（跳過 ${skipCount}）` : ""));
      } else {
        toast.error(`完成 ${okCount} 張，失敗 ${failCount} 張`);
      }
      onUploaded?.(merged);
    } catch (error) {
      handleApiError(error, "批次上傳失敗");
    } finally {
      setIsUploading(false);
      setUploadStatus(null);
    }
  };

  // ── 共用元件 ───────────────────────────────────────────────────────────

  const canGoStep2 = files.length > 0;
  const canGoStep3 = matchResult.assignments.length > 0;

  const renderStepBody = () => {
    if (step === 1) {
      return (
        <div className="space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center hover:border-indigo-400 hover:bg-indigo-50/40"
          >
            <Upload className="h-8 w-8 text-gray-400" />
            <p className="text-sm font-medium text-gray-700">拖入照片或點此選擇檔案</p>
            <p className="text-xs text-gray-500">
              已選 <strong className="text-gray-800">{files.length}</strong> 張
              {" / "}班上 <strong className="text-gray-800">{students.length}</strong> 位學生
            </p>
            <p className="text-[11px] text-gray-400">
              支援 JPEG、PNG、WebP、HEIC；建議檔名包含學生姓名（如 <code>小明.jpg</code>）以自動配對
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.hif"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleFilesSelected(e.target.files);
              e.target.value = "";
            }}
          />

          {files.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                  已選檔案
                </span>
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="text-xs text-gray-400 hover:text-red-500"
                >
                  全部清除
                </button>
              </div>
              <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 sm:grid-cols-6">
                {files.map((file) => (
                  <FileTile
                    key={`${file.name}__${file.lastModified}`}
                    file={file}
                    url={getUrl(file)}
                    onRemove={() => removeFile(file)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (step === 2) {
      const strategies = [
        { id: "name", label: "依檔名姓名配對", hint: "檔名包含學生姓名子字串時自動配對（長名優先）" },
        { id: "sequence", label: "依檔名順序對名單順序", hint: "檔名字典序對學生 order_index 順序 1 對 1" },
        { id: "manual", label: "手動分配", hint: "跳過自動配對，直接在下一步逐位指派" },
      ];
      const matched = matchResult.assignments.length;
      const total = students.length;
      return (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {strategies.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => setStrategy(s.id)}
                className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                  strategy === s.id
                    ? "border-indigo-500 bg-indigo-50/60 shadow-sm"
                    : "border-gray-200 bg-white hover:border-gray-300"
                }`}
              >
                <div className="text-sm font-semibold text-gray-800">{s.label}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-gray-500">{s.hint}</div>
              </button>
            ))}
          </div>

          <Surface variant="panel" padding="md" className="bg-gray-50">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge tone={matched === total && total > 0 ? "success" : "primary"}>
                {matched} / {total} 已配對
              </Badge>
              {matchResult.unmatched.length > 0 && (
                <span className="text-amber-700">
                  ⚠ {matchResult.unmatched.length} 位學生未配對
                </span>
              )}
              {matchResult.unused.length > 0 && (
                <span className="text-gray-500">
                  {matchResult.unused.length} 張照片未使用
                </span>
              )}
            </div>
          </Surface>
        </div>
      );
    }

    // step === 3
    return (
      <div className="space-y-4">
        {uploadOutcome ? (
          <UploadOutcomePanel outcome={uploadOutcome} students={students} />
        ) : (
          <>
            <AssignmentBoard
              students={students}
              matchResult={matchResult}
              files={files}
              getUrl={getUrl}
              onAssign={(studentId, file) => setMatchResult((prev) => assignFile(prev, studentId, file))}
              onClear={(studentId) => setMatchResult((prev) => clearAssignment(prev, studentId))}
              onSwap={(studentIdA, studentIdB) => setMatchResult((prev) => swapAssignments(prev, studentIdA, studentIdB))}
            />

            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={overwriteExisting}
                onChange={(e) => setOverwriteExisting(e.target.checked)}
              />
              覆蓋學生原本已有的照片（不勾選則跳過已有照片的學生）
            </label>

            {uploadStatus !== null && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {uploadStatus.chunks > 1 && `第 ${uploadStatus.chunk}/${uploadStatus.chunks} 批 · `}
                    {uploadStatusLabel(uploadStatus)}
                  </span>
                  <span>{uploadStatus.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-all"
                    style={{ width: `${uploadStatus.percent}%` }}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ── 主框架 ────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={isUploading ? undefined : onClose}
    >
      <Surface
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
              批次照片分配
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              目標位置：
              <Badge tone="primary" className="mx-1">第 {pageIndex + 1} 頁</Badge>
              <Badge tone="info" className="mr-1">格位 {targetSlotIndex + 1}</Badge>
              <span className="text-gray-400">（{targetSlot.width}×{targetSlot.height}）</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
            aria-label="關閉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ProgressDots step={step} />

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
                (step === 2 && !canGoStep3 && strategy !== "manual")
              }
            >
              下一步 <ChevronRight className="h-4 w-4" />
            </Button>
          )}

          {step === 3 && !uploadOutcome && (
            <Button
              variant="success"
              onClick={handleUpload}
              disabled={isUploading || matchResult.assignments.length === 0}
            >
              {isUploading ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> {uploadStatusLabel(uploadStatus)}...</>
              ) : (
                <>上傳 {matchResult.assignments.length} 張</>
              )}
            </Button>
          )}

          {step === 3 && uploadOutcome && (
            <Button variant="primary" onClick={onClose}>完成</Button>
          )}
        </div>
      </Surface>
    </div>
  );
}

// ── 子元件 ────────────────────────────────────────────────────────────────

function FileTile({ file, url, onRemove }) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-gray-200 bg-white">
      {url ? (
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-gray-300">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
        {file.name}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-white/90 text-gray-700 hover:bg-red-500 hover:text-white group-hover:flex"
        aria-label="移除此檔案"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// 拖曳用：DataTransfer 自訂 MIME，不污染瀏覽器其他 drag 事件
const DRAG_FILE = "application/x-batch-photo-file";
const DRAG_STUDENT = "application/x-batch-photo-student";

function fileKey(file) {
  return `${file.name}__${file.size}__${file.lastModified}`;
}

function AssignmentBoard({ students, matchResult, files, getUrl, onAssign, onClear, onSwap }) {
  const [focusedFileKey, setFocusedFileKey] = useState(null);
  const [dropHintTarget, setDropHintTarget] = useState(null); // { kind: "student"|"pool", id? }

  const assignmentByStudent = useMemo(() => {
    const map = new Map();
    matchResult.assignments.forEach((a) => map.set(a.studentId, a.file));
    return map;
  }, [matchResult]);

  const studentByFileKey = useMemo(() => {
    const map = new Map();
    matchResult.assignments.forEach((a) => map.set(fileKey(a.file), a.studentId));
    return map;
  }, [matchResult]);

  const fileByKey = useMemo(() => {
    const map = new Map();
    files.forEach((f) => map.set(fileKey(f), f));
    return map;
  }, [files]);

  const studentById = useMemo(() => {
    const map = new Map();
    students.forEach((s) => map.set(s.id, s));
    return map;
  }, [students]);

  const focusedFile = focusedFileKey ? fileByKey.get(focusedFileKey) : null;

  // ── 拖曳事件 ──────────────────────────────────────────────────────────

  const handleFileDragStart = (file) => (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_FILE, fileKey(file));
  };

  const handleStudentDragStart = (studentId) => (event) => {
    // 沒有照片的學生不能拖（沒東西可搬）
    if (!assignmentByStudent.get(studentId)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_STUDENT, String(studentId));
  };

  const allowDrop = (kind, id) => (event) => {
    if (event.dataTransfer.types.includes(DRAG_FILE) || event.dataTransfer.types.includes(DRAG_STUDENT)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const next = { kind, id };
      if (!dropHintTarget || dropHintTarget.kind !== kind || dropHintTarget.id !== id) {
        setDropHintTarget(next);
      }
    }
  };

  const handleDragLeave = () => setDropHintTarget(null);

  const handleDropOnStudent = (studentId) => (event) => {
    event.preventDefault();
    setDropHintTarget(null);
    const fileK = event.dataTransfer.getData(DRAG_FILE);
    if (fileK) {
      const file = fileByKey.get(fileK);
      if (file) onAssign(studentId, file);
      return;
    }
    const srcStudent = event.dataTransfer.getData(DRAG_STUDENT);
    if (srcStudent) {
      const srcId = Number(srcStudent);
      if (srcId !== studentId) onSwap(srcId, studentId);
    }
  };

  const handleDropOnPool = (event) => {
    event.preventDefault();
    setDropHintTarget(null);
    const srcStudent = event.dataTransfer.getData(DRAG_STUDENT);
    if (srcStudent) {
      onClear(Number(srcStudent));
    }
  };

  // ── 點選備援（行動裝置） ──────────────────────────────────────────────

  const handleFileTap = (file) => () => {
    const key = fileKey(file);
    setFocusedFileKey(focusedFileKey === key ? null : key);
  };

  const handleStudentTap = (studentId) => () => {
    if (focusedFile) {
      onAssign(studentId, focusedFile);
      setFocusedFileKey(null);
    }
  };

  const usedKeys = new Set(matchResult.assignments.map((a) => fileKey(a.file)));
  const unusedFiles = files.filter((f) => !usedKeys.has(f));

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[11px] text-indigo-800">
        💡 拖照片到學生 → 指派；拖學生 A → 學生 B 交換；拖學生 → 下方照片池取消分配。
        <span className="hidden sm:inline">手機可改用點選：先點照片再點學生。</span>
      </div>

      {/* 學生列 */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-white p-2 sm:grid-cols-3 lg:grid-cols-4">
        {students.map((student, index) => {
          const file = assignmentByStudent.get(student.id);
          const url = file ? getUrl(file) : null;
          const isHinted = dropHintTarget?.kind === "student" && dropHintTarget.id === student.id;
          const canTapAssign = !!focusedFile;
          return (
            <div
              key={student.id}
              draggable={!!file}
              onDragStart={handleStudentDragStart(student.id)}
              onDragOver={allowDrop("student", student.id)}
              onDragLeave={handleDragLeave}
              onDrop={handleDropOnStudent(student.id)}
              onClick={handleStudentTap(student.id)}
              className={`group relative flex flex-col overflow-hidden rounded-lg border bg-white transition-all ${
                isHinted
                  ? "border-indigo-500 ring-2 ring-indigo-300"
                  : file
                  ? "border-emerald-200"
                  : canTapAssign
                  ? "border-indigo-300 ring-1 ring-indigo-200"
                  : "border-dashed border-amber-300 bg-amber-50/30"
              } ${file ? "cursor-grab active:cursor-grabbing" : canTapAssign ? "cursor-pointer" : "cursor-default"}`}
              title={file ? `${student.name} ← ${file.name}（拖移可交換）` : `${student.name}（未配對）`}
            >
              <div className="flex items-center gap-1 px-2 py-1 text-[11px]">
                <span className="text-gray-400">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{student.name}</span>
                {file && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClear(student.id); }}
                    className="rounded-full p-0.5 text-gray-300 hover:bg-red-100 hover:text-red-600"
                    aria-label={`取消 ${student.name} 的配對`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="relative aspect-square bg-gray-50">
                {url ? (
                  <img src={url} alt={file.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-amber-600">
                    <ImageIcon className="h-5 w-5 opacity-60" />
                    <span className="text-[10px]">未配對</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 照片池 */}
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        照片池（{files.length}）
        {unusedFiles.length > 0 && <span className="ml-2 text-amber-700">未使用 {unusedFiles.length}</span>}
        {focusedFile && <span className="ml-2 text-indigo-600">已選：{focusedFile.name}（點學生套用）</span>}
      </div>
      <div
        onDragOver={allowDrop("pool")}
        onDragLeave={handleDragLeave}
        onDrop={handleDropOnPool}
        className={`grid grid-cols-3 gap-2 rounded-lg border bg-gray-50/60 p-2 sm:grid-cols-6 md:grid-cols-8 ${
          dropHintTarget?.kind === "pool"
            ? "border-red-400 ring-2 ring-red-200"
            : "border-gray-200"
        }`}
      >
        {files.length === 0 && (
          <div className="col-span-full py-6 text-center text-xs text-gray-400">尚未選任何照片</div>
        )}
        {files.map((file) => {
          const url = getUrl(file);
          const assignedTo = studentByFileKey.get(fileKey(file));
          const assignedName = assignedTo ? studentById.get(assignedTo)?.name : null;
          const isFocused = fileKey(file) === focusedFileKey;
          return (
            <div
              key={fileKey(file)}
              draggable
              onDragStart={handleFileDragStart(file)}
              onClick={handleFileTap(file)}
              className={`group relative aspect-square cursor-grab overflow-hidden rounded-md border bg-white transition-all active:cursor-grabbing ${
                isFocused
                  ? "border-indigo-500 ring-2 ring-indigo-300"
                  : assignedTo
                  ? "border-emerald-300"
                  : "border-amber-300"
              }`}
              title={assignedName ? `已配對給 ${assignedName}` : "未使用，拖到學生上指派"}
            >
              {url ? (
                <img src={url} alt={file.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-gray-300">
                  <ImageIcon className="h-5 w-5" />
                </div>
              )}
              {assignedTo && (
                <div className="absolute inset-x-0 top-0 truncate bg-emerald-600/85 px-1 py-0.5 text-center text-[10px] font-medium text-white">
                  → {assignedName}
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
                {file.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UploadOutcomePanel({ outcome, students }) {
  const nameById = new Map(students.map((s) => [s.id, s.name]));
  const { succeeded = [], failed = [], skipped = [] } = outcome;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">成功 {succeeded.length}</Badge>
        {skipped.length > 0 && <Badge tone="primary">跳過 {skipped.length}</Badge>}
        {failed.length > 0 && <Badge tone="warning">失敗 {failed.length}</Badge>}
      </div>

      {failed.length > 0 && (
        <Surface variant="panel" padding="md" className="border-red-200 bg-red-50/50">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
            <AlertTriangle className="h-4 w-4" /> 失敗清單
          </div>
          <ul className="space-y-1 text-xs text-red-700">
            {failed.map((item, idx) => (
              <li key={idx}>
                {nameById.get(item.student_id) ?? `學生 #${item.student_id}`}
                <span className="text-red-400"> ← {item.filename || "(無檔名)"}</span>
                <span className="ml-1 text-red-500">（{item.reason}）</span>
              </li>
            ))}
          </ul>
        </Surface>
      )}

      {skipped.length > 0 && (
        <Surface variant="panel" padding="md" className="bg-gray-50">
          <div className="text-xs font-semibold text-gray-600">已跳過（學生已有照片）</div>
          <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
            {skipped.map((item, idx) => (
              <li key={idx}>{nameById.get(item.student_id) ?? `學生 #${item.student_id}`}</li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}
