// 學期彙整匯出：補產生失敗清單橫幅（講清楚是哪幾本，不是只給數字）

import { Surface } from "./ui";

export default function SemesterRenderErrorsBanner({ errors, onDismiss }) {
  return (
    <Surface padding="sm" className="mb-4 shrink-0 border-red-200 bg-red-50/60">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-xs text-red-700">
          <span className="font-semibold">補產生失敗 {errors.length} 本：</span>
          {errors.map((error, index) => (
            <span key={index}>
              {index > 0 && "、"}
              {error.student}（{error.project}）
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-0.5 text-red-400 hover:bg-red-100 hover:text-red-600"
          aria-label="關閉失敗清單"
        >
          ✕
        </button>
      </div>
    </Surface>
  );
}
