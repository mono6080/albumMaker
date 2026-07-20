// 單頁渲染預覽圖子元件
// 依 timestamp 更新觸發重新載入，避免切頁時觸發不必要的渲染

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { appendPreviewCacheVersion, buildStudentPagePreviewUrl } from "../api/urls";
import { useSettledValue } from "../hooks/useSettledValue";
import { CANVAS_REAL_WIDTH, CANVAS_REAL_HEIGHT } from "../utils/renderLayoutModel";

// src 可覆寫圖片來源（全班編輯器用專案層級預覽，其餘沿用學生頁預覽）
export default function PagePreview({
  projectId,
  studentId,
  pageIndex,
  timestamp,
  templateRevision = null,
  src = null,
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  // 載入失敗自動重試一次（例如剛好撞上後端渲染排隊），再失敗才放棄
  const [retryNonce, setRetryNonce] = useState(0);

  const targetSrc = src ?? appendPreviewCacheVersion(
    buildStudentPagePreviewUrl(projectId, studentId, pageIndex),
    timestamp,
    templateRevision,
  );
  // 快速連切頁／學生時只對「停下來的那頁」發請求；單次切換仍立即載入
  const baseSrc = useSettledValue(targetSrc);
  const isSettling = baseSrc !== targetSrc;

  useEffect(() => {
    setIsLoaded(false);
    setRetryNonce(0);
  }, [baseSrc]);

  const imageSrc = retryNonce > 0
    ? `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}retry=${retryNonce}`
    : baseSrc;

  const handleError = () => {
    if (retryNonce === 0) {
      window.setTimeout(() => setRetryNonce(1), 1500);
      return;
    }
    setIsLoaded(true);
  };

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: `${CANVAS_REAL_WIDTH} / ${CANVAS_REAL_HEIGHT}` }}
    >
      {(!isLoaded || isSettling) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      <img
        key={`${baseSrc}#${retryNonce}`}
        src={imageSrc}
        alt={`第 ${pageIndex + 1} 頁`}
        className="w-full h-full object-cover"
        onLoad={() => setIsLoaded(true)}
        onError={handleError}
      />
    </div>
  );
}
