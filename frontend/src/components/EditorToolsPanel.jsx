import { useRef } from "react";

const EDITOR_TOOLS = [
  { key: "select", label: "↖ 選取", guideId: "tool-select" },
  { key: "addPhotoPortrait", label: "＋ 照片格 3:4 直式", guideId: "tool-add-photo" },
  { key: "addPhotoLandscape", label: "＋ 照片格 4:3 橫式", guideId: "tool-add-photo-landscape" },
  { key: "addText", label: "＋ 純文字", guideId: "tool-add-text" },
];

export default function EditorToolsPanel({
  activeTool,
  onToolChange,
  onBackgroundSelect,
  onBackgroundBlocked,
  onStickerSelect,
  canUploadBackground = true,
  isDisabled = false,
  showSelectTool = true,
  className = "",
}) {
  const backgroundInputRef = useRef(null);
  const stickerInputRef = useRef(null);
  const visibleTools = showSelectTool
    ? EDITOR_TOOLS
    : EDITOR_TOOLS.filter(tool => tool.key !== "select");

  return (
    <div className={`space-y-5 ${className}`} data-guide="tool-panel">
      <section aria-labelledby="editor-tools-title">
        <h2 id="editor-tools-title" className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
          工具
        </h2>
        <div className="grid gap-2">
          {visibleTools.map(tool => (
            <button
              key={tool.key}
              type="button"
              onClick={() => onToolChange?.(tool.key)}
              disabled={isDisabled}
              aria-pressed={activeTool === tool.key}
              data-guide={tool.guideId}
              className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-40 ${
                activeTool === tool.key
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {tool.label}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="editor-materials-title">
        <h2 id="editor-materials-title" className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
          素材
        </h2>
        <div className="grid gap-2">
          <button
            type="button"
            data-guide="upload-background"
            title={!canUploadBackground ? "請先儲存新增頁面" : undefined}
            disabled={isDisabled}
            onClick={() => {
              if (!canUploadBackground) {
                onBackgroundBlocked?.();
                return;
              }
              backgroundInputRef.current?.click();
            }}
            className={`flex min-h-11 w-full items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50 ${
              canUploadBackground ? "hover:bg-gray-50" : "opacity-50"
            }`}
          >
            {canUploadBackground ? "↑ 上傳背景" : "↑ 上傳背景（先儲存）"}
          </button>
          <input
            ref={backgroundInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            tabIndex={-1}
            disabled={!canUploadBackground || isDisabled}
            onChange={onBackgroundSelect}
          />

          <button
            type="button"
            disabled={isDisabled}
            onClick={() => stickerInputRef.current?.click()}
            className="flex min-h-11 w-full items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50"
          >
            ＋ 貼圖素材
          </button>
          <input
            ref={stickerInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            tabIndex={-1}
            disabled={isDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onStickerSelect?.(file);
              event.target.value = "";
            }}
          />
        </div>
      </section>
    </div>
  );
}
