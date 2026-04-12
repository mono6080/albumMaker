// 認證 Context
// 提供全域登入狀態、使用者資訊、login / logout 函式，
// Provider 掛載時自動從 localStorage 還原 session

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe, login as apiLogin } from "../api/authApi";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  // loading：true 表示尚在驗證 localStorage token，避免閃爍跳轉
  const [isLoading, setIsLoading] = useState(true);

  // ── 頁面載入時嘗試還原 session ────────────────────────────────────────────

  useEffect(() => {
    const storedToken = localStorage.getItem("access_token");
    if (!storedToken) {
      setIsLoading(false);
      return;
    }
    fetchMe()
      .then((response) => setCurrentUser(response.data))
      .catch(() => localStorage.removeItem("access_token"))
      .finally(() => setIsLoading(false));
  }, []);

  // ── 登入 ──────────────────────────────────────────────────────────────────

  const login = useCallback(async (username, password) => {
    const response = await apiLogin(username, password);
    const { access_token, role, display_name, user_id } = response.data;
    localStorage.setItem("access_token", access_token);
    setCurrentUser({ id: user_id, username, display_name, role });
    return response.data;
  }, []);

  // ── 登出 ──────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    localStorage.removeItem("access_token");
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
