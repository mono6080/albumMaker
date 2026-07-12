// 學期彙整匯出：整備度摘要列（搜尋框、統計 chip 快速過濾、補產生全部缺漏按鈕）
// 狀態與補渲染 job 輪詢都在 SemesterExport 頁，這裡只負責呈現與轉發事件

import { Hammer, Loader2, Search } from "lucide-react";

import { Button, Surface } from "./ui";

/** 整備度摘要 chip：有 onClick 時可點擊過濾，無 onClick 時為純顯示統計 */
function StatChip({ label, count, tone, isActive, onClick }) {
  const toneClass = {
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    neutral: "bg-gray-50 text-gray-600 border-gray-200",
  }[tone] ?? "bg-gray-50 text-gray-600 border-gray-200";
  const chipContent = (
    <>
      {label}
      <span className="font-bold">{count}</span>
    </>
  );
  const sharedClass = `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${toneClass}`;
  if (!onClick) {
    return <span className={sharedClass}>{chipContent}</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${sharedClass} transition-shadow ${isActive ? "ring-2 ring-indigo-400" : "hover:shadow-sm"}`}
    >
      {chipContent}
    </button>
  );
}

export default function SemesterSummaryBar({
  preview,
  exportStats,
  searchText,
  onSearchTextChange,
  quickFilter,
  onQuickFilterChange,
  // 點「待確認」chip 時捲動到待確認配對區塊
  onJumpToUnlinked,
  isAdmin,
  isRenderingMissing,
  renderJob,
  onRenderMissing,
}) {
  return (
    <Surface padding="sm" className="mb-4 shrink-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={searchText}
            onChange={event => onSearchTextChange(event.target.value)}
            placeholder="搜尋孩子 / 班級 / 老師"
            className="w-48 rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <StatChip
          label="全部孩子"
          count={preview.children.length}
          tone="neutral"
          isActive={quickFilter === "all"}
          onClick={() => onQuickFilterChange("all")}
        />
        <StatChip label="已就緒" count={`${exportStats.readyBooks} 本`} tone="success" />
        <StatChip
          label="未產生"
          count={`${exportStats.missingBooks} 本`}
          tone="warning"
          isActive={quickFilter === "unrendered"}
          onClick={() => onQuickFilterChange(quickFilter === "unrendered" ? "all" : "unrendered")}
        />
        <StatChip
          label="缺期"
          count={`${exportStats.missingPeriodChildIds.size} 位`}
          tone="warning"
          isActive={quickFilter === "missingPeriod"}
          onClick={() => onQuickFilterChange(quickFilter === "missingPeriod" ? "all" : "missingPeriod")}
        />
        {preview.unlinked.length > 0 && (
          <StatChip
            label="待確認"
            count={`${preview.unlinked.length} 位`}
            tone="warning"
            isActive={false}
            onClick={onJumpToUnlinked}
          />
        )}
        {isAdmin && exportStats.missingBooks > 0 && (
          <Button
            variant="secondary"
            size="xs"
            className="ml-auto"
            disabled={isRenderingMissing}
            onClick={() => onRenderMissing(null, exportStats.missingBooks, "全部")}
          >
            {isRenderingMissing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                補產生中{renderJob?.total != null ? ` ${renderJob.done}/${renderJob.total}` : "…"}
              </>
            ) : (
              <>
                <Hammer className="h-3.5 w-3.5" />
                補產生全部缺漏（{exportStats.missingBooks} 本）
              </>
            )}
          </Button>
        )}
      </div>
    </Surface>
  );
}
