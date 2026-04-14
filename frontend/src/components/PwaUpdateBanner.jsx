// PWA 更新提示橫幅
// 偵測到新版 Service Worker 時顯示，讓使用者手動決定何時更新

import { useRegisterSW } from "virtual:pwa-register/react";
import { RefreshCw, X } from "lucide-react";

export default function PwaUpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
      <RefreshCw className="w-4 h-4 flex-shrink-0 text-indigo-400" />
      <span>有新版本可用</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="ml-1 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
      >
        立即更新
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        className="text-gray-400 hover:text-white transition-colors"
        title="稍後再說"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
