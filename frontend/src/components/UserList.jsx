// 使用者管理：使用者清單（桌機表格 + 行動版卡片，同一份資料兩種排版）
// 含 inline 編輯顯示名稱/帳號、角色下拉、重設密碼、刪除；
// 編輯狀態與 API 呼叫都在 UserManagement 頁，這裡只負責呈現與轉發事件

import { Trash2, KeyRound, Pencil, Check, X } from "lucide-react";

import { ROLE_OPTIONS, ROLE_BADGE_STYLE } from "../utils/userRoles";

export default function UserList({
  users,
  // inline 編輯狀態：{ userId, field: 'display_name'|'username', value }（由頁面持有）
  editingField,
  setEditingField,
  editInputRef,
  onStartEdit,
  onEditConfirm,
  onEditKeyDown,
  onRoleChange,
  // 密碼重設輸入值：{ [userId]: string }（由頁面持有）
  resetPasswords,
  setResetPasswords,
  onResetPassword,
  onDelete,
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left px-4 py-3 text-gray-600 font-medium">顯示名稱</th>
            <th className="text-left px-4 py-3 text-gray-600 font-medium">帳號</th>
            <th className="text-left px-4 py-3 text-gray-600 font-medium">角色</th>
            <th className="text-left px-4 py-3 text-gray-600 font-medium">重設密碼</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-gray-50/50">
              <td className="px-4 py-3">
                {editingField?.userId === user.id && editingField.field === "display_name" ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={editInputRef}
                      value={editingField.value}
                      onChange={(e) => setEditingField((prev) => ({ ...prev, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      className="border border-indigo-300 rounded-lg px-2 py-0.5 text-sm w-32 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button onClick={onEditConfirm} className="p-0.5 text-indigo-600 hover:text-indigo-800"><Check className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setEditingField(null)} className="p-0.5 text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartEdit(user.id, "display_name", user.display_name)}
                    className="group flex items-center gap-1 font-medium text-gray-900 hover:text-indigo-600 transition-colors"
                  >
                    {user.display_name}
                    <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
                  </button>
                )}
              </td>
              <td className="px-4 py-3">
                {editingField?.userId === user.id && editingField.field === "username" ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={editInputRef}
                      value={editingField.value}
                      onChange={(e) => setEditingField((prev) => ({ ...prev, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      className="border border-indigo-300 rounded-lg px-2 py-0.5 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button onClick={onEditConfirm} className="p-0.5 text-indigo-600 hover:text-indigo-800"><Check className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setEditingField(null)} className="p-0.5 text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartEdit(user.id, "username", user.username)}
                    className="group flex items-center gap-1 text-gray-500 hover:text-indigo-600 transition-colors"
                  >
                    {user.username}
                    <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
                  </button>
                )}
              </td>
              <td className="px-4 py-3">
                <select
                  value={user.role}
                  onChange={(e) => onRoleChange(user.id, e.target.value)}
                  className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer ${ROLE_BADGE_STYLE[user.role] || "bg-gray-100 text-gray-500"}`}
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <input
                    type="password"
                    minLength={8}
                    placeholder="至少 8 字元"
                    value={resetPasswords[user.id] ?? ""}
                    onChange={(e) =>
                      setResetPasswords((prev) => ({ ...prev, [user.id]: e.target.value }))
                    }
                    className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-gray-50"
                  />
                  <button
                    onClick={() => onResetPassword(user.id)}
                    disabled={!resetPasswords[user.id]?.trim()}
                    className="p-1 text-gray-400 hover:text-indigo-600 disabled:opacity-30 transition-colors"
                    title="確認重設"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => onDelete(user.id, user.display_name)}
                  className="p-1.5 text-gray-300 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50"
                  title="刪除使用者"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="divide-y divide-gray-100 md:hidden">
        {users.map((user) => (
          <div key={user.id} className="space-y-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {editingField?.userId === user.id && editingField.field === "display_name" ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={editInputRef}
                      value={editingField.value}
                      onChange={(e) => setEditingField((prev) => ({ ...prev, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      className="min-w-0 flex-1 rounded-lg border border-indigo-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button onClick={onEditConfirm} className="p-1 text-indigo-600 hover:text-indigo-800" title="儲存顯示名稱">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingField(null)} className="p-1 text-gray-400 hover:text-gray-600" title="取消編輯">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartEdit(user.id, "display_name", user.display_name)}
                    className="flex min-w-0 items-center gap-1 font-medium text-gray-900 hover:text-indigo-600"
                  >
                    <span className="truncate">{user.display_name}</span>
                    <Pencil className="w-3 h-3 flex-shrink-0 text-gray-300" />
                  </button>
                )}

                {editingField?.userId === user.id && editingField.field === "username" ? (
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      ref={editInputRef}
                      value={editingField.value}
                      onChange={(e) => setEditingField((prev) => ({ ...prev, value: e.target.value }))}
                      onKeyDown={onEditKeyDown}
                      className="min-w-0 flex-1 rounded-lg border border-indigo-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <button onClick={onEditConfirm} className="p-1 text-indigo-600 hover:text-indigo-800" title="儲存帳號">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingField(null)} className="p-1 text-gray-400 hover:text-gray-600" title="取消編輯">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartEdit(user.id, "username", user.username)}
                    className="mt-1 flex min-w-0 items-center gap-1 text-sm text-gray-500 hover:text-indigo-600"
                  >
                    <span className="truncate">{user.username}</span>
                    <Pencil className="w-3 h-3 flex-shrink-0 text-gray-300" />
                  </button>
                )}
              </div>

              <button
                onClick={() => onDelete(user.id, user.display_name)}
                className="rounded-lg p-2 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
                title="刪除使用者"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="min-w-0">
                <span className="mb-1 block text-xs font-medium text-gray-400">角色</span>
                <select
                  value={user.role}
                  onChange={(e) => onRoleChange(user.id, e.target.value)}
                  className={`w-full rounded-lg px-2 py-2 text-xs font-medium ${ROLE_BADGE_STYLE[user.role] || "bg-gray-100 text-gray-500"}`}
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>

            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-gray-400">重設密碼</span>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  minLength={8}
                  placeholder="至少 8 字元"
                  value={resetPasswords[user.id] ?? ""}
                  onChange={(e) =>
                    setResetPasswords((prev) => ({ ...prev, [user.id]: e.target.value }))
                  }
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <button
                  onClick={() => onResetPassword(user.id)}
                  disabled={!resetPasswords[user.id]?.trim()}
                  className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-30"
                  title="確認重設"
                >
                  <KeyRound className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {users.length === 0 && (
        <p className="text-center py-8 text-gray-300 text-sm">尚無使用者</p>
      )}
    </div>
  );
}
