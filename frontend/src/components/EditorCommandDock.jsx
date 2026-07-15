import { createElement } from "react";
import { Files, Layers3, ListChecks, Plus, SlidersHorizontal } from "lucide-react";

const EDITOR_DOCK_PANEL = {
  ADD: "add",
  PAGES: "pages",
  LAYERS: "layers",
  PROPERTIES: "properties",
};

const PANEL_ITEMS = [
  { value: EDITOR_DOCK_PANEL.ADD, label: "新增", Icon: Plus },
  { value: EDITOR_DOCK_PANEL.PAGES, label: "頁面", Icon: Files },
  { value: EDITOR_DOCK_PANEL.LAYERS, label: "圖層", Icon: Layers3 },
  { value: EDITOR_DOCK_PANEL.PROPERTIES, label: "屬性", Icon: SlidersHorizontal },
];

function DockButton({ label, isActive, controls, onClick, disabled, children, badge }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-controls={controls}
      aria-expanded={isActive}
      onClick={(event) => {
        // Safari 點按按鈕時不一定會把焦點留在觸發器；先明確聚焦，
        // 關閉 bottom sheet 後才能可靠回到原命令。
        event.currentTarget.focus({ preventScroll: true });
        onClick?.(event);
      }}
      className={`relative inline-flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-40 ${
        isActive ? "bg-indigo-50 text-indigo-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
      }`}
    >
      {children}
      <span className="truncate">{label}</span>
      {badge > 0 && (
        <span className="absolute right-1.5 top-1 min-w-4 rounded-full bg-indigo-600 px-1 text-center text-[10px] leading-4 text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

export default function EditorCommandDock({
  activePanel = null,
  isMultiSelectActive = false,
  onToggleMultiSelect,
  onPanelChange,
  panelIds = {},
  disabledPanels = [],
  selectedCount = 0,
  className = "",
}) {
  const disabledPanelSet = new Set(disabledPanels);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur md:hidden ${className}`}
      data-guide="mobile-editor-dock"
    >
      <div className="grid grid-cols-5 gap-0.5 px-1.5 py-1" role="toolbar" aria-label="模板編輯工具">
        <button
          type="button"
          aria-label={isMultiSelectActive ? "結束多選" : "開啟多選"}
          aria-pressed={isMultiSelectActive}
          onClick={onToggleMultiSelect}
          data-guide="multi-select-toggle"
          className={`inline-flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
            isMultiSelectActive ? "bg-indigo-50 text-indigo-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
          }`}
        >
          <ListChecks className="h-5 w-5" />
          <span>多選</span>
        </button>

        {PANEL_ITEMS.map(({ value, label, Icon }) => (
          <DockButton
            key={value}
            label={label}
            controls={panelIds[value]}
            isActive={activePanel === value}
            disabled={disabledPanelSet.has(value)}
            badge={value === EDITOR_DOCK_PANEL.PROPERTIES ? selectedCount : 0}
            onClick={() => onPanelChange?.(activePanel === value ? null : value)}
          >
            {createElement(Icon, { className: "h-5 w-5" })}
          </DockButton>
        ))}
      </div>
    </div>
  );
}
