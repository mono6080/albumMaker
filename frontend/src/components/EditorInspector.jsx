import { useCallback, useEffect, useRef, useState } from "react";
import { Layers3, SlidersHorizontal, Trash2, X } from "lucide-react";

import useEditorViewportMode, { EDITOR_VIEWPORT_MODE } from "../hooks/useEditorViewportMode";
import EditorSheet from "./EditorSheet";

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

function presentationForViewport(viewportMode) {
  if (viewportMode === EDITOR_VIEWPORT_MODE.PHONE) return "bottom-sheet";
  if (viewportMode === EDITOR_VIEWPORT_MODE.TABLET) return "side-drawer";
  return "static";
}

function InspectorContent({
  activeTab,
  onTabChange,
  selectedRefs,
  currentPageIndex,
  propertyPanel,
  layerPanel,
  onDeleteSelection,
  onClose,
  isModal,
  propertiesTabRef,
  layersTabRef,
}) {
  const selectionSummary = getSelectionSummary(selectedRefs);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-gray-50" data-guide="property-region">
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
              className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
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
              className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                activeTab === "layers"
                  ? "bg-indigo-50 text-indigo-700"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              <Layers3 className="h-4 w-4" />
              圖層
            </button>
          </div>
          {isModal && (
            <button
              type="button"
              aria-label="關閉編輯器檢查器"
              onClick={onClose}
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="border-t border-gray-100 px-4 py-2.5" aria-live="polite">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-800">{selectionSummary.title}</p>
              <p className="mt-0.5 truncate text-xs text-gray-500">{selectionSummary.description}</p>
            </div>
            <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              第 {currentPageIndex + 1} 頁
            </span>
          </div>
        </div>
      </div>

      <div
        id="editor-inspector-properties-panel"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
        role="tabpanel"
        aria-labelledby="editor-inspector-properties-tab"
        aria-label="屬性"
        hidden={activeTab !== "properties"}
      >
        {propertyPanel}
      </div>
      <div
        id="editor-inspector-layers-panel"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
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
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            <Trash2 className="h-4 w-4" />
            {selectedRefs.length > 1 ? `刪除 ${selectedRefs.length} 個選取物件` : "刪除選取"}
          </button>
        </div>
      )}
    </div>
  );
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
  presentation,
  isOpen: controlledIsOpen,
  onOpenChange,
  showTrigger = true,
}) {
  const viewportMode = useEditorViewportMode();
  const resolvedPresentation = presentation ?? presentationForViewport(viewportMode);
  const isStatic = resolvedPresentation === "static";
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = isStatic || (controlledIsOpen ?? internalIsOpen);
  const previousPageIndexRef = useRef(currentPageIndex);
  const previousPresentationRef = useRef(resolvedPresentation);
  const propertiesTabRef = useRef(null);
  const layersTabRef = useRef(null);

  const setIsOpen = useCallback((nextIsOpen) => {
    if (controlledIsOpen === undefined) setInternalIsOpen(nextIsOpen);
    onOpenChange?.(nextIsOpen);
  }, [controlledIsOpen, onOpenChange]);

  useEffect(() => {
    if (previousPageIndexRef.current === currentPageIndex) return;
    previousPageIndexRef.current = currentPageIndex;
    if (!isStatic) setIsOpen(false);
  }, [currentPageIndex, isStatic, setIsOpen]);

  useEffect(() => {
    if (previousPresentationRef.current === resolvedPresentation) return;
    previousPresentationRef.current = resolvedPresentation;
    if (!isStatic) setIsOpen(false);
  }, [isStatic, resolvedPresentation, setIsOpen]);

  useEffect(() => {
    if (isStatic || !isOpen) return undefined;
    const focusFrame = requestAnimationFrame(() => {
      (activeTab === "properties" ? propertiesTabRef : layersTabRef).current?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [activeTab, isOpen, isStatic]);

  const activeTabLabel = activeTab === "properties" ? "屬性" : "圖層";
  const ActiveTabIcon = activeTab === "properties" ? SlidersHorizontal : Layers3;
  const inspectorHeight = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;
  const content = (
    <InspectorContent
      activeTab={activeTab}
      onTabChange={onTabChange}
      selectedRefs={selectedRefs}
      currentPageIndex={currentPageIndex}
      propertyPanel={propertyPanel}
      layerPanel={layerPanel}
      onDeleteSelection={onDeleteSelection}
      onClose={() => setIsOpen(false)}
      isModal={!isStatic}
      propertiesTabRef={propertiesTabRef}
      layersTabRef={layersTabRef}
    />
  );

  if (isStatic) {
    return (
      <aside
        id="editor-inspector"
        className="flex h-[var(--editor-inspector-height)] max-h-[var(--editor-inspector-height)] w-[272px] flex-shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-gray-50 shadow-sm xl:w-80"
        style={{ "--editor-inspector-height": inspectorHeight }}
        aria-label="編輯器檢查器"
      >
        {content}
      </aside>
    );
  }

  return (
    <>
      {showTrigger && (
        <button
          type="button"
          aria-controls="editor-inspector"
          aria-expanded={isOpen}
          aria-hidden={isOpen ? "true" : undefined}
          tabIndex={isOpen ? -1 : undefined}
          aria-label={`開啟${activeTabLabel}面板`}
          onClick={(event) => {
            // Safari 不保證點擊按鈕後會留下焦點；先記住這個觸發器，
            // drawer 關閉時 useDialogA11y 才能一致地還原焦點。
            event.currentTarget.focus({ preventScroll: true });
            setIsOpen(true);
          }}
          className={`fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-40 inline-flex min-h-11 items-center gap-2 rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition-opacity hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 ${
            isOpen ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          <ActiveTabIcon className="h-4 w-4" />
          {activeTabLabel}
          {selectedRefs.length > 0 && (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-xs">{selectedRefs.length}</span>
          )}
        </button>
      )}

      <EditorSheet
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        presentation={resolvedPresentation}
        id="editor-inspector"
        ariaLabel="編輯器檢查器"
        showHeader={false}
        panelClassName="bg-gray-50"
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {content}
      </EditorSheet>
    </>
  );
}
