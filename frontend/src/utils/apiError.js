// API 錯誤處理工具
// 統一從 axios error 中提取後端 detail 訊息並顯示 toast

import toast from "react-hot-toast";

/** 從 FastAPI detail（字串或結構化物件）取得可顯示訊息。 */
export function getApiErrorMessage(error, fallback = "操作失敗，請稍後再試") {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (typeof detail?.message === "string" && detail.message) return detail.message;
  return fallback;
}

/** 舊分頁的 page index 已不再對應目前模板時，後端會拒絕寫入。 */
export function isProjectTemplateRevisionError(error) {
  return error?.response?.status === 409
    && error?.response?.data?.detail?.code === "project_template_revision_changed";
}

/**
 * 從 axios error 提取後端 detail 訊息，顯示 toast 並回傳訊息字串。
 * @param {Error} error - axios 拋出的錯誤
 * @param {string} fallback - 無法解析時的預設訊息
 */
export function handleApiError(error, fallback = "操作失敗，請稍後再試") {
  const message = getApiErrorMessage(error, fallback);
  toast.error(message);
  return message;
}
