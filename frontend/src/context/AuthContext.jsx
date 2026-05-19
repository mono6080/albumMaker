// 認證 Context
// 提供全域登入狀態、使用者資訊、login / logout 函式
// 認證改用 HttpOnly Cookie：不再讀寫 localStorage，session 由後端 Cookie 維護
/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe, login as apiLogin, logout as apiLogout } from "../api/authApi";
import {
  applyAndStoreUiFontScale,
  normalizeUiFontScale,
  resetStoredUiFontScale,
} from "../utils/uiPreferences";

const AuthContext = createContext(null);

function normalizeUserPayload(data) {
  if (!data) return null;
  return {
    ...data,
    id: data.id ?? data.user_id,
    ui_font_scale: normalizeUiFontScale(data.ui_font_scale),
  };
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  // loading：true 表示尚在向後端確認 Cookie session，避免閃爍跳轉
  const [isLoading, setIsLoading] = useState(true);

  const applyAuthenticatedUser = useCallback((userData) => {
    const normalizedUser = normalizeUserPayload(userData);
    if (normalizedUser) {
      applyAndStoreUiFontScale(normalizedUser.ui_font_scale);
    }
    setCurrentUser(normalizedUser);
    return normalizedUser;
  }, []);

  const updateCurrentUser = useCallback((patch) => {
    setCurrentUser((previousUser) => {
      const nextUser = normalizeUserPayload(
        typeof patch === "function" ? patch(previousUser) : { ...previousUser, ...patch },
      );
      if (nextUser) {
        applyAndStoreUiFontScale(nextUser.ui_font_scale);
      }
      return nextUser;
    });
  }, []);

  // ── 頁面載入時嘗試還原 session（Cookie 由瀏覽器自動帶） ──────────────────

  useEffect(() => {
    fetchMe()
      .then((response) => applyAuthenticatedUser(response.data))
      .catch((error) => {
        // 只在 401 時確認未登入；網路錯誤不清除 session
        if (error.response?.status === 401) {
          setCurrentUser(null);
          resetStoredUiFontScale();
        }
      })
      .finally(() => setIsLoading(false));
  }, [applyAuthenticatedUser]);

  // ── 登入 ──────────────────────────────────────────────────────────────────

  const login = useCallback(async (username, password) => {
    const response = await apiLogin(username, password);
    // Cookie 由後端 Set-Cookie 寫入，前端只保存使用者資訊到 state
    applyAuthenticatedUser(response.data);
    return response.data;
  }, [applyAuthenticatedUser]);

  // ── 登出 ──────────────────────────────────────────────────────────────────

  const logout = useCallback(async () => {
    try {
      await apiLogout(); // 通知後端清除 Cookie
    } catch {
      // 網路錯誤時仍清除本地 state，確保 UI 跳回登入頁
    }
    setCurrentUser(null);
    resetStoredUiFontScale();
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, isLoading, login, logout, updateCurrentUser }}>
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
