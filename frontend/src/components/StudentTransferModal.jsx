// 把學生搬到同一個班級期別的另一本相本。
// 同一班常見「同一套排版、兩套對應文字」，建好之後才發現要分組是常態，
// 所以這裡要講清楚搬過去會發生什麼——照片與文字跟著走，但完成狀態與已產生的
// 輸出會重做。

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ArrowRightLeft } from "lucide-react";

import { transferStudents } from "../api/projectApi";
import { getApiErrorMessage } from "../utils/apiError";
import FormModal from "./FormModal";
import { Badge, Button, FormField, fieldControlClass } from "./ui";

export default function StudentTransferModal({
  isOpen,
  onClose,
  projectId,
  students,
  transferTargets,
  onTransferred,
}) {
  const [targetProjectId, setTargetProjectId] = useState("");
  const [selectedStudentIds, setSelectedStudentIds] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setTargetProjectId(String(transferTargets[0]?.id ?? ""));
    setSelectedStudentIds([]);
  }, [isOpen, transferTargets]);

  const completedStudentIds = new Set(
    students.filter(student => student.completed_at).map(student => student.id),
  );
  const isEmptyingSource = selectedStudentIds.length >= students.length;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!targetProjectId || selectedStudentIds.length === 0) return;
    setIsSubmitting(true);
    try {
      const response = await transferStudents(
        projectId,
        Number(targetProjectId),
        selectedStudentIds,
      );
      const { moved_photo_count: movedPhotoCount } = response.data;
      toast.success(
        `已搬移 ${selectedStudentIds.length} 位學生`
        + (movedPhotoCount ? `，含 ${movedPhotoCount} 張照片` : ""),
      );
      onClose();
      await onTransferred();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "搬移學生失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <FormModal
      isOpen={isOpen}
      title="搬移學生到另一本相本"
      onClose={() => { if (!isSubmitting) onClose(); }}
      maxWidthClass="max-w-lg"
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          <p className="font-medium">搬過去之後：</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>已放的照片與打的個人文字都會跟著搬，不用重做</li>
            <li>這些學生在本相本的「已完成」會取消，需要重新確認</li>
            <li>已經產生的 PDF 與預覽會重新製作</li>
            <li>搬移後不會自動搬回來，要再搬一次</li>
          </ul>
        </div>

        <FormField label="搬去哪一本">
          <select
            required
            className={fieldControlClass}
            value={targetProjectId}
            onChange={event => setTargetProjectId(event.target.value)}
          >
            {transferTargets.map(target => (
              <option key={target.id} value={target.id}>
                {target.name}（目前 {target.student_count} 位）
              </option>
            ))}
          </select>
        </FormField>

        <FormField label={`要搬移的學生（已選 ${selectedStudentIds.length}／${students.length}）`}>
          <div className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
            {students.map(student => {
              const isChecked = selectedStudentIds.includes(student.id);
              return (
                <label
                  key={student.id}
                  className="flex min-h-11 items-center gap-2 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={event => setSelectedStudentIds(current => (
                      event.target.checked
                        ? [...current, student.id]
                        : current.filter(id => id !== student.id)
                    ))}
                  />
                  <span className="min-w-0 flex-1 truncate">{student.name}</span>
                  {completedStudentIds.has(student.id) && (
                    <Badge tone="success">已完成</Badge>
                  )}
                </label>
              );
            })}
          </div>
        </FormField>

        {isEmptyingSource && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
            不能把整本的學生都搬走。若要整本不要了，請改用刪除相本。
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={isSubmitting}>取消</Button>
          <Button
            type="submit"
            variant="success"
            disabled={
              isSubmitting
              || !targetProjectId
              || selectedStudentIds.length === 0
              || isEmptyingSource
            }
          >
            <ArrowRightLeft className="h-4 w-4" />
            {isSubmitting ? "搬移中..." : "確認搬移"}
          </Button>
        </div>
      </form>
    </FormModal>
  );
}
