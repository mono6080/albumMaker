// 本期學生 Modal（班級工作台用）
// 成員與完整姓名保留建立相本時的快照；相本稱呼統一跟隨園所設定。

import { Users } from "lucide-react";

import FormModal from "./FormModal";
import { Badge } from "./ui";

const getEffectiveAlbumName = student => (
  typeof student.effective_album_name === "string"
    ? student.effective_album_name
    : student.name
);

export default function RosterModal({
  isOpen,
  onClose,
  students,
  // 每位學生的照片進度（Map: studentId → {filled,total}），沒有就不顯示徽章
  photoProgressByStudentId = null,
}) {
  return (
    <FormModal
      isOpen={isOpen}
      title="本期學生"
      onClose={onClose}
    >
      <div data-guide="roster-modal">
        <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/70 px-3 py-3 text-sm leading-6 text-indigo-900">
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-600" />
            <p>
              本期成員與完整姓名保留建立相本時的快照；相本稱呼統一跟隨園所設定，
              既有已歸班相本與之後建立的相本都會立即套用。若需變更，請由管理員至園所設定修改。
            </p>
          </div>
        </div>

        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          本期學生（{students.length} 位）
        </div>
        {students.length === 0 ? (
          <p className="py-6 text-center text-sm leading-6 text-gray-400">
            此相本沒有學生快照。請管理員確認遷移資料，或從正確班級重新建立本期相本。
          </p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {students.map((student, index) => {
              const progress = photoProgressByStudentId?.get(student.id);
              const isPhotoComplete = progress && progress.total > 0 && progress.filled === progress.total;
              return (
                <div key={student.id} className="flex min-w-0 items-start gap-2 rounded-xl px-2 py-2 hover:bg-gray-50">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-500">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-800">
                      {student.name}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-400">完整姓名 · 本期快照</div>
                    <div className="mt-1 truncate text-xs text-gray-500">
                      相本稱呼（園所設定）：{getEffectiveAlbumName(student)}
                    </div>
                  </div>
                  {progress && progress.total > 0 && (
                    <Badge tone={isPhotoComplete ? "success" : "warning"}>
                      {isPhotoComplete ? "✓ 照片齊" : `照片 ${progress.filled}/${progress.total}`}
                    </Badge>
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
