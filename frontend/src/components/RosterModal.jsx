// 學生名單管理 Modal（班級工作台用）
// 批次貼上新增、行內改名、刪除（含確認與可重試錯誤處理）；
// 名冊自動連結規則在後端（見 docs/dev/data-model.md 孩子名冊）

import { useCallback, useState } from "react";
import toast from "react-hot-toast";
import { Check, Pencil, Plus, Users, X } from "lucide-react";

import { batchAddStudents, deleteStudent, renameStudent } from "../api/projectApi";
import { useInlineEdit } from "../hooks/useInlineEdit";
import { showRetryToast } from "../utils/retryToast";
import ConfirmModal from "./ConfirmModal";
import FormModal from "./FormModal";
import { Badge, Button, IconButton, fieldControlClass } from "./ui";

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
  const [namesInput, setNamesInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  const handleAddStudents = async () => {
    const parsedNames = namesInput
      .split(/[\n,，、]/)
      .map(name => name.trim())
      .filter(Boolean);
    if (!parsedNames.length) return;

    setIsAdding(true);
    try {
      const response = await batchAddStudents(projectId, parsedNames);
      const { created = [], skipped = [] } = response.data || {};
      setNamesInput("");
      if (created.length) toast.success(`已新增 ${created.length} 位學生`);
      if (skipped.length) toast.error(`已略過重複名稱：${skipped.join("、")}`);
      if (!created.length && !skipped.length) toast.error("未新增任何學生");
      await onChanged();
    } catch {
      showRetryToast("新增學生失敗", handleAddStudents);
    } finally {
      setIsAdding(false);
    }
  };

  const { editingId, editingValue, setEditingValue, startEdit, cancelEdit, submitEdit } =
    useInlineEdit(useCallback(async (studentId, newName) => {
      // 行內編輯已先樂觀退出編輯狀態，失敗必須明確提示
      const applyRename = async () => {
        try {
          await renameStudent(projectId, studentId, newName);
          await onChanged();
        } catch {
          showRetryToast("學生改名失敗", applyRename);
        }
      };
      await applyRename();
    }, [projectId, onChanged]));

  const handleDelete = (student) => {
    setConfirmModal({
      message: `確定刪除學生「${student.name}」？該學生的照片與文字也會一併刪除。`,
      onConfirm: async () => {
        const applyDelete = async () => {
          try {
            await deleteStudent(projectId, student.id);
            toast.success(`已刪除「${student.name}」`);
            await onChanged();
          } catch {
            showRetryToast("刪除失敗", applyDelete);
          }
        };
        await applyDelete();
      },
    });
  };

  return (
    <>
      <FormModal
        isOpen={isOpen}
        title="學生名單"
        onClose={() => {
          // 刪除確認框開啟時 Esc 會先打到這層，不可把名單 Modal 關掉
          if (confirmModal) return;
          onClose();
        }}
      >
        <div data-guide="roster-modal">
          {isLocked ? (
            <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              專案已標記全班完成，名單已鎖定。
            </p>
          ) : (
            <div className="mb-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
                <Users className="h-4 w-4 text-indigo-500" />
                批次新增
              </div>
              <div className="flex min-w-0 gap-2">
                <textarea
                  rows={3}
                  data-guide="roster-add-input"
                  className={`${fieldControlClass} flex-1 resize-none`}
                  placeholder="每行一位，或用逗號 / 頓號分隔"
                  value={namesInput}
                  onChange={event => setNamesInput(event.target.value)}
                />
                <Button
                  onClick={handleAddStudents}
                  disabled={isAdding || !namesInput.trim()}
                  data-guide="roster-add-button"
                  variant="primary"
                  className="self-stretch"
                >
                  <Plus className="h-4 w-4" />
                  新增
                </Button>
              </div>
            </div>
          )}

          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            已登記學生（{students.length} 位）
          </div>
          {students.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">尚未新增任何學生</p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {students.map((student, index) => {
                const progress = photoProgressByStudentId?.get(student.id);
                const isPhotoComplete = progress && progress.total > 0 && progress.filled === progress.total;
                return (
                  <div key={student.id} className="group flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-gray-50">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-500">
                      {index + 1}
                    </span>
                    {editingId === student.id ? (
                      <>
                        <input
                          autoFocus
                          className={`${fieldControlClass} flex-1 py-0.5`}
                          value={editingValue}
                          onChange={event => setEditingValue(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") submitEdit(student.id);
                            if (event.key === "Escape") cancelEdit();
                          }}
                        />
                        <IconButton label="儲存學生名稱" variant="success" size="xs" onClick={() => submitEdit(student.id)}>
                          <Check className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton label="取消編輯學生名稱" size="xs" onClick={cancelEdit}>
                          <X className="h-3.5 w-3.5" />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                          {student.name}
                        </span>
                        {progress && progress.total > 0 && (
                          <Badge tone={isPhotoComplete ? "success" : "warning"}>
                            {isPhotoComplete ? "✓ 照片齊" : `照片 ${progress.filled}/${progress.total}`}
                          </Badge>
                        )}
                        <IconButton
                          label="編輯學生名稱"
                          disabled={isLocked}
                          variant="primary"
                          size="xs"
                          onClick={() => startEdit(student.id, student.name)}
                        >
                          <Pencil className="h-3 w-3" />
                        </IconButton>
                        <IconButton
                          label="刪除學生"
                          disabled={isLocked}
                          variant="danger"
                          size="xs"
                          onClick={() => handleDelete(student)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </IconButton>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </FormModal>

      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
    </>
  );
}
