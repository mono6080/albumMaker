// PWA 更新提示橫幅
// autoUpdate 模式：Service Worker 在背景自動安裝並接管後，
// 顯示橫幅讓使用者選擇立即 reload 或稍後（下次開啟時自然生效）

import { useState, useEffect } from "react";
import { RefreshCw, X } from "lucide-react";

export default function PwaUpdateBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // controllerchange 代表新版 SW 已取得控制權（autoUpdate 自動 skipWaiting 後觸發）
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      setShowBanner(true);
    });
  }, []);

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
      <RefreshCw className="w-4 h-4 flex-shrink-0 text-indigo-400" />
      <span>已更新到新版本</span>
      <button
        onClick={() => window.location.reload()}
        className="ml-1 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
      >
        立即重新載入
      </button>
      <button
        onClick={() => setShowBanner(false)}
        className="text-gray-400 hover:text-white transition-colors"
        title="稍後再說"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
