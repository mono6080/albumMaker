// 模板編輯器的選取、群組隔離與版面復原後校正。

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getGroupAncestorPath,
  getGroupById,
  getScopeNodes,
} from "../utils/layoutGroupQueries.js";

export function refKey(ref) {
  return ref ? `${ref.type}:${String(ref.id)}` : "";
}

export function sameRef(left, right) {
  return refKey(left) === refKey(right);
}

export default function useEditorSelection({
  pageLayout,
  editorLayoutModel,
  isMultiSelectMode,
  setInspectorTab,
}) {
  const [selectedRefs, setSelectedRefs] = useState([]);
  const [isolationPath, setIsolationPath] = useState([]);
  const editorViewRef = useRef({ isolationPath: [], selectedRefs: [] });

  const isolationGroupId = isolationPath.length
    ? isolationPath[isolationPath.length - 1]
    : null;
  const selectedElement = selectedRefs.length === 1 ? selectedRefs[0] : null;

  useEffect(() => {
    editorViewRef.current = { isolationPath, selectedRefs };
  }, [isolationPath, selectedRefs]);

  useEffect(() => {
    if (selectedRefs.length === 0) setInspectorTab("layers");
  }, [selectedRefs.length, setInspectorTab]);

  const setSelectedElement = useCallback((nextSelection) => {
    setSelectedRefs(currentRefs => {
      const currentSelection = currentRefs.length === 1 ? currentRefs[0] : null;
      const resolvedSelection = typeof nextSelection === "function"
        ? nextSelection(currentSelection)
        : nextSelection;
      return resolvedSelection ? [resolvedSelection] : [];
    });
  }, []);

  const resetEditorView = useCallback(() => {
    setSelectedRefs([]);
    setInspectorTab("layers");
    setIsolationPath([]);
  }, [setInspectorTab]);

  const reconcileRestoredEditorView = useCallback((restoredLayout) => {
    const previousView = editorViewRef.current;
    let nextPath = [];
    for (let index = previousView.isolationPath.length - 1; index >= 0; index -= 1) {
      const candidateId = previousView.isolationPath[index];
      if (getGroupById(restoredLayout, candidateId)) {
        nextPath = getGroupAncestorPath(restoredLayout, candidateId);
        break;
      }
    }
    const nextScopeId = nextPath.length ? nextPath[nextPath.length - 1] : null;
    const directKeys = new Set(getScopeNodes(restoredLayout, nextScopeId).map(refKey));
    const nextSelection = previousView.selectedRefs.filter(ref => directKeys.has(refKey(ref)));
    editorViewRef.current = { isolationPath: nextPath, selectedRefs: nextSelection };
    setIsolationPath(nextPath);
    setSelectedRefs(nextSelection);
  }, []);

  const handleSelectDirectRef = useCallback((directRef, { additive = false } = {}) => {
    if (!pageLayout || !directRef) return;
    const directKeys = new Set(editorLayoutModel.getScopeNodes(isolationGroupId).map(refKey));
    if (!directKeys.has(refKey(directRef))) return;
    if (!additive) {
      setSelectedRefs([directRef]);
      return;
    }
    setSelectedRefs(currentRefs => {
      const baseRefs = currentRefs.filter(ref => directKeys.has(refKey(ref)));
      return baseRefs.some(ref => sameRef(ref, directRef))
        ? baseRefs.filter(ref => !sameRef(ref, directRef))
        : [...baseRefs, directRef];
    });
  }, [editorLayoutModel, isolationGroupId, pageLayout]);

  const handleSelectElement = useCallback((elementRef, options = {}) => {
    if (!pageLayout || !elementRef) return;
    const directRef = editorLayoutModel.resolveHitToDirectChild(isolationGroupId, elementRef);
    if (directRef) handleSelectDirectRef(directRef, options);
  }, [editorLayoutModel, handleSelectDirectRef, isolationGroupId, pageLayout]);

  const handleSelectGroup = useCallback((groupId, options = {}) => {
    handleSelectDirectRef({ type: "group", id: groupId }, options);
  }, [handleSelectDirectRef]);

  const handleCanvasSelectElement = useCallback((elementRef, options = {}) => {
    setInspectorTab("properties");
    handleSelectElement(elementRef, {
      ...options,
      additive: isMultiSelectMode || options.additive,
    });
  }, [handleSelectElement, isMultiSelectMode, setInspectorTab]);

  const handleCanvasSelectGroup = useCallback((groupId, options = {}) => {
    setInspectorTab("properties");
    handleSelectGroup(groupId, {
      ...options,
      additive: isMultiSelectMode || options.additive,
    });
  }, [handleSelectGroup, isMultiSelectMode, setInspectorTab]);

  const handleCanvasSelectRef = useCallback((selectionRef, options = {}) => {
    if (selectionRef?.type === "group") {
      handleCanvasSelectGroup(selectionRef.id, options);
      return;
    }
    handleCanvasSelectElement(selectionRef, options);
  }, [handleCanvasSelectElement, handleCanvasSelectGroup]);

  const handleCanvasClearSelection = useCallback(() => {
    setInspectorTab("layers");
    setSelectedElement(null);
  }, [setInspectorTab, setSelectedElement]);

  const enterGroup = useCallback((groupId, preferredHit = null) => {
    if (!pageLayout) return;
    const groupRef = { type: "group", id: groupId };
    const isDirect = editorLayoutModel
      .getScopeNodes(isolationGroupId)
      .some(ref => sameRef(ref, groupRef));
    const group = isDirect ? editorLayoutModel.getGroupById(groupId) : null;
    if (!group) return;
    let nextChild = null;
    if (preferredHit?.type === "group") {
      nextChild = group.children.find(ref => sameRef(ref, preferredHit)) ?? null;
    } else if (preferredHit) {
      nextChild = editorLayoutModel.resolveHitToDirectChild(group.id, preferredHit);
    }
    nextChild ??= group.children[0] ?? null;
    setIsolationPath(editorLayoutModel.getGroupAncestorPath(group.id));
    setSelectedRefs(nextChild ? [nextChild] : []);
  }, [editorLayoutModel, isolationGroupId, pageLayout]);

  const exitGroup = useCallback(() => {
    if (!isolationPath.length) return;
    const exitedGroupId = isolationPath[isolationPath.length - 1];
    setIsolationPath(currentPath => currentPath.slice(0, -1));
    setSelectedRefs([{ type: "group", id: exitedGroupId }]);
  }, [isolationPath]);

  const navigateIsolation = useCallback((pathIndex) => {
    if (!isolationPath.length) return;
    const nextLength = Math.max(0, Math.min(isolationPath.length, pathIndex + 1));
    if (nextLength === isolationPath.length) return;
    const exitedDirectGroupId = isolationPath[nextLength];
    setIsolationPath(isolationPath.slice(0, nextLength));
    setSelectedRefs(exitedDirectGroupId == null
      ? []
      : [{ type: "group", id: exitedDirectGroupId }]);
  }, [isolationPath]);

  const handleActivateElement = useCallback((elementRef) => {
    if (!pageLayout || !elementRef) return;
    const directRef = editorLayoutModel.resolveHitToDirectChild(isolationGroupId, elementRef);
    if (directRef?.type === "group") enterGroup(directRef.id, elementRef);
  }, [editorLayoutModel, enterGroup, isolationGroupId, pageLayout]);

  useEffect(() => {
    if (!pageLayout) return;
    const deepestSurvivingId = [...isolationPath]
      .reverse()
      .find(id => editorLayoutModel.getGroupById(id));
    const canonicalPath = deepestSurvivingId == null
      ? []
      : editorLayoutModel.getGroupAncestorPath(deepestSurvivingId);
    if (canonicalPath.length !== isolationPath.length
      || canonicalPath.some((id, index) => String(id) !== String(isolationPath[index]))) {
      setIsolationPath(canonicalPath);
      return;
    }
    const directKeys = new Set(editorLayoutModel.getScopeNodes(isolationGroupId).map(refKey));
    setSelectedRefs(currentRefs => {
      const survivingRefs = currentRefs.filter(ref => directKeys.has(refKey(ref)));
      return survivingRefs.length === currentRefs.length ? currentRefs : survivingRefs;
    });
  }, [editorLayoutModel, isolationGroupId, isolationPath, pageLayout]);

  return {
    selectedRefs,
    setSelectedRefs,
    selectedElement,
    setSelectedElement,
    isolationPath,
    setIsolationPath,
    isolationGroupId,
    resetEditorView,
    reconcileRestoredEditorView,
    handleSelectElement,
    handleSelectGroup,
    handleCanvasSelectRef,
    handleCanvasClearSelection,
    handleActivateElement,
    enterGroup,
    exitGroup,
    navigateIsolation,
  };
}
