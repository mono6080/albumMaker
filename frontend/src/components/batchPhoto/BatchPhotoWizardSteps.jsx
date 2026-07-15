import { AlertTriangle, Image as ImageIcon, Upload, X } from "lucide-react";

import AssignmentBoard from "../AssignmentBoard";
import { Badge, Surface } from "../ui";
import { getUploadStatusLabel } from "../../utils/batchPhotoWizardPresentation";

const NAMED_SLOT_STRATEGIES = new Set(["namePageSlot", "nameSlotSequence"]);

export function BatchPhotoWizardFileStep({
  isFilenameScope,
  files,
  students,
  fileInputRef,
  onDrop,
  onFilesSelected,
  onClearFiles,
  onRemoveFile,
  getFileUrl,
}) {
  const filenameHint = isFilenameScope
    ? <>支援 JPEG、PNG、WebP、HEIC；檔名需含學生姓名與格位，例如 <code>小明1-2.jpg</code> 或 <code>小明3.jpg</code></>
    : <>支援 JPEG、PNG、WebP、HEIC；檔名可含學生姓名，例如 <code>小明.jpg</code></>;

  return (
    <div className="space-y-4">
      <div
        onDragOver={event => event.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-10 text-center hover:border-indigo-400 hover:bg-indigo-50/40"
      >
        <Upload className="h-8 w-8 text-gray-400" />
        <p className="text-sm font-medium text-gray-700">拖入照片或點此選擇檔案</p>
        <p className="text-xs text-gray-500">
          已選 <strong className="text-gray-800">{files.length}</strong> 張
          {" / "}班上 <strong className="text-gray-800">{students.length}</strong> 位學生
        </p>
        <p className="text-[11px] text-gray-400">{filenameHint}</p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.hif"
        multiple
        className="hidden"
        onChange={event => {
          if (event.target.files?.length) onFilesSelected(event.target.files);
          event.target.value = "";
        }}
      />

      {files.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">已選檔案</span>
            <button
              type="button"
              onClick={onClearFiles}
              className="text-xs text-gray-400 hover:text-red-500"
            >
              全部清除
            </button>
          </div>
          <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 sm:grid-cols-6">
            {files.map(file => (
              <FileTile
                key={`${file.name}__${file.lastModified}`}
                file={file}
                url={getFileUrl(file)}
                onRemove={() => onRemoveFile(file)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function BatchPhotoWizardStrategyStep({
  isFilenameScope,
  strategy,
  onStrategyChange,
  matchResult,
  files,
  students,
  targetSlot,
}) {
  const strategies = isFilenameScope
    ? [
        { id: "namePageSlot", label: "姓名 + 頁-格", hint: "如 小明1-2.jpg，代表小明第 1 頁第 2 格" },
        { id: "nameSlotSequence", label: "姓名 + 流水格", hint: "如 小明3.jpg，代表整本相本第 3 個照片格" },
      ]
    : [
        { id: "name", label: "依檔名姓名配對", hint: "檔名包含學生姓名子字串時自動配對（長名優先）" },
        { id: "sequence", label: "依檔名順序對名單順序", hint: "檔名字典序對學生 order_index 順序 1 對 1" },
        { id: "manual", label: "手動分配", hint: "跳過自動配對，直接在下一步逐位指派" },
      ];
  const matched = matchResult.assignments.length;
  const invalidCount = matchResult.invalid?.length ?? 0;
  const isNamedSlotStrategy = NAMED_SLOT_STRATEGIES.has(strategy);
  const total = isNamedSlotStrategy ? files.length : students.length;

  return (
    <div className="space-y-4">
      <div className={`grid gap-2 ${isFilenameScope ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {strategies.map(strategyOption => (
          <button
            type="button"
            key={strategyOption.id}
            onClick={() => onStrategyChange(strategyOption.id)}
            className={`rounded-lg border px-3 py-3 text-left transition-colors ${
              strategy === strategyOption.id
                ? "border-indigo-500 bg-indigo-50/60 shadow-sm"
                : "border-gray-200 bg-white hover:border-gray-300"
            }`}
          >
            <div className="text-sm font-semibold text-gray-800">{strategyOption.label}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-gray-500">{strategyOption.hint}</div>
          </button>
        ))}
      </div>

      <Surface variant="panel" padding="md" className="bg-gray-50">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={matched === total && total > 0 ? "success" : "primary"}>
            {matched} / {total} 已配對
          </Badge>
          {isNamedSlotStrategy && invalidCount > 0 && (
            <span className="text-red-600">{invalidCount} 張檔名無法解析</span>
          )}
          {!isNamedSlotStrategy && !targetSlot && (
            <span className="text-amber-700">請先選擇上方照片格，或改用檔名指定格位模式</span>
          )}
          {matchResult.unmatched.length > 0 && (
            <span className="text-amber-700">⚠ {matchResult.unmatched.length} 位學生未配對</span>
          )}
          {matchResult.unused.length > 0 && (
            <span className="text-gray-500">{matchResult.unused.length} 張照片未使用</span>
          )}
        </div>
      </Surface>

      {isNamedSlotStrategy && invalidCount > 0 && (
        <Surface variant="panel" padding="md" className="border-red-100 bg-red-50/40">
          <div className="mb-2 text-xs font-semibold text-red-700">無法解析的檔案</div>
          <ul className="max-h-28 space-y-1 overflow-y-auto text-xs text-red-700">
            {matchResult.invalid.map((item, index) => (
              <li key={`${item.file.name}-${index}`}>
                {item.file.name}
                <span className="ml-1 text-red-500">（{item.reason}）</span>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}

export function BatchPhotoWizardReviewStep({
  uploadOutcome,
  students,
  strategy,
  matchResult,
  overwriteExisting,
  onOverwriteExistingChange,
  uploadStatus,
  files,
  getFileUrl,
  onAssign,
  onClearAssignment,
  onSwapAssignments,
}) {
  const isNamedSlotStrategy = NAMED_SLOT_STRATEGIES.has(strategy);
  return (
    <div className="space-y-4">
      {uploadOutcome ? (
        <UploadOutcomePanel outcome={uploadOutcome} students={students} />
      ) : isNamedSlotStrategy ? (
        <>
          <NamedSlotAssignmentTable
            assignments={matchResult.assignments}
            invalid={matchResult.invalid}
            students={students}
          />
          <OverwriteControl
            overwriteExisting={overwriteExisting}
            onChange={onOverwriteExistingChange}
          />
          {uploadStatus !== null && <UploadProgress status={uploadStatus} />}
        </>
      ) : (
        <>
          <AssignmentBoard
            students={students}
            matchResult={matchResult}
            files={files}
            getUrl={getFileUrl}
            onAssign={onAssign}
            onClear={onClearAssignment}
            onSwap={onSwapAssignments}
          />
          <OverwriteControl
            overwriteExisting={overwriteExisting}
            onChange={onOverwriteExistingChange}
          />
          {uploadStatus !== null && <UploadProgress status={uploadStatus} />}
        </>
      )}
    </div>
  );
}

function OverwriteControl({ overwriteExisting, onChange }) {
  return (
    <label className="flex items-center gap-2 text-xs text-gray-600">
      <input type="checkbox" checked={overwriteExisting} onChange={event => onChange(event.target.checked)} />
      覆蓋學生原本已有的照片（不勾選則跳過已有照片的學生）
    </label>
  );
}

function UploadProgress({ status }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {status.chunks > 1 && `第 ${status.chunk}/${status.chunks} 批 · `}
          {status.targetLabel && `${status.targetLabel} · `}
          {getUploadStatusLabel(status)}
        </span>
        <span>{status.percent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all"
          style={{ width: `${status.percent}%` }}
        />
      </div>
    </div>
  );
}

function FileTile({ file, url, onRemove }) {
  return (
    <div className="group relative w-full overflow-hidden rounded-md border border-gray-200 bg-white pb-[100%]">
      {url ? (
        <img src={url} alt={file.name} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
        {file.name}
      </div>
      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          onRemove();
        }}
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-white/90 text-gray-700 hover:bg-red-500 hover:text-white group-hover:flex"
        aria-label="移除此檔案"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function NamedSlotAssignmentTable({ assignments, invalid = [], students }) {
  const nameById = new Map(students.map(student => [student.id, student.name]));
  return (
    <div className="space-y-3">
      <Surface variant="panel" padding="md" className="bg-gray-50">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-semibold text-gray-600">檔名指定格位</span>
          <Badge tone="primary">{assignments.length} 張可上傳</Badge>
        </div>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white">
          {assignments.length > 0 ? (
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">學生</th>
                  <th className="px-3 py-2 font-semibold">照片格</th>
                  <th className="px-3 py-2 font-semibold">檔案</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {assignments.map((assignment, index) => (
                  <tr key={`${assignment.file.name}-${index}`}>
                    <td className="px-3 py-2 font-medium text-gray-800">
                      {nameById.get(assignment.studentId) ?? `學生 #${assignment.studentId}`}
                    </td>
                    <td className="px-3 py-2 text-indigo-700">
                      P{assignment.pageIndex + 1} 格{(assignment.slotIndex ?? 0) + 1}
                    </td>
                    <td className="max-w-0 truncate px-3 py-2 text-gray-500">{assignment.file.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-6 text-center text-xs text-gray-400">沒有可上傳的配對</div>
          )}
        </div>
      </Surface>

      {invalid.length > 0 && (
        <Surface variant="panel" padding="md" className="border-red-100 bg-red-50/40">
          <div className="mb-2 text-xs font-semibold text-red-700">以下檔案不會上傳</div>
          <ul className="max-h-28 space-y-1 overflow-y-auto text-xs text-red-700">
            {invalid.map((item, index) => (
              <li key={`${item.file.name}-${index}`}>
                {item.file.name}
                <span className="ml-1 text-red-500">（{item.reason}）</span>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}

function UploadOutcomePanel({ outcome, students }) {
  const nameById = new Map(students.map(student => [student.id, student.name]));
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
            {failed.map((item, index) => (
              <li key={index}>
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
            {skipped.map((item, index) => (
              <li key={index}>{nameById.get(item.student_id) ?? `學生 #${item.student_id}`}</li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}
