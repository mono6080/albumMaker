import {
  Group as GroupIcon,
  Image as ImageIcon,
  Layers,
  Square,
  Type as TypeIcon,
} from "lucide-react";

export default function GroupSelectionPanel({
  items,
  onGroup,
  onLinkMaterialText,
  materialActionsDisabled = false,
}) {
  const isMaterialTextPair = items.length === 2
    && items.some(item => item.type === "sticker")
    && items.some(item => item.type === "text");
  const getItemIcon = (type) => {
    if (type === "text") return <TypeIcon className="h-3.5 w-3.5 text-indigo-500" />;
    if (type === "photo") return <ImageIcon className="h-3.5 w-3.5 text-amber-500" />;
    if (type === "group") return <Layers className="h-3.5 w-3.5 text-violet-500" />;
    return <Square className="h-3.5 w-3.5 text-emerald-500" />;
  };

  const getItemLabel = (item) => {
    if (item.type === "group") return `群組 ${item.id}`;
    if (item.type === "text") return item.data?.text || `文字 ${item.id}`;
    if (item.type === "photo") return `照片格 ${item.id}`;
    return item.data?.filename || `貼圖 ${item.id}`;
  };

  return (
    <div className="rounded-lg border border-indigo-200 bg-white p-4 space-y-3" data-guide="group-selection-panel">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 rounded bg-indigo-50 p-1.5 text-indigo-600">
          <GroupIcon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">已選取 {items.length} 個物件</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            群組只建立關係，不會移動或縮放目前物件。
          </p>
        </div>
      </div>

      <div className="space-y-1">
        {items.map(item => (
          <div key={`${item.type}-${item.id}`} className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-700">
            {getItemIcon(item.type)}
            <span className="truncate">{getItemLabel(item)}</span>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onGroup?.()}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          建立群組
        </button>
        {isMaterialTextPair && !materialActionsDisabled && (
          <button
            type="button"
            onClick={() => onLinkMaterialText?.()}
            className="w-full rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
          >
            符合素材並連結文字框
          </button>
        )}
      </div>
    </div>
  );
}
