// 使用者管理頁面（僅 admin 可存取）
// 提供使用者清單、建立、修改角色/主管/密碼、刪除功能

import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { UserPlus } from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import SupervisorEditorModal from "../components/SupervisorEditorModal";
import UserExcelImportForm from "../components/UserExcelImportForm";
import UserList from "../components/UserList";
import { ROLE_OPTIONS, canHaveSupervisor, getSupervisorIds } from "../utils/userRoles";
import {
  fetchAllUsers,
  createUser,
  importUsersFromExcel,
  updateUser,
  deleteUser,
} from "../api/authApi";

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
  const supervisorEditorOptions = supervisorEditorUser
    ? supervisors.filter(supervisor => supervisor.id !== supervisorEditorUser.id)
    : [];

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
        ...(canHaveSupervisor(newRole) ? { supervisor_ids: newSupervisorIds } : {}),
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
    if (user.role === "teacher" && !checked && currentSupervisorIds.length <= 1) {
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
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {supervisorEditorUser && (
        <SupervisorEditorModal
          user={supervisorEditorUser}
          supervisorIds={getSupervisorIds(supervisorEditorUser)}
          options={supervisorEditorOptions}
          onToggle={(supervisorId, checked) => handleSupervisorToggle(supervisorEditorUser, supervisorId, checked)}
          onClose={() => setSupervisorEditorUserId(null)}
        />
      )}
      <h1 className="text-xl font-bold text-gray-900">使用者管理</h1>

      <UserExcelImportForm
        fileInputRef={importFileRef}
        importFile={importFile}
        onFileChange={setImportFile}
        isImporting={isImporting}
        importResult={importResult}
        onSubmit={handleImport}
      />

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
            minLength={8}
            placeholder="初始密碼（至少 8 字元）"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          />
          <select
            value={newRole}
            onChange={(e) => {
              const role = e.target.value;
              setNewRole(role);
              if (!canHaveSupervisor(role)) setNewSupervisorIds([]);
            }}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {canHaveSupervisor(newRole) && (
          <div className="border border-gray-200 rounded-xl px-3 py-2 bg-gray-50">
            <div className="text-xs font-medium text-gray-500 mb-2">
              主管（可多選{newRole === "supervisor" ? "，選填" : ""}）
            </div>
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
      <UserList
        users={users}
        supervisors={supervisors}
        editingField={editingField}
        setEditingField={setEditingField}
        editInputRef={editInputRef}
        onStartEdit={startEdit}
        onEditConfirm={handleEditConfirm}
        onEditKeyDown={handleEditKeyDown}
        onRoleChange={handleRoleChange}
        resetPasswords={resetPasswords}
        setResetPasswords={setResetPasswords}
        onResetPassword={handleResetPassword}
        onDelete={handleDelete}
        onOpenSupervisorEditor={setSupervisorEditorUserId}
      />
    </div>
  );
}
