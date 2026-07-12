// 模板編輯器的分頁草稿與復原/重做歷史 hook
// 從 TemplateEditor 抽出：draftLayouts（per-page dirty layout ref）與
// layoutHistories（per-page undo/redo，上限 100）的純狀態邏輯。
// currentPage / pageLayout / setPageLayout 仍由編輯器頁面持有，以參數傳入。

import { useCallback, useRef, useState } from "react";

const MAX_LAYOUT_HISTORY = 100;

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

function layoutsEqual(leftLayout, rightLayout) {
  return JSON.stringify(leftLayout) === JSON.stringify(rightLayout);
}

function getPageHistory(historyStore, pageId) {
  if (!historyStore[pageId]) {
    historyStore[pageId] = { undo: [], redo: [] };
  }
  return historyStore[pageId];
}

// onLayoutRestored：undo/redo 套用歷史版面後呼叫（編輯器用來清除選取）
export default function useLayoutHistory({ currentPage, pageLayout, setPageLayout, onLayoutRestored }) {
  const draftLayouts = useRef({});
  const layoutHistories = useRef({});
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });

  const refreshHistoryAvailability = useCallback((pageId) => {
    if (!pageId) {
      setHistoryAvailability({ canUndo: false, canRedo: false });
      return;
    }
    const history = getPageHistory(layoutHistories.current, pageId);
    setHistoryAvailability({
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
    });
  }, []);

  // 切換到某頁時初始化該頁歷史並更新按鈕可用態，回傳應顯示的 layout（草稿優先）
  const beginPageSession = useCallback((page) => {
    getPageHistory(layoutHistories.current, page.id);
    refreshHistoryAvailability(page.id);
    return cloneLayout(draftLayouts.current[page.id] ?? page.layout);
  }, [refreshHistoryAvailability]);

  // 刪頁時丟棄該頁草稿與歷史
  const dropPageHistory = useCallback((pageId) => {
    delete draftLayouts.current[pageId];
    delete layoutHistories.current[pageId];
  }, []);

  const commitPageLayout = useCallback((layoutUpdater) => {
    if (!currentPage || !pageLayout) return;
    const pageId = currentPage.id;
    const baseLayout = draftLayouts.current[pageId] ?? pageLayout;
    const nextLayout = typeof layoutUpdater === "function" ? layoutUpdater(baseLayout) : layoutUpdater;
    if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) return;

    const history = getPageHistory(layoutHistories.current, pageId);
    history.undo.push(cloneLayout(baseLayout));
    if (history.undo.length > MAX_LAYOUT_HISTORY) history.undo.shift();
    history.redo = [];

    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[pageId] = nextSnapshot;
    setPageLayout(nextSnapshot);
    refreshHistoryAvailability(pageId);
  }, [currentPage, pageLayout, setPageLayout, refreshHistoryAvailability]);

  const undoLayout = useCallback(() => {
    if (!currentPage || !pageLayout) return;
    const history = getPageHistory(layoutHistories.current, currentPage.id);
    if (history.undo.length === 0) return;

    const previousLayout = history.undo.pop();
    history.redo.push(cloneLayout(pageLayout));
    const previousSnapshot = cloneLayout(previousLayout);
    draftLayouts.current[currentPage.id] = previousSnapshot;
    setPageLayout(previousSnapshot);
    onLayoutRestored?.();
    refreshHistoryAvailability(currentPage.id);
  }, [currentPage, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  const redoLayout = useCallback(() => {
    if (!currentPage || !pageLayout) return;
    const history = getPageHistory(layoutHistories.current, currentPage.id);
    if (history.redo.length === 0) return;

    const nextLayout = history.redo.pop();
    history.undo.push(cloneLayout(pageLayout));
    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[currentPage.id] = nextSnapshot;
    setPageLayout(nextSnapshot);
    onLayoutRestored?.();
    refreshHistoryAvailability(currentPage.id);
  }, [currentPage, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  // 批次儲存所有髒頁草稿：persistPage(pageId, layout) 由呼叫端提供 API 呼叫。
  // 全部成功後清空髒頁標記並回傳已儲存的 layout 快照；沒有髒頁時回傳 null。
  const saveDirtyLayouts = useCallback(async (pages, persistPage) => {
    const dirtyPageIds = Object.keys(draftLayouts.current).map(Number);
    if (dirtyPageIds.length === 0) return null;
    const savedLayouts = Object.fromEntries(
      dirtyPageIds.map(pageId => [pageId, cloneLayout(draftLayouts.current[pageId])])
    );
    await Promise.all(
      pages
        .filter(page => dirtyPageIds.includes(page.id))
        .map(page => persistPage(page.id, savedLayouts[page.id]))
    );
    dirtyPageIds.forEach(pageId => { delete draftLayouts.current[pageId]; });
    return savedLayouts;
  }, []);

  return {
    draftLayouts,
    canUndo: historyAvailability.canUndo,
    canRedo: historyAvailability.canRedo,
    beginPageSession,
    dropPageHistory,
    commitPageLayout,
    undoLayout,
    redoLayout,
    saveDirtyLayouts,
  };
}
