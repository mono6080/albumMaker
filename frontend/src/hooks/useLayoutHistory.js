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

export function getEditorPageKey(page) {
  return page?.editorKey ?? (page?.id == null ? null : `page:${page.id}`);
}

// onLayoutRestored：undo/redo 套用歷史版面後呼叫；編輯器可依快照校正隔離與選取。
export default function useLayoutHistory({ currentPage, pageLayout, setPageLayout, onLayoutRestored }) {
  const draftLayouts = useRef({});
  const pageLayoutBaselines = useRef({});
  const layoutHistories = useRef({});
  const activeHistoryGroupRef = useRef(null);
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [, setDraftRevision] = useState(0);

  const endHistoryGroup = useCallback((historyGroup) => {
    const activeHistoryGroup = activeHistoryGroupRef.current;
    if (!activeHistoryGroup) return;
    if (historyGroup != null && activeHistoryGroup.key !== historyGroup) return;
    activeHistoryGroupRef.current = null;
  }, []);

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
    endHistoryGroup();
    const pageKey = getEditorPageKey(page);
    pageLayoutBaselines.current[pageKey] = cloneLayout(page.layout);
    getPageHistory(layoutHistories.current, pageKey);
    refreshHistoryAvailability(pageKey);
    return cloneLayout(draftLayouts.current[pageKey] ?? page.layout);
  }, [endHistoryGroup, refreshHistoryAvailability]);

  // 刪頁時丟棄該頁草稿與歷史
  const dropPageHistory = useCallback((pageId) => {
    endHistoryGroup();
    delete draftLayouts.current[pageId];
    delete pageLayoutBaselines.current[pageId];
    delete layoutHistories.current[pageId];
  }, [endHistoryGroup]);

  const commitPageLayout = useCallback((layoutUpdater, { historyGroup = null } = {}) => {
    if (historyGroup == null) endHistoryGroup();
    if (!currentPage || !pageLayout) return;
    const pageId = getEditorPageKey(currentPage);
    const activeHistoryGroup = activeHistoryGroupRef.current;
    const continuesHistoryGroup = historyGroup != null
      && activeHistoryGroup?.pageId === pageId
      && activeHistoryGroup.key === historyGroup;
    if (!continuesHistoryGroup) activeHistoryGroupRef.current = null;

    const baseLayout = draftLayouts.current[pageId] ?? pageLayout;
    const nextLayout = typeof layoutUpdater === "function" ? layoutUpdater(baseLayout) : layoutUpdater;
    if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) return;

    const history = getPageHistory(layoutHistories.current, pageId);
    if (!continuesHistoryGroup) {
      history.undo.push(cloneLayout(baseLayout));
      if (history.undo.length > MAX_LAYOUT_HISTORY) history.undo.shift();
    }
    history.redo = [];
    activeHistoryGroupRef.current = historyGroup == null
      ? null
      : { pageId, key: historyGroup };

    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[pageId] = nextSnapshot;
    setPageLayout(nextSnapshot);
    refreshHistoryAvailability(pageId);
  }, [currentPage, endHistoryGroup, pageLayout, setPageLayout, refreshHistoryAvailability]);

  // 非同步素材上傳可在切頁後完成；將結果寫回發起上傳的頁面草稿，
  // 僅當該頁仍是目前頁面時才更新畫布與 undo/redo 按鈕。
  const commitPageLayoutForPage = useCallback((
    page,
    layoutUpdater,
    { activePageKey = null } = {},
  ) => {
    const pageKey = getEditorPageKey(page);
    if (!pageKey || !page?.layout) return { committed: false, isActive: false };
    const baseLayout = draftLayouts.current[pageKey]
      ?? pageLayoutBaselines.current[pageKey]
      ?? page.layout;
    const nextLayout = typeof layoutUpdater === "function"
      ? layoutUpdater(baseLayout)
      : layoutUpdater;
    if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) {
      return {
        committed: false,
        isActive: String(activePageKey) === String(pageKey),
      };
    }

    const history = getPageHistory(layoutHistories.current, pageKey);
    history.undo.push(cloneLayout(baseLayout));
    if (history.undo.length > MAX_LAYOUT_HISTORY) history.undo.shift();
    history.redo = [];
    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[pageKey] = nextSnapshot;

    const isActive = String(activePageKey) === String(pageKey);
    if (isActive) {
      endHistoryGroup();
      activeHistoryGroupRef.current = null;
      setPageLayout(nextSnapshot);
      refreshHistoryAvailability(pageKey);
    } else {
      setDraftRevision(revision => revision + 1);
    }
    return { committed: true, isActive };
  }, [endHistoryGroup, refreshHistoryAvailability, setPageLayout]);

  const undoLayout = useCallback(() => {
    endHistoryGroup();
    if (!currentPage || !pageLayout) return;
    const pageKey = getEditorPageKey(currentPage);
    const history = getPageHistory(layoutHistories.current, pageKey);
    if (history.undo.length === 0) return;

    const previousLayout = history.undo.pop();
    history.redo.push(cloneLayout(pageLayout));
    const previousSnapshot = cloneLayout(previousLayout);
    draftLayouts.current[pageKey] = previousSnapshot;
    setPageLayout(previousSnapshot);
    onLayoutRestored?.(previousSnapshot, { kind: "undo" });
    refreshHistoryAvailability(pageKey);
  }, [currentPage, endHistoryGroup, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  const redoLayout = useCallback(() => {
    endHistoryGroup();
    if (!currentPage || !pageLayout) return;
    const pageKey = getEditorPageKey(currentPage);
    const history = getPageHistory(layoutHistories.current, pageKey);
    if (history.redo.length === 0) return;

    const nextLayout = history.redo.pop();
    history.undo.push(cloneLayout(pageLayout));
    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[pageKey] = nextSnapshot;
    setPageLayout(nextSnapshot);
    onLayoutRestored?.(nextSnapshot, { kind: "redo" });
    refreshHistoryAvailability(pageKey);
  }, [currentPage, endHistoryGroup, pageLayout, setPageLayout, onLayoutRestored, refreshHistoryAvailability]);

  // 原子頁面快照儲存成功後，同步臨時 page id、清掉實際送出的草稿版本。
  // 儲存請求期間若又有編輯，引用不同的新版草稿會保留並搬到正式 page id。
  const reconcileSavedPages = useCallback((pageMappings) => {
    endHistoryGroup();
    for (const {
      sourcePageId,
      savedPageId,
      savedDraftReference,
      savedLayout,
    } of pageMappings) {
      const sourceKey = String(sourcePageId);
      const targetKey = String(savedPageId);
      pageLayoutBaselines.current[targetKey] = cloneLayout(savedLayout);
      if (sourceKey !== targetKey) delete pageLayoutBaselines.current[sourceKey];
      const currentDraft = draftLayouts.current[sourceKey];
      if (currentDraft !== undefined) {
        if (sourceKey === targetKey) {
          if (currentDraft === savedDraftReference) delete draftLayouts.current[sourceKey];
        } else if (currentDraft !== savedDraftReference) {
          draftLayouts.current[targetKey] = currentDraft;
          delete draftLayouts.current[sourceKey];
        } else {
          delete draftLayouts.current[sourceKey];
        }
      }
      if (sourceKey !== targetKey && layoutHistories.current[sourceKey]) {
        layoutHistories.current[targetKey] = layoutHistories.current[sourceKey];
        delete layoutHistories.current[sourceKey];
      }
    }
  }, [endHistoryGroup]);

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
