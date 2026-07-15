function getPageKey(page, index) {
  return page?.editorKey ?? page?.id ?? `page-${index}`;
}

export default function EditorPagesPanel({
  pages = [],
  currentPageIndex = 0,
  onSelectPage,
  onAddPage,
  onDeletePage,
  isDisabled = false,
  onPageSelected,
  className = "",
}) {
  return (
    <section className={`flex min-h-0 flex-col ${className}`} data-guide="page-list" aria-label="模板頁面">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
        {pages.map((page, pageIndex) => {
          const isCurrentPage = currentPageIndex === pageIndex;
          return (
            <button
              key={getPageKey(page, pageIndex)}
              type="button"
              onClick={() => {
                onSelectPage?.(pageIndex);
                onPageSelected?.(pageIndex);
              }}
              aria-current={isCurrentPage ? "page" : undefined}
              className={`flex min-h-11 w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                isCurrentPage
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              <span>第 {pageIndex + 1} 頁</span>
              {page?.id == null && (
                <span className={`text-xs ${isCurrentPage ? "text-indigo-100" : "text-amber-600"}`}>
                  尚未儲存
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAddPage}
          disabled={isDisabled}
          data-guide="add-page"
          className="min-h-11 w-full rounded-lg border border-dashed border-gray-300 px-3 py-2 text-left text-sm font-medium text-gray-500 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-40"
        >
          ＋ 新增頁
        </button>
      </div>

      <button
        type="button"
        onClick={onDeletePage}
        disabled={isDisabled || pages.length === 0}
        className="mt-3 min-h-11 flex-shrink-0 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:pointer-events-none disabled:opacity-40"
      >
        刪除此頁
      </button>
    </section>
  );
}
