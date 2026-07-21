// API 錯誤處理工具
// 統一從 axios error 中提取後端 detail 訊息並顯示 toast

import toast from "react-hot-toast";

// 個別完成相關錯誤碼 → 可讀中文訊息；查無對應碼時回 null 走 detail.message
function getCompletionLockMessage(detail) {
  switch (detail?.code) {
    case "student_completed_locked":
      return "這位學生已標記完成，內容已鎖定；需主管退回後才能修改";
    case "class_texts_locked_by_completed_students":
      return `全班文字已鎖定：${(detail.completed_student_names ?? []).join("、")} 已標記完成，需主管先退回這些學生才能修改`;
    case "student_not_completed":
      return "請先標記此學生完成，才能下載";
    case "student_content_incomplete":
      return `這位學生的內容尚未填完（照片 ${detail.photo_filled}/${detail.photo_total}、文字 ${detail.text_filled}/${detail.text_total}），補齊後才能標記完成`;
    case "class_zip_requires_full_completion":
      return `已完成 ${detail.completed}/${detail.total} 位，全班 ZIP 需全班完成`;
    default:
      return null;
  }
}

/** 從 FastAPI detail（字串或結構化物件）取得可顯示訊息。 */
export function getApiErrorMessage(error, fallback = "操作失敗，請稍後再試") {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  const completionLockMessage = getCompletionLockMessage(detail);
  if (completionLockMessage) return completionLockMessage;
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
