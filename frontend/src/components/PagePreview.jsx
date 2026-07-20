// 單頁渲染預覽圖子元件
// 預覽經 previewBlobCache 以 fetch 抓成 blob 快取，<img> 只吃 blob URL；
// 切回看過的頁是記憶體命中、即時，不受連線層狀態影響（見 previewImageCache.js）

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { appendPreviewCacheVersion, buildStudentPagePreviewUrl } from "../api/urls";
import { useSettledValue } from "../hooks/useSettledValue";
import { previewBlobCache } from "../utils/previewImageCache";
import { CANVAS_REAL_WIDTH, CANVAS_REAL_HEIGHT } from "../utils/renderLayoutModel";

// 共 3 次嘗試；每次失敗（含後端渲染排隊回 503）後短延遲重試
const PREVIEW_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// src 可覆寫圖片來源（全班編輯器用專案層級預覽，其餘沿用學生頁預覽）
export default function PagePreview({
  projectId,
  studentId,
  pageIndex,
  timestamp,
  templateRevision = null,
  src = null,
}) {
  // 目前顯示的 blob 與其對應 URL：換頁載入期間先留著舊圖（被 spinner 蓋住），
  // 載好再換，避免閃爍
  const [shown, setShown] = useState({ url: null, blobUrl: null });
  const [loadState, setLoadState] = useState("loading"); // loading | loaded | error

  const targetSrc = src ?? appendPreviewCacheVersion(
    buildStudentPagePreviewUrl(projectId, studentId, pageIndex),
    timestamp,
    templateRevision,
  );
  // 快速連切頁／學生時只對「停下來的那頁」發請求；單次切換仍立即載入
  const baseSrc = useSettledValue(targetSrc);
  const isSettling = baseSrc !== targetSrc;

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;

    // 記憶體命中：切回看過的頁即時顯示，不發任何請求
    // （目前顯示的正是 baseSrc 時它必已在 cache，這裡一併涵蓋 settle 抖動回同 URL）
    const cached = previewBlobCache.getCached(baseSrc);
    if (cached) {
      setShown({ url: baseSrc, blobUrl: cached });
      setLoadState("loaded");
      return () => { cancelled = true; };
    }

    setLoadState("loading");
    let attempts = 0;
    const attempt = () => {
      previewBlobCache.load(baseSrc).then(blobUrl => {
        if (cancelled) return;
        setShown({ url: baseSrc, blobUrl });
        setLoadState("loaded");
      }).catch(() => {
        if (cancelled) return;
        attempts += 1;
        if (attempts > PREVIEW_MAX_RETRIES) { setLoadState("error"); return; }
        retryTimer = window.setTimeout(attempt, RETRY_DELAY_MS);
      });
    };
    attempt();

    // 切走不 abort fetch：讓它抓完暖快取（timeout 由 cache 內部保護），
    // 只丟棄本元件對結果的後續處理
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [baseSrc]);

  const showSpinner = (loadState !== "loaded" || isSettling) && loadState !== "error";
  const showError = loadState === "error" && !isSettling;

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: `${CANVAS_REAL_WIDTH} / ${CANVAS_REAL_HEIGHT}` }}
    >
      {shown.blobUrl && (
        <img
          src={shown.blobUrl}
          alt={`第 ${pageIndex + 1} 頁`}
          className="w-full h-full object-cover"
        />
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      {showError && !shown.blobUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <span className="text-xs text-gray-400">預覽載入失敗</span>
        </div>
      )}
    </div>
  );
}
