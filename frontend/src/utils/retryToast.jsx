// 可重試的錯誤 toast：訊息 + 重試/關閉按鈕
// 全站長流程（渲染、下載）失敗處理的標準樣式，取代只能乾瞪眼的死 toast

import toast from "react-hot-toast";

export const showRetryToast = (message, onRetry) => {
  toast.custom(t => (
    <div className={`flex items-center gap-3 bg-white border border-red-200 rounded-xl shadow-lg px-4 py-3 transition-opacity ${t.visible ? "opacity-100" : "opacity-0"}`}>
      <span className="text-sm text-red-600 font-medium">{message}</span>
      <button
        onClick={() => { toast.dismiss(t.id); onRetry(); }}
        className="text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 px-2.5 py-1 rounded-lg transition-colors font-medium"
      >
        重試
      </button>
      <button
        onClick={() => toast.dismiss(t.id)}
        className="text-gray-400 hover:text-gray-600 text-xs"
      >
        ✕
      </button>
    </div>
  ), { duration: 8000, style: { pointerEvents: "auto" } });
};
