// 使用者管理頁面（僅 admin 可存取）
// 提供使用者清單、建立、修改角色/主管/密碼、刪除功能

import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, UserPlus, KeyRound, Pencil, Check, X, FileSpreadsheet, Upload } from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import {
  fetchAllUsers,
  createUser,
  importUsersFromExcel,
  updateUser,
  deleteUser,
} from "../api/authApi";

const ROLE_OPTIONS = [
  { value: "admin",      label: "管理員" },
  { value: "art_team",   label: "設計" },
  { value: "supervisor", label: "主管" },
  { value: "teacher",    label: "帶班老師" },
  { value: "none",       label: "無權限" },
];

const ROLE_BADGE_STYLE = {
  admin:      "bg-red-100 text-red-700",
  art_team:   "bg-violet-100 text-violet-700",
  supervisor: "bg-blue-100 text-blue-700",
  teacher:    "bg-emerald-100 text-emerald-700",
  none:       "bg-gray-100 text-gray-500",
};

function getSupervisorIds(user) {
  return user.supervisor_ids ?? (user.supervisor_id ? [user.supervisor_id] : []);
}

function getSupervisorNames(user) {
  return user.supervisor_names ?? (user.supervisor_name ? [user.supervisor_name] : []);
}

function getSupervisorSummary(user) {
  const names = getSupervisorNames(user);
  if (names.length === 0) return "未指定";
  if (names.length <= 2) return names.join("、");
  return `${names.slice(0, 2).join("、")} +${names.length - 2}`;
}

function getErrorMessage(error, fallback) {
  const detail = error.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map(item => item.msg || String(item)).join("；");
  }
  return fallback;
}

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [supervisors, setSupervisors] = useState([]);

  // 新增使用者表單狀態
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("teacher");
  const [newSupervisorIds, setNewSupervisorIds] = useState([]);
  const [isCreating, setIsCreating] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // 密碼重設狀態：{ [userId]: string }
  const [resetPasswords, setResetPasswords] = useState({});

  // inline 編輯狀態：{ userId, field: 'display_name'|'username', value }
  const [editingField, setEditingField] = useState(null);
  const [supervisorEditorUserId, setSupervisorEditorUserId] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const editInputRef = useRef(null);
  const importFileRef = useRef(null);
  const supervisorEditorUser = users.find((user) => user.id === supervisorEditorUserId);

  const loadUsers = async () => {
    try {
      const response = await fetchAllUsers();
      const allUsers = response.data;
      setUsers(allUsers);
      setSupervisors(allUsers.filter((u) => u.role === "supervisor"));
    } catch {
      toast.error("載入使用者清單失敗");
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const handleCreate = async (event) => {
    event.preventDefault();
    if (newRole === "teacher" && newSupervisorIds.length === 0) {
      toast.error("請至少指定一位主管");
      return;
    }
    setIsCreating(true);
    try {
      const params = {
        username: newUsername,
        display_name: newDisplayName,
        password: newPassword,
        role: newRole,
        ...(newRole === "teacher" ? { supervisor_ids: newSupervisorIds } : {}),
      };
      await createUser(params);
      toast.success("使用者已建立");
      setNewUsername(""); setNewDisplayName(""); setNewPassword("");
      setNewRole("teacher"); setNewSupervisorIds([]);
      await loadUsers();
    } catch (error) {
      toast.error(getErrorMessage(error, "建立失敗"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleImport = async (event) => {
    event.preventDefault();
    if (!importFile) {
      toast.error("請選擇 Excel 檔");
      return;
    }
    setIsImporting(true);
    try {
      const response = await importUsersFromExcel(importFile);
      setImportResult(response.data);
      toast.success(`已建立 ${response.data.created_count} 位使用者`);
      setImportFile(null);
      if (importFileRef.current) importFileRef.current.value = "";
      await loadUsers();
    } catch (error) {
      toast.error(getErrorMessage(error, "匯入失敗"));
    } finally {
      setIsImporting(false);
    }
  };

  const handleRoleChange = async (userId, newRoleValue) => {
    try {
      await updateUser(userId, { role: newRoleValue });
      toast.success("角色已更新");
      await loadUsers();
    } catch (error) {
      toast.error(getErrorMessage(error, "更新失敗"));
    }
  };

  const handleSupervisorToggle = async (user, supervisorId, checked) => {
    const currentSupervisorIds = getSupervisorIds(user);
    if (!checked && currentSupervisorIds.length <= 1) {
      toast.error("請至少保留一位主管");
      return;
    }
    const nextSupervisorIds = checked
      ? [...new Set([...currentSupervisorIds, supervisorId])]
      : currentSupervisorIds.filter(id => id !== supervisorId);
    try {
      await updateUser(user.id, { supervisor_ids: nextSupervisorIds });
      toast.success("主管已更新");
      await loadUsers();
    } catch (error) {
      toast.error(getErrorMessage(error, "更新失敗"));
    }
  };

  const toggleNewSupervisor = (supervisorId, checked) => {
    setNewSupervisorIds(prev => checked
      ? [...new Set([...prev, supervisorId])]
      : prev.filter(id => id !== supervisorId)
    );
  };

  const handleResetPassword = async (userId) => {
    const newPwd = resetPasswords[userId];
    if (!newPwd?.trim()) return;
    try {
      await updateUser(userId, { new_password: newPwd });
      toast.success("密碼已重設");
      setResetPasswords((prev) => ({ ...prev, [userId]: "" }));
    } catch (error) {
      toast.error(getErrorMessage(error, "重設失敗"));
    }
  };

  const startEdit = (userId, field, currentValue) => {
    setEditingField({ userId, field, value: currentValue });
    // 下一個 tick 才 focus，等元素出現
    setTimeout(() => editInputRef.current?.select(), 0);
  };

  const handleEditConfirm = async () => {
    if (!editingField) return;
    const { userId, field, value } = editingField;
    const trimmed = value.trim();
    if (!trimmed) { setEditingField(null); return; }
    try {
      await updateUser(userId, { [field]: trimmed });
      toast.success("已更新");
      setEditingField(null);
      await loadUsers();
    } catch (error) {
      toast.error(getErrorMessage(error, "更新失敗"));
    }
  };

  const handleEditKeyDown = (e) => {
    if (e.key === "Enter") handleEditConfirm();
    if (e.key === "Escape") setEditingField(null);
  };

  const handleDelete = (userId, displayName) => {
    setConfirmModal({
      message: `確定要刪除「${displayName}」嗎？`,
      onConfirm: async () => {
        try {
          await deleteUser(userId);
          toast.success("使用者已刪除");
          await loadUsers();
        } catch (error) {
          toast.error(getErrorMessage(error, "刪除失敗"));
        }
      },
    });
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {supervisorEditorUser && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-gray-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <div className="font-semibold text-gray-900 text-sm">編輯主管</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {supervisorEditorUser.display_name} · 已選 {getSupervisorIds(supervisorEditorUser).length} 位
                </div>
              </div>
              <button
                onClick={() => setSupervisorEditorUserId(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                title="關閉"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 max-h-80 overflow-y-auto">
              {supervisors.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-8">尚無主管</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {supervisors.map((supervisor) => {
                    const supervisorIds = getSupervisorIds(supervisorEditorUser);
                    return (
                      <label key={supervisor.id} className="inline-flex items-center gap-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                        <input
                          type="checkbox"
                          checked={supervisorIds.includes(supervisor.id)}
                          onChange={(e) => handleSupervisorToggle(supervisorEditorUser, supervisor.id, e.target.checked)}
                        />
                        <span className="truncate">{supervisor.display_name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
              <button
                onClick={() => setSupervisorEditorUserId(null)}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-800"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
      <h1 className="text-xl font-bold text-gray-900">使用者管理</h1>

      <form
        onSubmit={handleImport}
        className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <h2 className="font-semibold text-gray-800 text-sm">Excel 批次建立</h2>
          </div>
          <div className="text-xs text-gray-400">
            欄位：username、display_name、password、role、supervisor_username
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={importFileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            className="block min-w-0 flex-1 text-sm text-gray-600 file:mr-3 file:rounded-xl file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
          />
          <button
            type="submit"
            disabled={isImporting || !importFile}
            className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            <Upload className="w-4 h-4" />
            {isImporting ? "匯入中..." : "匯入"}
          </button>
        </div>
        {importResult && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
            <div>
              建立 {importResult.created_count} 位，略過 {importResult.skipped_count} 位，錯誤 {importResult.error_count} 筆
            </div>
            {importResult.errors?.slice(0, 3).map((item) => (
              <div key={`${item.row}-${item.username}`} className="text-red-600">
                第 {item.row} 列 {item.username || "未填帳號"}：{item.error}
              </div>
            ))}
          </div>
        )}
      </form>

      {/* 新增使用者表單 */}
      <form
        onSubmit={handleCreate}
        className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4"
      >
        <h2 className="font-semibold text-gray-800 text-sm">新增使用者</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <input
            required
            placeholder="帳號"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          />
          <input
            required
            placeholder="顯示名稱"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          />
          <input
            required
            type="password"
            placeholder="初始密碼"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          />
          <select
            value={newRole}
            onChange={(e) => {
              const role = e.target.value;
              setNewRole(role);
              if (role !== "teacher") setNewSupervisorIds([]);
            }}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {newRole === "teacher" && (
          <div className="border border-gray-200 rounded-xl px-3 py-2 bg-gray-50">
            <div className="text-xs font-medium text-gray-500 mb-2">主管（可多選）</div>
            {supervisors.length === 0 ? (
              <div className="text-xs text-gray-400">尚無主管</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-36 overflow-y-auto pr-1">
                {supervisors.map((supervisor) => (
                  <label key={supervisor.id} className="inline-flex items-center gap-1.5 text-xs text-gray-700 bg-white border border-gray-200 rounded-lg px-2 py-1">
                    <input
                      type="checkbox"
                      checked={newSupervisorIds.includes(supervisor.id)}
                      onChange={(e) => toggleNewSupervisor(supervisor.id, e.target.checked)}
                    />
                    <span className="truncate">{supervisor.display_name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={isCreating}
          className="flex items-center gap-1.5 bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          {isCreating ? "建立中..." : "建立"}
        </button>
      </form>

      {/* 使用者清單 */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">顯示名稱</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">帳號</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">角色</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">主管</th>
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
                        onKeyDown={handleEditKeyDown}
                        className="border border-indigo-300 rounded-lg px-2 py-0.5 text-sm w-32 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      <button onClick={handleEditConfirm} className="p-0.5 text-indigo-600 hover:text-indigo-800"><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditingField(null)} className="p-0.5 text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startEdit(user.id, "display_name", user.display_name)}
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
                        onKeyDown={handleEditKeyDown}
                        className="border border-indigo-300 rounded-lg px-2 py-0.5 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      <button onClick={handleEditConfirm} className="p-0.5 text-indigo-600 hover:text-indigo-800"><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditingField(null)} className="p-0.5 text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startEdit(user.id, "username", user.username)}
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
                    onChange={(e) => handleRoleChange(user.id, e.target.value)}
                    className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer ${ROLE_BADGE_STYLE[user.role] || "bg-gray-100 text-gray-500"}`}
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  {user.role === "teacher" ? (
                    <div className="flex items-center gap-2 max-w-56">
                      {supervisors.length === 0 ? (
                        <span className="text-xs text-gray-300">未指定</span>
                      ) : (
                        <>
                          <span className="text-xs text-gray-600 truncate" title={getSupervisorNames(user).join("、")}>
                            {getSupervisorSummary(user)}
                          </span>
                          <button
                            onClick={() => setSupervisorEditorUserId(user.id)}
                            className="p-1 text-gray-400 hover:text-indigo-600 rounded-lg hover:bg-indigo-50 flex-shrink-0"
                            title="編輯主管"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      placeholder="新密碼"
                      value={resetPasswords[user.id] ?? ""}
                      onChange={(e) =>
                        setResetPasswords((prev) => ({ ...prev, [user.id]: e.target.value }))
                      }
                      className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-gray-50"
                    />
                    <button
                      onClick={() => handleResetPassword(user.id)}
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
                    onClick={() => handleDelete(user.id, user.display_name)}
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
        {users.length === 0 && (
          <p className="text-center py-8 text-gray-300 text-sm">尚無使用者</p>
        )}
      </div>
    </div>
  );
}
