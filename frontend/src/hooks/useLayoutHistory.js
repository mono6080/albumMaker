// 模板編輯器的分頁草稿與復原/重做歷史 hook。
//
// 狀態機本體在 utils/layoutHistoryModel.js（不含 React，有單元測試釘住）；
// 這裡只負責把結果接到畫面狀態上：更新目前頁面的 layout、undo/redo 按鈕可用態，
// 以及「改到非目前頁」時觸發一次重繪讓 dirty 標記跟上。
// currentPage / pageLayout / setPageLayout 仍由編輯器頁面持有，以參數傳入。

import { useCallback, useRef, useState } from "react";

import {
  cloneLayout,
  createLayoutHistoryStore,
  getEditorPageKey,
} from "../utils/layoutHistoryModel";

export { cloneLayout, getEditorPageKey };

// onLayoutRestored：undo/redo 套用歷史版面後呼叫；編輯器可依快照校正隔離與選取。
export default function useLayoutHistory({ currentPage, pageLayout, setPageLayout, onLayoutRestored }) {
  // 用 useState 的 lazy initializer 持有：只建立一次，而且不像 ref 那樣在 render 期間讀取
  const [store] = useState(createLayoutHistoryStore);
  // 編輯器直接讀這個 ref 判斷有沒有未儲存的草稿，維持原本的介面
  const draftLayouts = useRef(store.drafts);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [, setDraftRevision] = useState(0);

  const refreshHistoryAvailability = useCallback((pageKey) => {
    setHistoryAvailability(store.availability(pageKey));
  }, [store]);

  const endHistoryGroup = useCallback((historyGroup) => {
    store.endGroup(historyGroup);
  }, [store]);

  const beginPageSession = useCallback((page) => {
    const { pageKey, layout } = store.beginPageSession(page);
    refreshHistoryAvailability(pageKey);
    return layout;
  }, [store, refreshHistoryAvailability]);

  const dropPageHistory = useCallback((pageId) => {
    store.dropPage(pageId);
  }, [store]);

  const commitPageLayout = useCallback((layoutUpdater, { historyGroup = null } = {}) => {
    const pageKey = getEditorPageKey(currentPage);
    const result = store.commit(pageKey, pageLayout, layoutUpdater, { historyGroup });
    if (!result.committed) return;
    setPageLayout(result.layout);
    refreshHistoryAvailability(pageKey);
  }, [store, currentPage, pageLayout, setPageLayout, refreshHistoryAvailability]);

  const commitPageLayoutForPage = useCallback((
    page,
    layoutUpdater,
    { activePageKey = null } = {},
  ) => {
    const result = store.commitForPage(page, layoutUpdater, { activePageKey });
    if (!result.committed) return { committed: false, isActive: result.isActive };
    if (result.isActive) {
      setPageLayout(result.layout);
      refreshHistoryAvailability(getEditorPageKey(page));
    } else {
      // 改的是別頁：畫布不動，但 dirty 標記要跟上
      setDraftRevision(revision => revision + 1);
    }
    return { committed: true, isActive: result.isActive };
  }, [store, setPageLayout, refreshHistoryAvailability]);

  const undoLayout = useCallback(() => {
    const pageKey = getEditorPageKey(currentPage);
    const result = store.undo(pageKey, pageLayout);
    if (!result.restored) return;
    setPageLayout(result.layout);
    onLayoutRestored?.(result.layout, { kind: "undo" });
    refreshHistoryAvailability(pageKey);
  }, [store, currentPage, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  const redoLayout = useCallback(() => {
    const pageKey = getEditorPageKey(currentPage);
    const result = store.redo(pageKey, pageLayout);
    if (!result.restored) return;
    setPageLayout(result.layout);
    onLayoutRestored?.(result.layout, { kind: "redo" });
    refreshHistoryAvailability(pageKey);
  }, [store, currentPage, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  const reconcileSavedPages = useCallback((pageMappings) => {
    store.reconcileSavedPages(pageMappings);
  }, [store]);

  return {
    draftLayouts,
    canUndo: historyAvailability.canUndo,
    canRedo: historyAvailability.canRedo,
    beginPageSession,
    dropPageHistory,
    commitPageLayout,
    commitPageLayoutForPage,
    endHistoryGroup,
    undoLayout,
    redoLayout,
    reconcileSavedPages,
  };
}
