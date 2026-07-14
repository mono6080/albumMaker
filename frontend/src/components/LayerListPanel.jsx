// 模板編輯器右側閒置面板：目前頁面統計 + 圖層清單（純顯示）
// 從 TemplateEditor 抽出；點擊圖層以 onSelectElement 回呼選取元素

import { useEffect, useRef } from "react";
import {
  ChevronLeft,
  Group as GroupIcon,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Square,
  Type as TypeIcon,
} from "lucide-react";

import { getPhotoContentRect } from "../utils/photoFrameGeometry.js";
import { ELEMENT_ARRAY_KEY } from "../utils/renderLayoutModel";
import { isFillableTextLabel } from "../utils/textLabelRoles";

const ELEMENT_TYPE_META = {
  photo: {
    label: "照片格",
    Icon: ImageIcon,
    className: "bg-amber-50 text-amber-600",
  },
  text: {
    label: "純文字",
    Icon: TypeIcon,
    className: "bg-indigo-50 text-indigo-600",
  },
  bubble: {
    label: "氣泡框",
    Icon: MessageSquare,
    className: "bg-rose-50 text-rose-600",
  },
  sticker: {
    label: "貼圖",
    Icon: Square,
    className: "bg-emerald-50 text-emerald-600",
  },
  group: {
    label: "群組",
    Icon: GroupIcon,
    className: "bg-violet-50 text-violet-600",
  },
};

function truncatePreviewText(value, fallback = "未設定文字") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized;
}

export default function LayerListPanel({
  pageLayout,
  sortedPageElements,
  currentPageIndex,
  photoSlotDimensionMode,
  backgroundUrl,
  onSelectElement,
  rootRenderNodes = null,
  scopeRenderNodes = null,
  isolationGroup = null,
  isolationTrail = [],
  selectedRefs = [],
  onSelectGroup,
  onEnterGroup,
  onExitGroup,
  onNavigateIsolation,
}) {
  const groupClickTimerRef = useRef(null);

  useEffect(() => () => {
    if (groupClickTimerRef.current) window.clearTimeout(groupClickTimerRef.current);
  }, []);

  const handleGroupClick = (groupId, options = {}) => {
    if (groupClickTimerRef.current) window.clearTimeout(groupClickTimerRef.current);
    groupClickTimerRef.current = window.setTimeout(() => {
      groupClickTimerRef.current = null;
      onSelectGroup?.(groupId, options);
    }, 220);
  };

  const handleGroupDoubleClick = (groupId) => {
    if (groupClickTimerRef.current) {
      window.clearTimeout(groupClickTimerRef.current);
      groupClickTimerRef.current = null;
    }
    onEnterGroup?.(groupId);
  };

  const selectedKeys = new Set(selectedRefs.map(ref => `${ref.type}-${ref.id}`));
  const rootItems = rootRenderNodes ?? sortedPageElements.map(item => ({
    kind: "element",
    type: item.type,
    id: item.data.id,
    data: item.data,
    index: item.index,
  }));
  const layerPanelItems = scopeRenderNodes
    ? [...scopeRenderNodes].reverse()
    : isolationGroup
      ? [...(isolationGroup.children || [])].reverse()
      : [...rootItems].reverse();
  const pageElementCounts = {
    photo: pageLayout?.photo_slots?.length ?? 0,
    text: pageLayout?.text_labels?.length ?? 0,
    bubble: pageLayout?.text_bubbles?.length ?? 0,
    sticker: pageLayout?.stickers?.length ?? 0,
  };
  const hasIsolation = isolationTrail.length > 0 || !!isolationGroup;

  const getElementOrdinal = (type, elementId) => {
    const arrayKey = ELEMENT_ARRAY_KEY[type];
    const source = pageLayout?.[arrayKey] || [];
    const index = source.findIndex(element => element.id === elementId);
    return index >= 0 ? index + 1 : null;
  };

  const getLayerTitle = ({ type, data }) => {
    const ordinal = getElementOrdinal(type, data.id);
    if (type === "photo") return ordinal ? `照片格 P${currentPageIndex + 1}·${ordinal}` : `照片格 ${data.id}`;
    if (type === "text") return truncatePreviewText(data.text, ordinal ? `純文字 ${ordinal}` : "純文字");
    if (type === "bubble") return truncatePreviewText(data.text, ordinal ? `氣泡框 ${ordinal}` : "氣泡框");
    if (type === "sticker") return data.filename || (ordinal ? `貼圖 ${ordinal}` : "貼圖");
    return `元素 ${data.id}`;
  };

  const getLayerDescription = ({ type, data }) => {
    if (type === "photo") {
      const contentRect = getPhotoContentRect(data, { dimensionMode: photoSlotDimensionMode });
      return `${Math.round(contentRect.width)} x ${Math.round(contentRect.height)} px`;
    }
    if (type === "text") {
      return isFillableTextLabel(data) ? "老師可填文字" : "固定文字";
    }
    if (type === "bubble") {
      return data.shape ? `形狀：${data.shape}` : "文字氣泡";
    }
    if (type === "sticker") {
      return `${Math.round(data.width ?? 0)} x ${Math.round(data.height ?? 0)} px`;
    }
    return "";
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Layers className="h-4 w-4 flex-shrink-0 text-indigo-500" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-800">目前頁面</h2>
              <p className="mt-0.5 text-xs text-gray-400">
                 第 {currentPageIndex + 1} 頁 · {rootItems.length} 個根圖層
              </p>
            </div>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${backgroundUrl ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {backgroundUrl ? "已有背景" : "待上傳背景"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[
            ["photo", pageElementCounts.photo],
            ["text", pageElementCounts.text],
            ["bubble", pageElementCounts.bubble],
            ["sticker", pageElementCounts.sticker],
          ].map(([type, count]) => {
            const meta = ELEMENT_TYPE_META[type];
            const Icon = meta.Icon;
            return (
              <div key={type} className="rounded-lg bg-gray-50 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs text-gray-500">
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-gray-900">{count}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          {hasIsolation ? (
            <button
              type="button"
              onClick={onExitGroup}
              className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-700 hover:underline"
            >
              <ChevronLeft className="h-4 w-4" />
              離開群組
            </button>
          ) : (
            <h3 className="text-sm font-semibold text-gray-800">圖層清單</h3>
          )}
          <span className="text-xs text-gray-400">上方為最上層</span>
        </div>

        {hasIsolation && (
          <div className="mb-3 flex flex-wrap items-center gap-1 rounded bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700" data-guide="isolation-breadcrumb">
            <button type="button" onClick={() => onNavigateIsolation?.(-1)} className="font-medium hover:underline">
              圖層
            </button>
            {(isolationTrail.length ? isolationTrail : [{ id: isolationGroup?.id, label: "群組 1" }]).map((trailItem, index) => (
              <span key={`layer-trail-${trailItem.id}`} className="inline-flex items-center gap-1">
                <span aria-hidden="true">›</span>
                <button
                  type="button"
                  onClick={() => onNavigateIsolation?.(index)}
                  aria-current={index === isolationTrail.length - 1 ? "location" : undefined}
                  className="font-medium hover:underline"
                >
                  {trailItem.label || `群組 ${index + 1}`}
                </button>
              </span>
            ))}
          </div>
        )}

        {layerPanelItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-400">
            尚未放置元素
          </div>
        ) : (
          <div className="space-y-2">
            {layerPanelItems.map((item) => {
              if (item.kind === "group" || item.type === "group") {
                const groupData = item.data ?? item;
                const childCount = item.children?.length ?? groupData.children?.length ?? 0;
                const groupTitle = "物件群組";
                const meta = ELEMENT_TYPE_META.group;
                const Icon = meta.Icon;
                return (
                  <button
                    key={`group-${item.id}`}
                    type="button"
                    onClick={event => handleGroupClick(item.id, { additive: event.shiftKey })}
                    onDoubleClick={() => handleGroupDoubleClick(item.id)}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedKeys.has(`group-${item.id}`)
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-200 hover:border-indigo-200 hover:bg-indigo-50/40"
                    }`}
                  >
                    <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-800">{groupTitle}</span>
                      <span className="block truncate text-xs text-gray-400">{childCount} 個子物件 · 雙擊進入</span>
                    </span>
                  </button>
                );
              }

              const { type, data } = item;
              const meta = ELEMENT_TYPE_META[type] ?? ELEMENT_TYPE_META.text;
              const Icon = meta.Icon;
              return (
                <button
                  key={`${type}-${data.id}`}
                  type="button"
                  onClick={event => onSelectElement(type, data.id, { additive: event.shiftKey })}
                  className={`flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedKeys.has(`${type}-${data.id}`)
                      ? "border-indigo-400 bg-indigo-50"
                      : "border-gray-200 hover:border-indigo-200 hover:bg-indigo-50/40"
                  }`}
                >
                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-800">{getLayerTitle({ type, data })}</span>
                    <span className="block truncate text-xs text-gray-400">{getLayerDescription({ type, data })}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
