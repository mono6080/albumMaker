// 使用者管理：編輯主管 Modal（勾選多位主管，變更立即送出）
// 更新邏輯在 UserManagement 頁，這裡只負責呈現與轉發事件

import { X } from "lucide-react";
import useDialogA11y from "../hooks/useDialogA11y";

export default function SupervisorEditorModal({
  // 被編輯的使用者
  user,
  // 該使用者目前的主管 id 清單
  supervisorIds,
  // 可指定的主管選項（已排除自己）
  options,
  onToggle,
  onClose,
}) {
  const dialogRef = useDialogA11y({ onClose });
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="編輯主管"
        onClick={event => event.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-gray-200"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-900 text-sm">編輯主管</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {user.display_name} · 已選 {supervisorIds.length} 位
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉主管編輯"
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
            title="關閉"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 max-h-80 overflow-y-auto">
          {options.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-8">尚無可指定的其他主管</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {options.map((supervisor) => (
                <label key={supervisor.id} className="inline-flex items-center gap-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  <input
                    type="checkbox"
                    checked={supervisorIds.includes(supervisor.id)}
                    onChange={(e) => onToggle(supervisor.id, e.target.checked)}
                  />
                  <span className="truncate">{supervisor.display_name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-800"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
