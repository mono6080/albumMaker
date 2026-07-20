// 單頁渲染預覽圖子元件
// 依 timestamp 更新觸發重新載入，避免切頁時觸發不必要的渲染

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { appendPreviewCacheVersion, buildStudentPagePreviewUrl } from "../api/urls";
import { useSettledValue } from "../hooks/useSettledValue";
import { CANVAS_REAL_WIDTH, CANVAS_REAL_HEIGHT } from "../utils/renderLayoutModel";

// 共 3 次嘗試；error 後 1.5s 重試，pending 卡死 15s 後強制重發
// （15s > 後端排隊逾時 10s + 最壞渲染時間，正常慢渲染不會被誤斷）
const PREVIEW_MAX_RETRIES = 2;
const ERROR_RETRY_DELAY_MS = 1500;
const PENDING_WATCHDOG_MS = 15000;

// Chromium 會把「被切頁中斷的圖片載入」留在 per-document memory cache，
// 之後同 URL 的載入會 dedup 到那個已死的載入上——不發請求、load/error
// 都不觸發（正式站 log 證實）。記錄被中斷的 URL，重用時附加 reload 參數
// 強制發出全新請求；載入成功後保留同一個 bust 值，後續回訪走 304 快路徑
const interruptedSrcBusts = new Map();

const withParam = (base, key, value) =>
  `${base}${base.includes("?") ? "&" : "?"}${key}=${value}`;

function markInterrupted(src) {
  if (src) interruptedSrcBusts.set(src, (interruptedSrcBusts.get(src) ?? 0) + 1);
}

// src 可覆寫圖片來源（全班編輯器用專案層級預覽，其餘沿用學生頁預覽）
export default function PagePreview({
  projectId,
  studentId,
  pageIndex,
  timestamp,
  templateRevision = null,
  src = null,
}) {
  // loading / loaded / error；error 且重試額度用盡才放棄
  const [loadState, setLoadState] = useState("loading");
  const [retryNonce, setRetryNonce] = useState(0);
  // ref 同步鏡像 loadState：baseSrc 切換與 unmount 的當下要立刻判斷
  // 「上一個載入是否被中斷」，不能等 state 更新
  const loadStateRef = useRef("loading");
  const activeSrcRef = useRef(null);

  const targetSrc = src ?? appendPreviewCacheVersion(
    buildStudentPagePreviewUrl(projectId, studentId, pageIndex),
    timestamp,
    templateRevision,
  );
  // 快速連切頁／學生時只對「停下來的那頁」發請求；單次切換仍立即載入
  const baseSrc = useSettledValue(targetSrc);
  const isSettling = baseSrc !== targetSrc;

  const updateLoadState = (state) => {
    loadStateRef.current = state;
    setLoadState(state);
  };

  useEffect(() => {
    // 換頁時前一個載入還沒完成＝被瀏覽器中斷：記下來，之後重用要換新 URL
    const previousSrc = activeSrcRef.current;
    if (previousSrc && previousSrc !== baseSrc && loadStateRef.current === "loading") {
      markInterrupted(previousSrc);
    }
    activeSrcRef.current = baseSrc;
    updateLoadState("loading");
    setRetryNonce(0);
  }, [baseSrc]);

  // unmount（行動版切分頁、離開編輯頁）時未完成的載入同樣記為中斷
  useEffect(() => () => {
    if (loadStateRef.current === "loading") markInterrupted(activeSrcRef.current);
  }, []);

  // 重試統一由這裡排程：error 後短延遲重試（例如撞上後端渲染排隊回 503）；
  // loading 逾時也強制換 nonce 重發——Chromium 對「同 URL、前次載入被切頁
  // 中斷」的圖片偶爾不再發請求（pending 卡死、load/error 都不觸發），
  // 換了 nonce 的新 URL 一定會發出新請求
  useEffect(() => {
    if (loadState === "loaded" || retryNonce >= PREVIEW_MAX_RETRIES) return undefined;
    const delay = loadState === "error" ? ERROR_RETRY_DELAY_MS : PENDING_WATCHDOG_MS;
    const timer = setTimeout(() => {
      updateLoadState("loading");
      setRetryNonce(nonce => nonce + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [loadState, retryNonce, baseSrc]);

  // 中斷過的 URL 帶 reload 參數重載（bump 永遠發生在「別的」URL 上，
  // 當前 render 讀到的 bust 值在本輪不會變動）
  const interruptedBust = interruptedSrcBusts.get(baseSrc);
  const bustedBase = interruptedBust ? withParam(baseSrc, "reload", interruptedBust) : baseSrc;
  const imageSrc = retryNonce > 0 ? withParam(bustedBase, "retry", retryNonce) : bustedBase;
  const gaveUp = loadState === "error" && retryNonce >= PREVIEW_MAX_RETRIES;

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: `${CANVAS_REAL_WIDTH} / ${CANVAS_REAL_HEIGHT}` }}
    >
      {((loadState !== "loaded" && !gaveUp) || isSettling) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      {/* 切頁沿用同一個 img 元素改 src（只在重試時重建）：每次切頁都建新元素
          會踩到 Chromium 對中斷載入的 dedup 怪癖，切回原頁時可能完全不發請求 */}
      <img
        key={retryNonce}
        src={imageSrc}
        alt={`第 ${pageIndex + 1} 頁`}
        className="w-full h-full object-cover"
        onLoad={() => updateLoadState("loaded")}
        onError={() => updateLoadState("error")}
      />
    </div>
  );
}
