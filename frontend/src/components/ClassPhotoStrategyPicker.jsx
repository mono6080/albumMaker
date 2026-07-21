// 「放照片」Modal 的步驟 1：選擇分配方式 — 純顯示選卡（每人不同張 / 多人同一張）
// 純位移自 ClassEdit 的 slotPhotoModal；Modal 本體與上傳流程仍在頁面層

import { Badge } from "./ui";

export default function ClassPhotoStrategyPicker({ value, onSelect }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">1</span>
        <h3 className="text-sm font-semibold text-gray-800">選擇分配方式</h3>
      </div>
      <div data-guide="class-photo-strategies" className="grid gap-2 md:grid-cols-2">
        <button
          type="button"
          onClick={() => onSelect("individual")}
          aria-pressed={value === "individual"}
          className={`rounded-xl border p-3 text-left transition-all ${
            value === "individual"
              ? "border-violet-400 bg-violet-50/50 ring-2 ring-violet-300"
              : "border-gray-200 bg-white hover:border-violet-200 hover:bg-violet-50/30"
          }`}
        >
          <div className="mb-1 flex items-center gap-2">
            <h4 className="text-sm font-bold text-gray-900">每人不同張</h4>
            <Badge tone="primary">最常用</Badge>
          </div>
          <p className="text-xs leading-relaxed text-gray-600">
            每位學生這一格放自己的照片，一次上傳多張自動分配。
          </p>
        </button>
        <button
          type="button"
          onClick={() => onSelect("shared")}
          aria-pressed={value === "shared"}
          className={`rounded-xl border p-3 text-left transition-all ${
            value === "shared"
              ? "border-violet-400 bg-violet-50/50 ring-2 ring-violet-300"
              : "border-gray-200 bg-white hover:border-violet-200 hover:bg-violet-50/30"
          }`}
        >
          <div className="mb-1 flex items-center gap-2">
            <h4 className="text-sm font-bold text-gray-900">多人同一張</h4>
          </div>
          <p className="text-xs leading-relaxed text-gray-600">
            團體照或小組合照，一張套用到全班，也可只選部分學生。
          </p>
        </button>
      </div>
    </div>
  );
}
