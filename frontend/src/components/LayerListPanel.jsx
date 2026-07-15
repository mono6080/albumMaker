// 模板編輯器右側圖層面板：頁面統計、圖層選取與圖層管理
// 從 TemplateEditor 抽出；所有版面變更仍透過 callback 交由父層提交

import { useEffect, useId, useRef, useState } from "react";
import { closestCenter, DndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import {
  ChevronLeft,
  Eye,
  EyeOff,
  GripVertical,
  Group as GroupIcon,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  Pencil,
  Square,
  Type as TypeIcon,
} from "lucide-react";

import { getPhotoContentRect } from "../utils/photoFrameGeometry.js";
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

function getLayerKey(layerRef) {
  return `${layerRef.type}:${String(layerRef.id)}`;
}

function LayerRow({
  layerRef,
  defaultTitle,
  description,
  meta,
  layerName,
  isVisible,
  isLocked,
  visibilityInherited = false,
  lockInherited = false,
  isSelected,
  onSelect,
  onDoubleClick,
  onRenameLayer,
  onToggleVisibility,
  onToggleLock,
  canReorder,
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const titleId = useId();
  const layerKey = getLayerKey(layerRef);
  const normalizedLayerName = String(layerName ?? "").trim();
  const title = normalizedLayerName || defaultTitle;
  const Icon = meta.Icon;
  const {
    attributes,
    listeners,
    setNodeRef: setDragNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({
    id: layerKey,
    data: { layerRef },
    disabled: !canReorder,
  });
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({
    id: layerKey,
    data: { layerRef },
    disabled: !canReorder,
  });

  const handleStartRename = () => {
    setRenameValue(normalizedLayerName);
    setIsRenaming(true);
  };

  const handleCommitRename = () => {
    const nextName = renameValue.trim();
    setIsRenaming(false);
    if (nextName !== normalizedLayerName) onRenameLayer?.(layerRef, nextName);
  };

  return (
    <div
      ref={(node) => {
        setDragNodeRef(node);
        setDropNodeRef(node);
      }}
      className={`group/layer flex w-full min-w-0 items-center gap-1 rounded-lg border px-1.5 py-2 transition-colors ${
        isSelected
          ? "border-indigo-400 bg-indigo-50"
          : isOver
            ? "border-indigo-400 bg-indigo-50/70"
            : "border-gray-200 hover:border-indigo-200 hover:bg-indigo-50/40"
      } ${isDragging ? "opacity-40" : ""}`}
      data-layer-ref={layerKey}
    >
      <span id={titleId} className="sr-only">{title}</span>
      {canReorder && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="拖曳重新排序圖層"
          title={`拖曳調整「${title}」的圖層順序`}
          className="flex h-11 w-11 flex-shrink-0 cursor-grab items-center justify-center rounded text-gray-300 hover:bg-white hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 active:cursor-grabbing lg:h-7 lg:w-6"
          style={{ touchAction: "none" }}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}

      {isRenaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
            <Icon className="h-4 w-4" />
          </span>
          <input
            type="text"
            value={renameValue}
            onChange={event => setRenameValue(event.target.value)}
            onBlur={handleCommitRename}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleCommitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setIsRenaming(false);
              }
            }}
            placeholder={defaultTitle}
            aria-label={`重新命名「${title}」`}
            className="min-h-11 min-w-0 flex-1 rounded border border-indigo-300 bg-white px-2 py-1 text-sm text-gray-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 lg:min-h-0"
            autoFocus
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={onDoubleClick}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:min-h-0"
        >
          <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm font-medium ${isVisible ? "text-gray-800" : "text-gray-400 line-through"}`}>
              {title}
            </span>
            <span className="block truncate text-xs text-gray-400">{description}</span>
          </span>
        </button>
      )}

      <div className="flex flex-shrink-0 items-center gap-0.5">
        {onRenameLayer && !isRenaming && (
          <button
            type="button"
            onClick={handleStartRename}
            aria-label="重新命名圖層"
            aria-describedby={titleId}
            title={`重新命名「${title}」`}
            className="flex h-11 w-11 items-center justify-center rounded text-gray-400 hover:bg-white hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:h-7 lg:w-7"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {onToggleVisibility && (
          <button
            type="button"
            onClick={() => !visibilityInherited && onToggleVisibility(layerRef)}
            disabled={visibilityInherited}
            aria-label={visibilityInherited ? "圖層由上層群組隱藏" : isVisible ? "隱藏圖層" : "顯示圖層"}
            aria-describedby={titleId}
            title={visibilityInherited ? "請先顯示上層群組" : `${isVisible ? "隱藏" : "顯示"}「${title}」`}
            className={`flex h-11 w-11 items-center justify-center rounded hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed lg:h-7 lg:w-7 ${
              isVisible ? "text-gray-400 hover:text-indigo-600" : "text-gray-300 hover:text-indigo-600"
            }`}
          >
            {isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        )}
        {onToggleLock && (
          <button
            type="button"
            onClick={() => !lockInherited && onToggleLock(layerRef)}
            disabled={lockInherited}
            aria-label={lockInherited ? "圖層由上層群組鎖定" : isLocked ? "解除鎖定圖層" : "鎖定圖層"}
            aria-describedby={titleId}
            title={lockInherited ? "請先解除上層群組鎖定" : `${isLocked ? "解除鎖定" : "鎖定"}「${title}」`}
            className={`flex h-11 w-11 items-center justify-center rounded hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed lg:h-7 lg:w-7 ${
              isLocked ? "bg-amber-50 text-amber-600" : "text-gray-400 hover:text-indigo-600"
            }`}
          >
            {isLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

export default function LayerListPanel({
  editorLayoutModel,
  currentPageIndex,
  photoSlotDimensionMode,
  backgroundUrl,
  onSelectElement,
  rootRenderNodes = [],
  scopeRenderNodes = null,
  isolationGroup = null,
  isolationTrail = [],
  selectedRefs = [],
  onSelectGroup,
  onEnterGroup,
  onExitGroup,
  onNavigateIsolation,
  onRenameLayer,
  onToggleVisibility,
  onToggleLock,
  onReorderLayer,
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
  const rootItems = rootRenderNodes;
  const layerPanelItems = scopeRenderNodes
    ? [...scopeRenderNodes].reverse()
    : isolationGroup
      ? [...(isolationGroup.children || [])].reverse()
      : [...rootItems].reverse();
  const pageElementCounts = editorLayoutModel.elementCounts;
  const visiblePhotoOrdinals = editorLayoutModel.getVisibleElementOrdinals("photo");
  const hasIsolation = isolationTrail.length > 0 || !!isolationGroup;

  const getElementOrdinal = (type, elementId) => {
    if (type === "photo") return visiblePhotoOrdinals.get(String(elementId)) ?? null;
    return editorLayoutModel.getCollectionElementOrdinal(type, elementId);
  };

  const getLayerTitle = ({ type, data }) => {
    const ordinal = getElementOrdinal(type, data.id);
    if (type === "photo") return ordinal ? `照片格 P${currentPageIndex + 1}·${ordinal}` : `照片格 ${data.id}`;
    if (type === "text") return truncatePreviewText(data.text, ordinal ? `純文字 ${ordinal}` : "純文字");
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
    if (type === "sticker") {
      return `${Math.round(data.width ?? 0)} x ${Math.round(data.height ?? 0)} px`;
    }
    return "";
  };

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const activeRef = active.data.current?.layerRef;
    const overRef = over.data.current?.layerRef;
    if (activeRef && overRef) onReorderLayer?.(activeRef, overRef);
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

        <div className="grid grid-cols-3 gap-2">
          {[
            ["photo", pageElementCounts.photo],
            ["text", pageElementCounts.text],
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
              className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-semibold text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:min-h-0 lg:rounded-none lg:px-0"
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
            <button
              type="button"
              onClick={() => onNavigateIsolation?.(-1)}
              className="inline-flex min-h-11 items-center rounded px-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:min-h-0 lg:rounded-none lg:px-0"
            >
              圖層
            </button>
            {(isolationTrail.length ? isolationTrail : [{ id: isolationGroup?.id, label: "群組 1" }]).map((trailItem, index) => (
              <span key={`layer-trail-${trailItem.id}`} className="inline-flex items-center gap-1">
                <span aria-hidden="true">›</span>
                <button
                  type="button"
                  onClick={() => onNavigateIsolation?.(index)}
                  aria-current={index === isolationTrail.length - 1 ? "location" : undefined}
                  className="inline-flex min-h-11 items-center rounded px-2 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 lg:min-h-0 lg:rounded-none lg:px-0"
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
          <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="space-y-2">
              {layerPanelItems.map((item) => {
                if (item.kind === "group" || item.type === "group") {
                  const groupData = item.data ?? item;
                  const childCount = item.children?.length ?? groupData.children?.length ?? 0;
                  const layerRef = { type: "group", id: item.id };
                  const layerState = editorLayoutModel.getNodeLayerState(layerRef);
                  return (
                    <LayerRow
                      key={`group-${item.id}`}
                      layerRef={layerRef}
                      defaultTitle="物件群組"
                      description={`${childCount} 個子物件 · 雙擊進入`}
                      meta={ELEMENT_TYPE_META.group}
                      layerName={groupData.layer_name}
                      isVisible={layerState.isVisible}
                      isLocked={layerState.isLocked}
                      visibilityInherited={groupData.visible !== false && !layerState.isVisible}
                      lockInherited={groupData.locked !== true && layerState.isLocked}
                      isSelected={selectedKeys.has(`group-${item.id}`)}
                      onSelect={event => handleGroupClick(item.id, { additive: event.shiftKey })}
                      onDoubleClick={() => handleGroupDoubleClick(item.id)}
                      onRenameLayer={onRenameLayer}
                      onToggleVisibility={onToggleVisibility}
                      onToggleLock={onToggleLock}
                      canReorder={Boolean(onReorderLayer) && !layerState.isLocked}
                    />
                  );
                }

                const { type, data } = item;
                const layerRef = { type, id: data.id };
                const layerState = editorLayoutModel.getNodeLayerState(layerRef);
                return (
                  <LayerRow
                    key={`${type}-${data.id}`}
                    layerRef={layerRef}
                    defaultTitle={getLayerTitle({ type, data })}
                    description={getLayerDescription({ type, data })}
                    meta={ELEMENT_TYPE_META[type] ?? ELEMENT_TYPE_META.text}
                    layerName={data.layer_name}
                    isVisible={layerState.isVisible}
                    isLocked={layerState.isLocked}
                    visibilityInherited={data.visible !== false && !layerState.isVisible}
                    lockInherited={data.locked !== true && layerState.isLocked}
                    isSelected={selectedKeys.has(`${type}-${data.id}`)}
                    onSelect={event => onSelectElement(type, data.id, { additive: event.shiftKey })}
                    onRenameLayer={onRenameLayer}
                    onToggleVisibility={onToggleVisibility}
                    onToggleLock={onToggleLock}
                    canReorder={Boolean(onReorderLayer) && !layerState.isLocked}
                  />
                );
              })}
            </div>
          </DndContext>
        )}
      </div>
    </div>
  );
}
