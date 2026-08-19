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

// FastAPI 的 RequestValidationError（422）回的 detail 是陣列
// `[{ type, loc, msg, input }]`，不是字串也不是帶 message 的物件。
// 沒有這一支的話，「密碼太短」「名稱超過 100 字」這類後端已經講清楚的錯誤，
// 到畫面上會全部變成同一句 fallback。
function getValidationMessage(detail) {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const messages = detail
    .map(item => (typeof item?.msg === "string" ? item.msg : String(item)))
    .filter(Boolean);
  return messages.length ? messages.join("；") : null;
}

/**
 * 從 FastAPI detail 取得可顯示訊息。
 *
 * 後端實際會回四種形狀，這裡全部要接住——任何一種漏掉，使用者就只會看到 fallback，
 * 而後端其實已經說明了原因：
 *   1. 字串           `detail: "帳號或密碼錯誤"`
 *   2. 完成鎖代碼     `detail: { code, ...欄位 }` → 組成專用句子
 *   3. 結構化訊息     `detail: { message, ... }`
 *   4. 驗證錯誤陣列   `detail: [{ msg, loc, ... }]`（FastAPI 內建 422）
 *
 * **這是唯一的解讀器。** 各頁不要自己寫弱化版：2026-08 盤點時有 8 處各寫一套，
 * 每一套漏的形狀都不一樣（見 tests/unit/api-error.test.mjs）。
 */
export function getApiErrorMessage(error, fallback = "操作失敗，請稍後再試") {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  const completionLockMessage = getCompletionLockMessage(detail);
  if (completionLockMessage) return completionLockMessage;
  if (typeof detail?.message === "string" && detail.message) return detail.message;
  const validationMessage = getValidationMessage(detail);
  if (validationMessage) return validationMessage;
  // slowapi 的限流回的是 `{"error": "Rate limit exceeded: 10 per 1 minute"}`，
  // 沒有 detail 鍵。不特別處理的話，登入連打十次會顯示呼叫端的 fallback
  // 「登入失敗，請確認帳號與密碼」——那是錯的指示，使用者會一直重試一直失敗。
  if (error?.response?.status === 429) return "操作過於頻繁，請稍後再試";
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
