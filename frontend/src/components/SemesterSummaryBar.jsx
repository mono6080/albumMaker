// 正式學期匯出整備度摘要；所有狀態數字都由後端 cell enum 彙整，絕不推測缺期。

import { Hammer, Loader2, Search } from "lucide-react";

import { Button, Surface, fieldControlClass } from "./ui";

function StatChip({ label, count, tone = "neutral", isActive = false, onClick }) {
  const toneClass = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warning: "border-amber-200 bg-amber-50 text-amber-700",
    danger: "border-red-200 bg-red-50 text-red-700",
    neutral: "border-gray-200 bg-gray-50 text-gray-600",
  }[tone];
  const content = (
    <>
      {label}
      <span className="font-bold">{count}</span>
    </>
  );
  const className = `inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11 ${toneClass}`;
  if (!onClick) return <span className={className}>{content}</span>;
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={`${className} transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${isActive ? "ring-2 ring-indigo-400" : "hover:shadow-sm"}`}
    >
      {content}
    </button>
  );
}

export default function SemesterSummaryBar({
  exportStats,
  searchText,
  onSearchTextChange,
  quickFilter,
  onQuickFilterChange,
  onJumpToAnomalies,
  isAdmin,
  isRenderingMissing,
  renderJob,
  onRenderMissing,
  displayedChildCount,
  displayedSelectedCount,
  onSelectAllDisplayed,
  onClearDisplayedSelected,
}) {
  return (
    <Surface padding="sm" className="mb-4 shrink-0">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="relative min-w-0 xl:w-64">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            aria-label="搜尋孩子、班級、老師或相本"
            value={searchText}
            onChange={event => onSearchTextChange(event.target.value)}
            placeholder="搜尋孩子 / 班級 / 老師 / 相本"
            className={`${fieldControlClass} pl-9`}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <StatChip
            label="全部孩子"
            count={exportStats.childCount}
            isActive={quickFilter === "all"}
            onClick={() => onQuickFilterChange("all")}
          />
          <StatChip label="PDF 已就緒" count={`${exportStats.readyCount} 本`} tone="success" />
          <StatChip
            label="未產生 PDF"
            count={`${exportStats.notRenderedCount} 本`}
            tone="warning"
            isActive={quickFilter === "not_rendered"}
            onClick={() => onQuickFilterChange(quickFilter === "not_rendered" ? "all" : "not_rendered")}
          />
          <StatChip
            label="無相本"
            count={`${exportStats.noAlbumCount} 格`}
            tone="warning"
            isActive={quickFilter === "no_album"}
            onClick={() => onQuickFilterChange(quickFilter === "no_album" ? "all" : "no_album")}
          />
          <StatChip
            label="重複相本"
            count={`${exportStats.duplicateCount} 格`}
            tone="danger"
            isActive={quickFilter === "duplicate"}
            onClick={() => onQuickFilterChange(quickFilter === "duplicate" ? "all" : "duplicate")}
          />
          {exportStats.departedCount > 0 && (
            <StatChip label="已離園" count={`${exportStats.departedCount} 格`} />
          )}
          {exportStats.identityAnomalyCount > 0 && (
            <StatChip
              label="身分異常"
              count={`${exportStats.identityAnomalyCount} 筆`}
              tone="danger"
              onClick={onJumpToAnomalies}
            />
          )}
        </div>
        {isAdmin && displayedChildCount > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <span
              className="text-xs text-gray-500"
              title="數字只算目前搜尋與狀態篩選結果內的孩子"
            >
              已選 {displayedSelectedCount}／{displayedChildCount}
            </span>
            <Button
              size="xs"
              variant="neutral"
              disabled={isRenderingMissing || displayedSelectedCount === displayedChildCount}
              onClick={onSelectAllDisplayed}
            >
              全選
            </Button>
            <Button
              size="xs"
              variant="neutral"
              disabled={isRenderingMissing || displayedSelectedCount === 0}
              onClick={onClearDisplayedSelected}
            >
              全不選
            </Button>
          </div>
        )}
        {isAdmin && exportStats.notRenderedCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="xl:flex-shrink-0"
            disabled={isRenderingMissing}
            onClick={() => onRenderMissing(null, exportStats.notRenderedCount, "目前範圍全部")}
          >
            {isRenderingMissing ? (
              <>
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                補產生中{renderJob?.total != null ? ` ${renderJob.done}/${renderJob.total}` : "…"}
              </>
            ) : (
              <>
                <Hammer aria-hidden="true" className="h-4 w-4" />
                補產生缺漏（{exportStats.notRenderedCount} 本）
              </>
            )}
          </Button>
        )}
      </div>
    </Surface>
  );
}
