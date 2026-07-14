import { useEffect, useRef, useState } from "react";
import { Layers3, SlidersHorizontal, Trash2, X } from "lucide-react";

import useDialogA11y from "../hooks/useDialogA11y";

const DRAWER_MEDIA_QUERY = "(max-width: 1023px)";

const ELEMENT_TYPE_LABELS = {
  photo: "照片格",
  text: "純文字",
  sticker: "貼圖",
  group: "群組",
};

function getSelectionSummary(selectedRefs) {
  if (selectedRefs.length === 0) {
    return {
      title: "尚未選取物件",
      description: "可從畫布或圖層清單選取",
    };
  }
  if (selectedRefs.length > 1) {
    return {
      title: `多重選取（${selectedRefs.length}）`,
      description: "可群組或批次調整選取項目",
    };
  }
  const selectedType = ELEMENT_TYPE_LABELS[selectedRefs[0]?.type] ?? "物件";
  return {
    title: `已選取：${selectedType}`,
    description: "在屬性頁籤調整詳細設定",
  };
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(query).matches
  ));

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

export default function EditorInspector({
  activeTab,
  onTabChange,
  selectedRefs,
  currentPageIndex,
  maxHeight,
  propertyPanel,
  layerPanel,
  onDeleteSelection,
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const isDrawerViewport = useMediaQuery(DRAWER_MEDIA_QUERY);
  const isPointerDownRef = useRef(false);
  const pendingAutoOpenRef = useRef(false);
  const shouldRestoreTriggerFocusRef = useRef(false);
  const previousPageIndexRef = useRef(currentPageIndex);
  const drawerTriggerRef = useRef(null);
  const propertiesTabRef = useRef(null);
  const layersTabRef = useRef(null);
  const handleCloseDrawer = () => setIsDrawerOpen(false);
  const inspectorRef = useDialogA11y({
    isOpen: isDrawerViewport && isDrawerOpen,
    onClose: handleCloseDrawer,
  });
  const selectionSummary = getSelectionSummary(selectedRefs);
  const shouldAutoOpenDrawer = isDrawerViewport
    && activeTab === "properties"
    && selectedRefs.length > 0;
  const shouldAutoOpenDrawerRef = useRef(shouldAutoOpenDrawer);

  useEffect(() => {
    shouldAutoOpenDrawerRef.current = shouldAutoOpenDrawer;
  }, [shouldAutoOpenDrawer]);

  useEffect(() => {
    const handlePointerDown = () => {
      isPointerDownRef.current = true;
    };
    const handlePointerEnd = () => {
      isPointerDownRef.current = false;
      if (pendingAutoOpenRef.current && shouldAutoOpenDrawerRef.current) {
        shouldRestoreTriggerFocusRef.current = false;
        setIsDrawerOpen(true);
      }
      pendingAutoOpenRef.current = false;
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
    };
  }, []);

  useEffect(() => {
    if (!shouldAutoOpenDrawer) {
      pendingAutoOpenRef.current = false;
      return;
    }
    if (isPointerDownRef.current) {
      pendingAutoOpenRef.current = true;
      return;
    }
    shouldRestoreTriggerFocusRef.current = false;
    setIsDrawerOpen(true);
  }, [shouldAutoOpenDrawer, selectedRefs]);

  useEffect(() => {
    if (previousPageIndexRef.current !== currentPageIndex) {
      previousPageIndexRef.current = currentPageIndex;
      pendingAutoOpenRef.current = false;
      shouldRestoreTriggerFocusRef.current = false;
      setIsDrawerOpen(false);
    }
  }, [currentPageIndex]);

  useEffect(() => {
    if (!isDrawerViewport || !isDrawerOpen) return undefined;
    const focusFrame = requestAnimationFrame(() => {
      (activeTab === "properties" ? propertiesTabRef : layersTabRef).current?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [activeTab, isDrawerOpen, isDrawerViewport]);

  useEffect(() => {
    if (!isDrawerViewport || isDrawerOpen || !shouldRestoreTriggerFocusRef.current) {
      return undefined;
    }
    shouldRestoreTriggerFocusRef.current = false;
    const focusFrame = requestAnimationFrame(() => drawerTriggerRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [isDrawerOpen, isDrawerViewport]);

  const handleTabKeyDown = (event) => {
    let nextTab = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = activeTab === "properties" ? "layers" : "properties";
    } else if (event.key === "Home") {
      nextTab = "properties";
    } else if (event.key === "End") {
      nextTab = "layers";
    }
    if (!nextTab) return;
    event.preventDefault();
    onTabChange(nextTab);
    (nextTab === "properties" ? propertiesTabRef : layersTabRef).current?.focus();
  };

  const activeTabLabel = activeTab === "properties" ? "屬性" : "圖層";
  const ActiveTabIcon = activeTab === "properties" ? SlidersHorizontal : Layers3;
  const inspectorHeight = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;

  return (
    <>
      <button
        ref={drawerTriggerRef}
        type="button"
        aria-controls="editor-inspector"
        aria-expanded={isDrawerOpen}
        aria-hidden={isDrawerOpen ? "true" : undefined}
        tabIndex={isDrawerOpen ? -1 : undefined}
        aria-label={`開啟${activeTabLabel}面板`}
        onClick={() => {
          shouldRestoreTriggerFocusRef.current = true;
          setIsDrawerOpen(true);
        }}
        className={`fixed bottom-4 right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition-opacity hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 lg:hidden ${
          isDrawerOpen ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <ActiveTabIcon className="h-4 w-4" />
        {activeTabLabel}
        {selectedRefs.length > 0 && (
          <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-xs">
            {selectedRefs.length}
          </span>
        )}
      </button>

      {isDrawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[1px] lg:hidden"
          aria-hidden="true"
          onClick={handleCloseDrawer}
        />
      )}

      <aside
        ref={inspectorRef}
        id="editor-inspector"
        tabIndex={isDrawerViewport ? -1 : undefined}
        role={isDrawerViewport ? "dialog" : undefined}
        aria-modal={isDrawerViewport ? "true" : undefined}
        aria-hidden={isDrawerViewport && !isDrawerOpen ? "true" : undefined}
        className={`flex-shrink-0 flex-col overflow-hidden border border-gray-200 bg-gray-50 shadow-sm max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:h-dvh max-lg:max-h-dvh max-lg:w-[min(92vw,24rem)] max-lg:rounded-none max-lg:border-y-0 max-lg:border-r-0 lg:flex lg:h-[var(--editor-inspector-height)] lg:max-h-[var(--editor-inspector-height)] lg:w-[272px] lg:rounded-xl xl:w-80 ${
          isDrawerOpen ? "max-lg:flex" : "max-lg:hidden"
        }`}
        style={{ "--editor-inspector-height": inspectorHeight }}
        data-guide="property-region"
        aria-label="編輯器檢查器"
      >
      <div className="z-10 flex-shrink-0 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-1 p-1.5">
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1" role="tablist" aria-label="右側面板">
            <button
              ref={propertiesTabRef}
              type="button"
              role="tab"
              id="editor-inspector-properties-tab"
              aria-controls="editor-inspector-properties-panel"
              aria-selected={activeTab === "properties"}
              tabIndex={activeTab === "properties" ? 0 : -1}
              data-guide="inspector-tab-properties"
              onClick={() => onTabChange("properties")}
              onKeyDown={handleTabKeyDown}
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === "properties"
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              <SlidersHorizontal className="h-4 w-4" />
              屬性
            </button>
            <button
              ref={layersTabRef}
              type="button"
              role="tab"
              id="editor-inspector-layers-tab"
              aria-controls="editor-inspector-layers-panel"
              aria-selected={activeTab === "layers"}
              tabIndex={activeTab === "layers" ? 0 : -1}
              data-guide="inspector-tab-layers"
              onClick={() => onTabChange("layers")}
              onKeyDown={handleTabKeyDown}
              className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === "layers"
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              <Layers3 className="h-4 w-4" />
              圖層
            </button>
          </div>
          <button
            type="button"
            aria-label="關閉編輯器檢查器"
            onClick={handleCloseDrawer}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-t border-gray-100 px-4 py-2.5" aria-live="polite">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-800">{selectionSummary.title}</p>
              <p className="mt-0.5 truncate text-xs text-gray-400">{selectionSummary.description}</p>
            </div>
            <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              第 {currentPageIndex + 1} 頁
            </span>
          </div>
        </div>
      </div>

      <div
        id="editor-inspector-properties-panel"
        className="min-h-0 flex-1 overflow-y-auto p-3"
        role="tabpanel"
        aria-labelledby="editor-inspector-properties-tab"
        aria-label="屬性"
        hidden={activeTab !== "properties"}
      >
        {propertyPanel}
      </div>
      <div
        id="editor-inspector-layers-panel"
        className="min-h-0 flex-1 overflow-y-auto p-3"
        role="tabpanel"
        aria-labelledby="editor-inspector-layers-tab"
        aria-label="圖層"
        hidden={activeTab !== "layers"}
      >
        {layerPanel}
      </div>

      {selectedRefs.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3">
          <button
            type="button"
            onClick={onDeleteSelection}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
            {selectedRefs.length > 1 ? `刪除 ${selectedRefs.length} 個選取物件` : "刪除選取"}
          </button>
        </div>
      )}
      </aside>
    </>
  );
}
