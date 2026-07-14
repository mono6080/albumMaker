import { Group as GroupIcon, Image as ImageIcon, Type as TypeIcon } from "lucide-react";

export default function GroupSelectionPanel({ items, onGroup }) {
  const textCount = items.filter(item => item.type === "text").length;
  const stickerCount = items.filter(item => item.type === "sticker").length;
  const isMaterialTextPair = items.length === 2 && textCount === 1 && stickerCount === 1;

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
            {item.type === "text"
              ? <TypeIcon className="h-3.5 w-3.5 text-indigo-500" />
              : <ImageIcon className="h-3.5 w-3.5 text-emerald-500" />}
            <span className="truncate">
              {item.type === "text" ? item.data?.text || `文字 ${item.id}` : item.data?.filename || `圖片 ${item.id}`}
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onGroup?.({ linkMaterialText: false })}
          className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          建立群組
        </button>
        {isMaterialTextPair && (
          <button
            type="button"
            onClick={() => onGroup?.({ linkMaterialText: true })}
            className="w-full rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
          >
            群組並連結文字＋圖片
          </button>
        )}
      </div>
    </div>
  );
}
