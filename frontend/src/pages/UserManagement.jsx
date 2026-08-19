// 使用者管理頁面（僅 admin 可存取）
// 提供帳號清單、建立、修改角色/密碼、刪除；組織權限統一在園所設定維護。

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { UserPlus } from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import UserExcelImportForm from "../components/UserExcelImportForm";
import UserList from "../components/UserList";
import { ROLE_OPTIONS, USER_ROLES } from "../utils/userRoles";
import { getApiErrorMessage } from "../utils/apiError";
import {
  fetchAllUsers,
  createUser,
  importUsersFromExcel,
  updateUser,
  deleteUser,
} from "../api/authApi";

export default function UserManagement() {
  const [users, setUsers] = useState([]);

  // 新增使用者表單狀態
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState(USER_ROLES.TEACHER);
  const [isCreating, setIsCreating] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // 密碼重設狀態：{ [userId]: string }
  const [resetPasswords, setResetPasswords] = useState({});

  // inline 編輯狀態：{ userId, field: 'display_name'|'username', value }
  const [editingField, setEditingField] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const editInputRef = useRef(null);
  const importFileRef = useRef(null);

  const loadUsers = async () => {
    try {
      const response = await fetchAllUsers();
      setUsers(response.data);
    } catch {
      toast.error("載入使用者清單失敗");
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const handleCreate = async (event) => {
    event.preventDefault();
    setIsCreating(true);
    try {
      const params = {
        username: newUsername,
        display_name: newDisplayName,
        password: newPassword,
        role: newRole,
      };
      await createUser(params);
      toast.success("使用者已建立");
      setNewUsername(""); setNewDisplayName(""); setNewPassword("");
      setNewRole(USER_ROLES.TEACHER);
      await loadUsers();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "建立失敗"));
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
      toast.error(getApiErrorMessage(error, "匯入失敗"));
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
      toast.error(getApiErrorMessage(error, "更新失敗"));
    }
  };

  const handleResetPassword = async (userId) => {
    const newPwd = resetPasswords[userId];
    if (!newPwd?.trim()) return;
    try {
      await updateUser(userId, { new_password: newPwd });
      toast.success("密碼已重設");
      setResetPasswords((prev) => ({ ...prev, [userId]: "" }));
    } catch (error) {
      toast.error(getApiErrorMessage(error, "重設失敗"));
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
      toast.error(getApiErrorMessage(error, "更新失敗"));
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
          toast.error(getApiErrorMessage(error, "刪除失敗"));
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">人員帳號</h1>
          <p className="mt-1 text-sm text-gray-500">這裡只管理登入帳號與角色；實際園所權限由校、部門與班級編制決定。</p>
        </div>
        <Link
          to="/admin/organization"
          className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-50 px-4 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
        >
          前往園所設定權限
        </Link>
      </div>

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
            onChange={(e) => setNewRole(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
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
      />
    </div>
  );
}
