import { useRef } from "react";
import { Layers3, SlidersHorizontal, Trash2 } from "lucide-react";

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
  const propertiesTabRef = useRef(null);
  const layersTabRef = useRef(null);
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
    <aside
      className="flex w-72 flex-shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-gray-50 shadow-sm max-lg:ml-[152px] max-lg:w-[528px] lg:w-[272px] xl:w-80"
      style={{ height: maxHeight, maxHeight }}
      data-guide="property-region"
      aria-label="編輯器檢查器"
    >
      <div className="z-10 flex-shrink-0 border-b border-gray-200 bg-white">
        <div className="grid grid-cols-2 gap-1 p-1.5" role="tablist" aria-label="右側面板">
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
  );
}
