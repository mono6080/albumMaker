// 模板編輯器的鍵盤命令綁定；命令實作由呼叫端注入。

import { useEffect } from "react";
import toast from "react-hot-toast";

import { getNodeLayerState } from "../utils/layoutLayerState.js";
import { moveLayoutNode } from "../utils/layoutSelectionOperations.js";

function isKeyboardInputTarget(target) {
  const tagName = target?.tagName;
  return target?.isContentEditable
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT";
}

export default function useEditorShortcuts({
  activeCanvasGestureRef,
  isolationGroupId,
  selectedElement,
  selectedRefs,
  setSelectedRefs,
  setInspectorTab,
  commitPageLayout,
  endHistoryGroup,
  undoLayout,
  redoLayout,
  enterGroup,
  exitGroup,
  handleCreateGroup,
  handleUngroup,
  handleCopySelection,
  handleCutSelection,
  handlePasteSelection,
  handleDuplicateSelection,
  deleteSelectedElement,
}) {
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.defaultPrevented) return;
      const isInputTarget = isKeyboardInputTarget(document.activeElement);
      const normalizedKey = keyEvent.key.toLowerCase();
      const isModifiedEditorCommand = (keyEvent.ctrlKey || keyEvent.metaKey)
        && ["c", "d", "g", "v", "x", "y", "z"].includes(normalizedKey);
      const isUnmodifiedEditorCommand = [
        "Escape", "Enter", "Delete", "Backspace",
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      ].includes(keyEvent.key);
      if (activeCanvasGestureRef.current
        && (isModifiedEditorCommand || isUnmodifiedEditorCommand)) {
        keyEvent.preventDefault();
        return;
      }
      if (keyEvent.key === "Escape") {
        if (isolationGroupId != null) {
          keyEvent.preventDefault();
          document.activeElement?.blur?.();
          exitGroup();
        } else if (!isInputTarget) {
          keyEvent.preventDefault();
          setInspectorTab("layers");
          setSelectedRefs([]);
        }
        return;
      }
      if (isInputTarget) return;
      const isUndo = (keyEvent.ctrlKey || keyEvent.metaKey)
        && !keyEvent.shiftKey
        && normalizedKey === "z";
      const isRedo = ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "y")
        || ((keyEvent.ctrlKey || keyEvent.metaKey) && keyEvent.shiftKey && normalizedKey === "z");
      if (isUndo) {
        keyEvent.preventDefault();
        undoLayout();
        return;
      }
      if (isRedo) {
        keyEvent.preventDefault();
        redoLayout();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "c" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleCopySelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "x" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleCutSelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "v") {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handlePasteSelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "d" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleDuplicateSelection();
        return;
      }
      const isGroupShortcut = (keyEvent.ctrlKey || keyEvent.metaKey)
        && normalizedKey === "g";
      const canToggleGroup = selectedRefs.length >= 2
        || (selectedRefs.length === 1 && selectedRefs[0].type === "group");
      if (isGroupShortcut && canToggleGroup) {
        keyEvent.preventDefault();
        if (keyEvent.repeat) return;
        if (selectedRefs.length >= 2) handleCreateGroup();
        else handleUngroup(selectedRefs[0].id);
        return;
      }
      if (keyEvent.key === "Enter" && selectedElement?.type === "group") {
        keyEvent.preventDefault();
        enterGroup(selectedElement.id);
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(keyEvent.key)
        && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        const step = keyEvent.shiftKey ? 10 : 1;
        const dx = keyEvent.key === "ArrowLeft" ? -step : keyEvent.key === "ArrowRight" ? step : 0;
        const dy = keyEvent.key === "ArrowUp" ? -step : keyEvent.key === "ArrowDown" ? step : 0;
        try {
          commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => {
            const state = getNodeLayerState(nextLayout, ref);
            return state.isVisible && !state.isLocked
              ? moveLayoutNode(nextLayout, ref, { dx, dy })
              : nextLayout;
          }, currentLayout), { historyGroup: "keyboard-move" });
        } catch (error) {
          toast.error(error?.message || "無法移動選取物件");
        }
        return;
      }
      if (keyEvent.key === "Delete" || keyEvent.key === "Backspace") {
        keyEvent.preventDefault();
        deleteSelectedElement();
      }
    };
    const handleKeyUp = (keyEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(keyEvent.key)) {
        endHistoryGroup("keyboard-move");
      }
    };
    const handleWindowBlur = () => endHistoryGroup("keyboard-move");
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [
    activeCanvasGestureRef,
    commitPageLayout,
    deleteSelectedElement,
    endHistoryGroup,
    enterGroup,
    exitGroup,
    handleCopySelection,
    handleCreateGroup,
    handleCutSelection,
    handleDuplicateSelection,
    handlePasteSelection,
    handleUngroup,
    isolationGroupId,
    redoLayout,
    selectedElement,
    selectedRefs,
    setInspectorTab,
    setSelectedRefs,
    undoLayout,
  ]);
}
