// 登入頁面

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const ROLE_LABELS = {
  admin: "管理員",
  art_team: "設計",
  supervisor: "帶班主管",
  teacher: "帶班老師",
  none: "無權限",
};

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);
    try {
      const userData = await login(username, password);
      // 依角色導向不同首頁
      if (userData.role === "art_team" || userData.role === "admin") {
        navigate("/templates");
      } else {
        navigate("/projects");
      }
    } catch (error) {
      const detail = error.response?.data?.detail;
      setErrorMessage(detail || "登入失敗，請確認帳號與密碼");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-violet-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 標題 */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🎨</div>
          <h1 className="text-2xl font-bold text-gray-900">幼兒園相本系統</h1>
          <p className="text-sm text-gray-500 mt-1">請登入以繼續</p>
        </div>

        {/* 登入表單 */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">帳號</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="請輸入帳號"
              required
              autoFocus
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密碼</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="請輸入密碼"
              required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
            />
          </div>

          {errorMessage && (
            <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{errorMessage}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? "登入中..." : "登入"}
          </button>
        </form>
      </div>
    </div>
  );
}
