// 模板編輯器的分頁草稿與 undo/redo 狀態機（不含 React）。
//
// 為什麼要跟 hook 分家：這裡的規則全是「哪一頁的哪一版該留、哪一版該丟」，
// 錯了不會報錯——畫面照樣渲染，只是內容是別頁的、或是使用者兩秒前那一版。
// 在瀏覽器裡要重現得靠攔截網路人工延遲回應，慢又不穩；抽成純狀態機之後，
// 任何交錯順序都能直接排出來測。React 那一層只剩「把結果接到畫面狀態上」。

const MAX_LAYOUT_HISTORY = 100;

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

function layoutsEqual(leftLayout, rightLayout) {
  return JSON.stringify(leftLayout) === JSON.stringify(rightLayout);
}

export function getEditorPageKey(page) {
  return page?.editorKey ?? (page?.id == null ? null : `page:${page.id}`);
}

export function createLayoutHistoryStore() {
  const drafts = {};
  const baselines = {};
  const histories = {};
  let activeGroup = null;

  function historyFor(pageKey) {
    if (!histories[pageKey]) histories[pageKey] = { undo: [], redo: [] };
    return histories[pageKey];
  }

  function pushUndo(history, layout) {
    history.undo.push(cloneLayout(layout));
    if (history.undo.length > MAX_LAYOUT_HISTORY) history.undo.shift();
  }

  return {
    drafts,
    baselines,

    availability(pageKey) {
      if (!pageKey) return { canUndo: false, canRedo: false };
      const history = historyFor(pageKey);
      return { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0 };
    },

    /** 結束目前的歷史合併群組；帶 key 時只結束同一個群組。 */
    endGroup(groupKey) {
      if (!activeGroup) return;
      if (groupKey != null && activeGroup.key !== groupKey) return;
      activeGroup = null;
    },

    /** 切到某頁：建立基準版本與歷史，回傳該頁應顯示的 layout（草稿優先）。 */
    beginPageSession(page) {
      this.endGroup();
      const pageKey = getEditorPageKey(page);
      baselines[pageKey] = cloneLayout(page.layout);
      historyFor(pageKey);
      return { pageKey, layout: cloneLayout(drafts[pageKey] ?? page.layout) };
    },

    dropPage(pageKey) {
      this.endGroup();
      delete drafts[pageKey];
      delete baselines[pageKey];
      delete histories[pageKey];
    },

    /**
     * 目前頁面的編輯。`historyGroup` 讓連續的同類操作（例如一直打字）
     * 合併成一次 undo：同頁同 key 的後續 commit 不再推新的 undo 版本。
     */
    commit(pageKey, currentLayout, layoutUpdater, { historyGroup = null } = {}) {
      if (historyGroup == null) this.endGroup();
      if (!pageKey || !currentLayout) return { committed: false };
      const continuesGroup = historyGroup != null
        && activeGroup?.pageKey === pageKey
        && activeGroup.key === historyGroup;
      if (!continuesGroup) activeGroup = null;

      const baseLayout = drafts[pageKey] ?? currentLayout;
      const nextLayout = typeof layoutUpdater === "function"
        ? layoutUpdater(baseLayout)
        : layoutUpdater;
      if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) return { committed: false };

      const history = historyFor(pageKey);
      if (!continuesGroup) pushUndo(history, baseLayout);
      history.redo = [];
      activeGroup = historyGroup == null ? null : { pageKey, key: historyGroup };

      const snapshot = cloneLayout(nextLayout);
      drafts[pageKey] = snapshot;
      return { committed: true, layout: snapshot };
    },

    /**
     * 非同步上傳可能在使用者切頁之後才回來。結果必須寫回**發起上傳的那一頁**，
     * 不是目前這一頁——否則貼圖會落在使用者剛切過去的頁面上，而且畫面不會報錯。
     */
    commitForPage(page, layoutUpdater, { activePageKey = null } = {}) {
      const pageKey = getEditorPageKey(page);
      if (!pageKey || !page?.layout) return { committed: false, isActive: false };
      const isActive = String(activePageKey) === String(pageKey);
      const baseLayout = drafts[pageKey] ?? baselines[pageKey] ?? page.layout;
      const nextLayout = typeof layoutUpdater === "function"
        ? layoutUpdater(baseLayout)
        : layoutUpdater;
      if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) {
        return { committed: false, isActive };
      }

      const history = historyFor(pageKey);
      pushUndo(history, baseLayout);
      history.redo = [];
      const snapshot = cloneLayout(nextLayout);
      drafts[pageKey] = snapshot;
      if (isActive) activeGroup = null;
      return { committed: true, isActive, layout: snapshot };
    },

    undo(pageKey, currentLayout) {
      this.endGroup();
      if (!pageKey || !currentLayout) return { restored: false };
      const history = historyFor(pageKey);
      if (history.undo.length === 0) return { restored: false };
      const previous = history.undo.pop();
      history.redo.push(cloneLayout(currentLayout));
      const snapshot = cloneLayout(previous);
      drafts[pageKey] = snapshot;
      return { restored: true, layout: snapshot };
    },

    redo(pageKey, currentLayout) {
      this.endGroup();
      if (!pageKey || !currentLayout) return { restored: false };
      const history = historyFor(pageKey);
      if (history.redo.length === 0) return { restored: false };
      const next = history.redo.pop();
      history.undo.push(cloneLayout(currentLayout));
      const snapshot = cloneLayout(next);
      drafts[pageKey] = snapshot;
      return { restored: true, layout: snapshot };
    },

    /**
     * 原子儲存成功之後對帳：把臨時 page id 換成正式 id，並清掉「確實送出去的那一版」
     * 草稿。儲存請求還在飛的時候若又編輯過，那一版**不是**送出去的那個物件，
     * 必須保留並搬到正式 id 底下——否則使用者在儲存期間打的字會靜靜消失。
     */
    reconcileSavedPages(pageMappings) {
      this.endGroup();
      for (const {
        sourcePageId,
        savedPageId,
        savedDraftReference,
        savedLayout,
      } of pageMappings) {
        const sourceKey = String(sourcePageId);
        const targetKey = String(savedPageId);
        baselines[targetKey] = cloneLayout(savedLayout);
        if (sourceKey !== targetKey) delete baselines[sourceKey];
        const currentDraft = drafts[sourceKey];
        if (currentDraft !== undefined) {
          if (sourceKey === targetKey) {
            if (currentDraft === savedDraftReference) delete drafts[sourceKey];
          } else if (currentDraft !== savedDraftReference) {
            drafts[targetKey] = currentDraft;
            delete drafts[sourceKey];
          } else {
            delete drafts[sourceKey];
          }
        }
        if (sourceKey !== targetKey && histories[sourceKey]) {
          histories[targetKey] = histories[sourceKey];
          delete histories[sourceKey];
        }
      }
    },
  };
}
