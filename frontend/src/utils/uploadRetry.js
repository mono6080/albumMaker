// 上傳重試策略（與後端 BusyLimiter 契約對齊）：
// 連線逾時、網路中斷、503（上傳槽位滿）與其他 5xx 可重試；4xx（413/415/422）為永久失敗。
// BatchPhotoWizard（chunk 級重試）與 PhotoManager（單張上傳重試）共用判斷與等待時間，
// 重試迴圈本體因 UI 呈現不同而各自保留。

const RETRY_FALLBACK_DELAY_MS = 4000; // 無 Retry-After 指示時的重試等待

export function isRetryableUploadError(error) {
  if (error?.code === "ECONNABORTED") return true;
  if (!error?.response) return true;
  const status = error.response.status;
  return status === 503 || status >= 500;
}

// 503 回應帶 Retry-After（秒），優先依伺服器指示等待
export function retryDelayMs(error) {
  const retryAfterSeconds = Number(error?.response?.headers?.["retry-after"]);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return (retryAfterSeconds + 1) * 1000;
  }
  return RETRY_FALLBACK_DELAY_MS;
}
