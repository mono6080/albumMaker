// 使用者管理頁面（僅 admin 可存取）
// 提供使用者清單、建立、修改角色/主管/密碼、刪除功能

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Trash2, UserPlus, KeyRound, ChevronDown } from "lucide-react";
import {
  fetchAllUsers,
  createUser,
  updateUser,
  deleteUser,
} from "../api/authApi";

const ROLE_OPTIONS = [
  { value: "admin",      label: "管理員" },
  { value: "art_team",   label: "美學組" },
  { value: "supervisor", label: "帶班主管" },
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

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [supervisors, setSupervisors] = useState([]);

  // 新增使用者表單狀態
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("teacher");
  const [newSupervisorId, setNewSupervisorId] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // 密碼重設狀態：{ [userId]: string }
  const [resetPasswords, setResetPasswords] = useState({});

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
    setIsCreating(true);
    try {
      const params = {
        username: newUsername,
        display_name: newDisplayName,
        password: newPassword,
        role: newRole,
        ...(newRole === "teacher" && newSupervisorId ? { supervisor_id: newSupervisorId } : {}),
      };
      await createUser(params);
      toast.success("使用者已建立");
      setNewUsername(""); setNewDisplayName(""); setNewPassword("");
      setNewRole("teacher"); setNewSupervisorId("");
      await loadUsers();
    } catch (error) {
      toast.error(error.response?.data?.detail || "建立失敗");
    } finally {
      setIsCreating(false);
    }
  };

  const handleRoleChange = async (userId, newRoleValue) => {
    try {
      await updateUser(userId, { role: newRoleValue });
      toast.success("角色已更新");
      await loadUsers();
    } catch (error) {
      toast.error(error.response?.data?.detail || "更新失敗");
    }
  };

  const handleSupervisorChange = async (userId, supervisorIdValue) => {
    try {
      if (supervisorIdValue === "") {
        await updateUser(userId, { clear_supervisor: true });
      } else {
        await updateUser(userId, { supervisor_id: supervisorIdValue });
      }
      toast.success("主管已更新");
      await loadUsers();
    } catch (error) {
      toast.error(error.response?.data?.detail || "更新失敗");
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
      toast.error(error.response?.data?.detail || "重設失敗");
    }
  };

  const handleDelete = async (userId, displayName) => {
    if (!confirm(`確定要刪除「${displayName}」嗎？`)) return;
    try {
      await deleteUser(userId);
      toast.success("使用者已刪除");
      await loadUsers();
    } catch (error) {
      toast.error(error.response?.data?.detail || "刪除失敗");
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <h1 className="text-xl font-bold text-gray-900">使用者管理</h1>

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
            onChange={(e) => setNewRole(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {newRole === "teacher" && (
          <select
            value={newSupervisorId}
            onChange={(e) => setNewSupervisorId(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 w-full sm:w-64"
          >
            <option value="">（不指定主管）</option>
            {supervisors.map((supervisor) => (
              <option key={supervisor.id} value={supervisor.id}>
                {supervisor.display_name}
              </option>
            ))}
          </select>
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
                <td className="px-4 py-3 font-medium text-gray-900">{user.display_name}</td>
                <td className="px-4 py-3 text-gray-500">{user.username}</td>
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
                    <select
                      value={user.supervisor_id ?? ""}
                      onChange={(e) => handleSupervisorChange(user.id, e.target.value)}
                      className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-gray-50 focus:outline-none"
                    >
                      <option value="">未指定</option>
                      {supervisors.map((supervisor) => (
                        <option key={supervisor.id} value={supervisor.id}>
                          {supervisor.display_name}
                        </option>
                      ))}
                    </select>
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
