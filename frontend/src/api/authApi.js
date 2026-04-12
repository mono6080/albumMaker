// 認證 API 模組
// 封裝登入、登出與取得當前使用者的 API 呼叫，
// 同時設定 axios interceptor 讓所有請求自動附帶 Bearer token

import axios from "axios";

export const apiClient = axios.create({ baseURL: "/api" });

// ── Request interceptor：自動附帶 Bearer token ────────────────────────────────

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor：401 自動跳轉登入頁 ─────────────────────────────────

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("access_token");
      // 避免在登入頁本身觸發無限跳轉
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

// ── 認證 API 函式 ─────────────────────────────────────────────────────────────

/** 登入，回傳 access_token / role / display_name */
export const login = (username, password) =>
  apiClient.post("/auth/login", new URLSearchParams({ username, password }));

/** 取得當前登入使用者資訊 */
export const fetchMe = () =>
  apiClient.get("/auth/me");

// ── 使用者管理 API（admin only）───────────────────────────────────────────────

/** 取得所有使用者清單 */
export const fetchAllUsers = () =>
  apiClient.get("/users/");

/** 建立新使用者 */
export const createUser = (params) =>
  apiClient.post("/users/", params);

/** 修改使用者資料 */
export const updateUser = (userId, params) =>
  apiClient.patch(`/users/${userId}`, params);

/** 刪除使用者 */
export const deleteUser = (userId) =>
  apiClient.delete(`/users/${userId}`);
