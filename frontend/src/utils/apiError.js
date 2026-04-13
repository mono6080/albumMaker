// API 錯誤處理工具
// 統一從 axios error 中提取後端 detail 訊息並顯示 toast

import toast from "react-hot-toast";

/**
 * 從 axios error 提取後端 detail 訊息，顯示 toast 並回傳訊息字串。
 * @param {Error} error - axios 拋出的錯誤
 * @param {string} fallback - 無法解析時的預設訊息
 */
export function handleApiError(error, fallback = "操作失敗，請稍後再試") {
  const detail = error?.response?.data?.detail;
  const message = typeof detail === "string" ? detail : fallback;
  toast.error(message);
  return message;
}
