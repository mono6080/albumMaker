// 本期學生快照 Modal（班級工作台用）
// 完整姓名由建立相本當下的班級名單固定帶入；相本內只調整顯示稱呼。

import { useState } from "react";
import toast from "react-hot-toast";
import { Check, Loader2, Pencil, RotateCcw, Sparkles, Users, X } from "lucide-react";

import {
  autoFillStudentAlbumName,
  autoFillStudentAlbumNames,
  updateStudentAlbumName,
} from "../api/projectApi";
import { showRetryToast } from "../utils/retryToast";
import FormModal from "./FormModal";
import { Badge, Button, IconButton, fieldControlClass } from "./ui";

const hasAlbumName = student => Boolean((student.album_name || "").trim());

export default function RosterModal({
  isOpen,
  onClose,
  projectId,
  students,
  // 每位學生的照片進度（Map: studentId → {filled,total}），沒有就不顯示徽章
  photoProgressByStudentId = null,
  onChanged,
  isLocked = false,
}) {
  const [editingAlbumNameId, setEditingAlbumNameId] = useState(null);
  const [albumNameInput, setAlbumNameInput] = useState("");
  const [updatingAlbumNameId, setUpdatingAlbumNameId] = useState(null);
  const [isAutoFillingAlbumNames, setIsAutoFillingAlbumNames] = useState(false);
  const [autoFillingAlbumNameId, setAutoFillingAlbumNameId] = useState(null);
  const isAutoFillingAnyAlbumName =
    isAutoFillingAlbumNames || autoFillingAlbumNameId !== null;
  const unsetAlbumNameCount = students.filter(
    student => !hasAlbumName(student),
  ).length;

  const handleAutoFillAlbumNames = async () => {
    setIsAutoFillingAlbumNames(true);
    try {
      const response = await autoFillStudentAlbumNames(projectId);
      const { updated = 0, unresolved = 0 } = response.data || {};
      await onChanged();

      if (updated > 0 && unresolved > 0) {
        toast.success(`已自動填入 ${updated} 位學生；${unresolved} 位需手動確認`);
      } else if (updated > 0) {
        toast.success(`已自動填入 ${updated} 位學生的相本稱呼`);
      } else if (unresolved > 0) {
        toast.error(`沒有可安全自動填入的相本稱呼；${unresolved} 位需手動確認`);
      } else {
        toast("目前沒有未設定的相本稱呼");
      }
    } catch {
      showRetryToast("自動填入相本稱呼失敗", handleAutoFillAlbumNames);
    } finally {
      setIsAutoFillingAlbumNames(false);
    }
  };

  const handleAutoFillStudentAlbumName = async (student) => {
    setAutoFillingAlbumNameId(student.id);
    try {
      const response = await autoFillStudentAlbumName(projectId, student.id);
      const { updated = 0, unresolved = 0 } = response.data || {};
      await onChanged();

      if (updated > 0) {
        toast.success(`已自動填入「${student.name}」的相本稱呼`);
      } else if (unresolved > 0) {
        toast.error(`無法安全判斷「${student.name}」的相本稱呼，請手動設定`);
      } else {
        toast(`「${student.name}」目前不需自動填入`);
      }
    } catch {
      showRetryToast(
        `自動偵測「${student.name}」的相本稱呼失敗`,
        () => handleAutoFillStudentAlbumName(student),
      );
    } finally {
      setAutoFillingAlbumNameId(null);
    }
  };

  const cancelAlbumNameEdit = () => {
    setEditingAlbumNameId(null);
    setAlbumNameInput("");
  };

  const startAlbumNameEdit = (student) => {
    setEditingAlbumNameId(student.id);
    setAlbumNameInput(student.album_name ?? "");
  };

  const saveAlbumName = async (student, nextValue = albumNameInput) => {
    const normalizedAlbumName = nextValue.trim();
    cancelAlbumNameEdit();

    const applyAlbumName = async () => {
      setUpdatingAlbumNameId(student.id);
      try {
        await updateStudentAlbumName(projectId, student.id, normalizedAlbumName);
        toast.success(normalizedAlbumName
          ? `已更新「${student.name}」的相本稱呼`
          : `「${student.name}」已改回沿用完整姓名`);
        await onChanged();
      } catch {
        showRetryToast("相本稱呼更新失敗", applyAlbumName);
      } finally {
        setUpdatingAlbumNameId(null);
      }
    };
    await applyAlbumName();
  };

  return (
    <FormModal
      isOpen={isOpen}
      title="本期學生快照"
      onClose={() => {
        cancelAlbumNameEdit();
        onClose();
      }}
    >
      <div data-guide="roster-modal">
        <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/70 px-3 py-3 text-sm leading-6 text-indigo-900">
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-600" />
            <p>
              這份名單由建立相本當下的班級目前學生形成固定快照。完整姓名在相本內唯讀；
              這裡只調整本期版面使用的相本稱呼。班級名單若有誤，請管理員回園所設定修正。
            </p>
          </div>
        </div>

        {isLocked && (
          <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            相本已標記全班完成，本期相本稱呼已鎖定。
          </p>
        )}

        <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            本期學生（{students.length} 位）
          </div>
          {!isLocked && (
            <Button
              size="xs"
              variant="secondary"
              onClick={handleAutoFillAlbumNames}
              disabled={
                isAutoFillingAnyAlbumName ||
                updatingAlbumNameId !== null ||
                editingAlbumNameId !== null ||
                unsetAlbumNameCount === 0
              }
            >
              {isAutoFillingAlbumNames
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Sparkles className="h-3.5 w-3.5" />}
              {isAutoFillingAlbumNames ? "偵測中…" : "自動填入相本稱呼"}
            </Button>
          )}
        </div>
        {!isLocked && students.length > 0 && (
          <p className="mb-2 text-xs text-gray-500">
            只填入尚未設定且可安全判斷的稱呼，不會覆蓋已修改內容；無法判斷或重複衝突者需手動設定。
          </p>
        )}
        {students.length === 0 ? (
          <p className="py-6 text-center text-sm leading-6 text-gray-400">
            此相本沒有學生快照。請管理員確認遷移資料，或從正確班級重新建立本期相本。
          </p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {students.map((student, index) => {
              const progress = photoProgressByStudentId?.get(student.id);
              const isPhotoComplete = progress && progress.total > 0 && progress.filled === progress.total;
              const isEditingAlbumName = editingAlbumNameId === student.id;
              const isUpdatingAlbumName = updatingAlbumNameId === student.id;
              const isAutoFillingThisAlbumName = autoFillingAlbumNameId === student.id;
              const studentHasAlbumName = hasAlbumName(student);
              return (
                <div key={student.id} className="group flex min-w-0 items-start gap-2 rounded-xl px-2 py-2 hover:bg-gray-50">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-500">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-800">
                      {student.name}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-400">完整姓名 · 固定快照</div>

                    {isEditingAlbumName ? (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <input
                          autoFocus
                          aria-label={`相本稱呼：${student.name}`}
                          className={`${fieldControlClass} flex-1 py-0.5 text-sm`}
                          placeholder="留空會沿用完整姓名"
                          maxLength={100}
                          value={albumNameInput}
                          onChange={event => setAlbumNameInput(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") saveAlbumName(student);
                            if (event.key === "Escape") cancelAlbumNameEdit();
                          }}
                        />
                        <IconButton
                          label="儲存相本稱呼"
                          variant="success"
                          size="xs"
                          onClick={() => saveAlbumName(student)}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton label="取消編輯相本稱呼" size="xs" onClick={cancelAlbumNameEdit}>
                          <X className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    ) : (
                      <div className="mt-1 truncate text-xs text-gray-500">
                        相本稱呼：{studentHasAlbumName
                          ? student.effective_album_name
                          : "沿用完整姓名"}
                      </div>
                    )}
                  </div>

                  {!isEditingAlbumName && (
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {progress && progress.total > 0 && (
                        <Badge tone={isPhotoComplete ? "success" : "warning"}>
                          {isPhotoComplete ? "✓ 照片齊" : `照片 ${progress.filled}/${progress.total}`}
                        </Badge>
                      )}
                      <IconButton
                        label={`編輯 ${student.name} 的相本稱呼`}
                        disabled={isLocked || isAutoFillingAnyAlbumName || isUpdatingAlbumName}
                        variant="primary"
                        size="xs"
                        onClick={() => startAlbumNameEdit(student)}
                      >
                        <Pencil className="h-3 w-3" />
                      </IconButton>
                      {!studentHasAlbumName && (
                        <IconButton
                          label={`自動偵測 ${student.name} 的相本稱呼`}
                          disabled={
                            isLocked ||
                            isAutoFillingAnyAlbumName ||
                            updatingAlbumNameId !== null ||
                            editingAlbumNameId !== null
                          }
                          variant="info"
                          size="xs"
                          onClick={() => handleAutoFillStudentAlbumName(student)}
                        >
                          {isAutoFillingThisAlbumName
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Sparkles className="h-3 w-3" />}
                        </IconButton>
                      )}
                      {studentHasAlbumName && (
                        <IconButton
                          label={`清除 ${student.name} 的相本稱呼`}
                          disabled={isLocked || isAutoFillingAnyAlbumName || isUpdatingAlbumName}
                          size="xs"
                          onClick={() => saveAlbumName(student, "")}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </IconButton>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FormModal>
  );
}
