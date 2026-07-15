// 模板編輯器的複製、剪下、貼上與原地複製生命週期。

import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";

import { getEditorPageKey } from "./useLayoutHistory.js";
import { sameRef } from "./useEditorSelection.js";
import {
  deleteLayoutElement,
  deleteLayoutGroup,
} from "../utils/layoutGroupCommands.js";
import {
  createLayoutClipboard,
  duplicateLayoutNodes,
  pasteLayoutNodes,
} from "../utils/layoutDuplication.js";

export default function useLayoutClipboard({
  pageLayout,
  currentPage,
  selectedRefs,
  setSelectedRefs,
  editorLayoutModel,
  isolationGroupId,
  commitPageLayout,
  setInspectorTab,
}) {
  const [hasLayoutClipboard, setHasLayoutClipboard] = useState(false);
  const layoutClipboardRef = useRef(null);
  const clipboardPasteCountRef = useRef(0);

  const handleDuplicateSelection = useCallback(() => {
    if (!selectedRefs.length) return;
    if (selectedRefs.some(ref => {
      const state = editorLayoutModel.getNodeLayerState(ref);
      return !state.isVisible || state.isLocked;
    })) return;
    try {
      let duplicatedRefs = [];
      commitPageLayout(currentLayout => {
        const result = duplicateLayoutNodes(currentLayout, selectedRefs, {
          parentGroupId: isolationGroupId,
        });
        duplicatedRefs = result.refs;
        return result.layout;
      });
      if (duplicatedRefs.length) setSelectedRefs(duplicatedRefs);
    } catch (error) {
      toast.error(error?.message || "無法複製選取物件");
    }
  }, [commitPageLayout, editorLayoutModel, isolationGroupId, selectedRefs, setSelectedRefs]);

  const handleCopySelection = useCallback(() => {
    const clipboard = createLayoutClipboard(pageLayout, selectedRefs, {
      operation: "copy",
      sourcePageId: getEditorPageKey(currentPage),
    });
    if (!clipboard) return;
    layoutClipboardRef.current = clipboard;
    clipboardPasteCountRef.current = 0;
    setHasLayoutClipboard(true);
    toast.success(`已複製 ${selectedRefs.length} 個物件`);
  }, [currentPage, pageLayout, selectedRefs]);

  const handleCutSelection = useCallback(() => {
    const editableRefs = selectedRefs.filter(ref => {
      const state = editorLayoutModel.getNodeLayerState(ref);
      return state.isVisible && !state.isLocked;
    });
    if (editableRefs.length === 0) {
      if (selectedRefs.length > 0) toast.error("請先顯示並解除鎖定再剪下");
      return;
    }
    const clipboard = createLayoutClipboard(pageLayout, editableRefs, {
      operation: "cut",
      sourcePageId: getEditorPageKey(currentPage),
    });
    if (!clipboard) return;
    try {
      commitPageLayout(currentLayout => editableRefs.reduce((nextLayout, ref) => (
        ref.type === "group"
          ? deleteLayoutGroup(nextLayout, ref.id)
          : deleteLayoutElement(nextLayout, ref)
      ), currentLayout));
      layoutClipboardRef.current = clipboard;
      clipboardPasteCountRef.current = 0;
      setHasLayoutClipboard(true);
      setSelectedRefs(currentRefs => currentRefs.filter(
        ref => !editableRefs.some(item => sameRef(item, ref)),
      ));
      toast.success(`已剪下 ${editableRefs.length} 個物件`);
    } catch (error) {
      toast.error(error?.message || "無法剪下選取物件");
    }
  }, [
    commitPageLayout,
    currentPage,
    editorLayoutModel,
    pageLayout,
    selectedRefs,
    setSelectedRefs,
  ]);

  const handlePasteSelection = useCallback(() => {
    const clipboard = layoutClipboardRef.current;
    if (!clipboard) return;
    if (isolationGroupId != null) {
      const targetGroupState = editorLayoutModel.getNodeLayerState({
        type: "group",
        id: isolationGroupId,
      });
      if (!targetGroupState.isVisible || targetGroupState.isLocked) {
        toast.error("請先顯示並解除目前群組鎖定再貼上");
        return;
      }
    }
    try {
      let pastedRefs = [];
      let externalMaterialLinkCount = 0;
      const isFirstPaste = clipboardPasteCountRef.current === 0;
      const isCutClipboard = clipboard.operation === "cut";
      const isSourcePage = String(clipboard.sourcePageId) === String(getEditorPageKey(currentPage));
      const pasteOffset = 20 * (
        isCutClipboard ? clipboardPasteCountRef.current : clipboardPasteCountRef.current + 1
      );
      commitPageLayout(currentLayout => {
        const result = pasteLayoutNodes(currentLayout, clipboard, {
          parentGroupId: isolationGroupId,
          offset: pasteOffset,
          restoreExternalMaterialLinks: isCutClipboard && isFirstPaste && isSourcePage,
          asMove: isCutClipboard && isFirstPaste,
        });
        pastedRefs = result.refs;
        externalMaterialLinkCount = result.externalMaterialLinkCount ?? 0;
        return result.layout;
      });
      if (pastedRefs.length) {
        clipboardPasteCountRef.current += 1;
        setSelectedRefs(pastedRefs);
        setInspectorTab("properties");
        if (isCutClipboard && isFirstPaste && !isSourcePage && externalMaterialLinkCount > 0) {
          toast("跨頁貼上不會保留與原頁物件的素材文字連結");
        }
      }
    } catch (error) {
      toast.error(error?.message || "無法貼上物件");
    }
  }, [
    commitPageLayout,
    currentPage,
    editorLayoutModel,
    isolationGroupId,
    setInspectorTab,
    setSelectedRefs,
  ]);

  return {
    hasLayoutClipboard,
    handleDuplicateSelection,
    handleCopySelection,
    handleCutSelection,
    handlePasteSelection,
  };
}
