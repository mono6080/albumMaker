// 認證 API 模組
// 封裝登入、登出與取得當前使用者的 API 呼叫
// 認證改用 HttpOnly Cookie，axios 設定 withCredentials 自動帶 Cookie

import axios from "axios";

export const apiClient = axios.create({
  baseURL: "/api",
  timeout: 15000,       // 一般請求 15 秒
  withCredentials: true, // 自動帶 Cookie（HttpOnly 認證）
});

// 渲染端點可能耗時較長，個別設定更長 timeout
export const renderClient = axios.create({
  baseURL: "/api",
  timeout: 120000,       // 渲染 PDF 最長 2 分鐘
  withCredentials: true, // 自動帶 Cookie（HttpOnly 認證）
});

// ── 共用 interceptor 設定 ─────────────────────────────────────────────────────

function attachAuthInterceptors(client) {
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        if (window.location.pathname !== "/login") {
          window.location.href = "/login";
        }
      }
      return Promise.reject(error);
    }
  );
}

attachAuthInterceptors(apiClient);
attachAuthInterceptors(renderClient);

// ── 認證 API 函式 ─────────────────────────────────────────────────────────────

/** 登入，Cookie 由後端 Set-Cookie 設定，回傳 role / display_name / user_id */
export const login = (username, password) =>
  apiClient.post("/auth/login", new URLSearchParams({ username, password }));

/** 登出，後端清除 Cookie */
export const logout = () =>
  apiClient.post("/auth/logout");

/** 取得當前登入使用者資訊（依賴 Cookie，用於頁面重載時還原 session） */
export const fetchMe = () =>
  apiClient.get("/auth/me");

/** 更新目前登入使用者自己的 UI 偏好 */
export const updateMySettings = (params) =>
  apiClient.patch("/users/me/settings", params);

// ── 使用者管理 API（admin only）───────────────────────────────────────────────

/** 取得所有使用者清單 */
export const fetchAllUsers = () =>
  apiClient.get("/users/");

/** 建立新使用者 */
export const createUser = (params) =>
  apiClient.post("/users/", params);

/** 從 Excel 批次建立使用者 */
export const importUsersFromExcel = (file) => {
  const formData = new FormData();
  formData.append("file", file);
  return apiClient.post("/users/import", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60000,
  });
};

/** 修改使用者資料 */
export const updateUser = (userId, params) =>
  apiClient.patch(`/users/${userId}`, params);

/** 刪除使用者 */
export const deleteUser = (userId) =>
  apiClient.delete(`/users/${userId}`);
