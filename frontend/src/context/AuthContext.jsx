// 認證 Context
// 提供全域登入狀態、使用者資訊、login / logout 函式
// 認證改用 HttpOnly Cookie：不再讀寫 localStorage，session 由後端 Cookie 維護

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe, login as apiLogin, logout as apiLogout } from "../api/authApi";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  // loading：true 表示尚在向後端確認 Cookie session，避免閃爍跳轉
  const [isLoading, setIsLoading] = useState(true);

  // ── 頁面載入時嘗試還原 session（Cookie 由瀏覽器自動帶） ──────────────────

  useEffect(() => {
    fetchMe()
      .then((response) => setCurrentUser(response.data))
      .catch((error) => {
        // 只在 401 時確認未登入；網路錯誤不清除 session
        if (error.response?.status === 401) {
          setCurrentUser(null);
        }
      })
      .finally(() => setIsLoading(false));
  }, []);

  // ── 登入 ──────────────────────────────────────────────────────────────────

  const login = useCallback(async (username, password) => {
    const response = await apiLogin(username, password);
    const { role, display_name, user_id, username: uname } = response.data;
    // Cookie 由後端 Set-Cookie 寫入，前端只保存使用者資訊到 state
    setCurrentUser({ id: user_id, username: uname, display_name, role });
    return response.data;
  }, []);

  // ── 登出 ──────────────────────────────────────────────────────────────────

  const logout = useCallback(async () => {
    try {
      await apiLogout(); // 通知後端清除 Cookie
    } catch {
      // 網路錯誤時仍清除本地 state，確保 UI 跳回登入頁
    }
    setCurrentUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/** 在任意元件取得認證狀態與操作函式 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必須在 AuthProvider 內使用");
  return context;
}
