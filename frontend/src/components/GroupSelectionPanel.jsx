import {
  Group as GroupIcon,
  Image as ImageIcon,
  Layers,
  Square,
  Type as TypeIcon,
} from "lucide-react";

import { FONT_OPTIONS } from "../constants/fonts";

const MIXED_VALUE = Symbol("mixed-value");

const ALIGNMENT_OPTIONS = [
  { value: "left", label: "靠左" },
  { value: "center", label: "水平置中" },
  { value: "right", label: "靠右" },
  { value: "top", label: "靠上" },
  { value: "middle", label: "垂直置中" },
  { value: "bottom", label: "靠下" },
];

function getCommonValue(items, getValue) {
  const firstValue = getValue(items[0]?.data ?? {});
  return items.every(item => Object.is(getValue(item.data ?? {}), firstValue))
    ? firstValue
    : MIXED_VALUE;
}

function BatchSelect({ label, propertyKey, value, options, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <select
        value={value === MIXED_VALUE ? "" : value}
        onChange={event => onChange?.({ [propertyKey]: event.target.value })}
        disabled={!onChange}
        className="rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 disabled:bg-gray-50 disabled:text-gray-400"
      >
        {value === MIXED_VALUE && <option value="" disabled>混合</option>}
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function BatchNumberInput({ label, propertyKey, value, min, max, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value === MIXED_VALUE ? "" : value}
        placeholder={value === MIXED_VALUE ? "混合" : undefined}
        onChange={event => {
          if (event.target.value !== "") onChange?.({ [propertyKey]: Number(event.target.value) });
        }}
        disabled={!onChange}
        className="rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 disabled:bg-gray-50 disabled:text-gray-400"
      />
    </label>
  );
}

function BatchBooleanSelect({ label, propertyKey, value, trueLabel, falseLabel, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <select
        value={value === MIXED_VALUE ? "" : String(value)}
        onChange={event => onChange?.({ [propertyKey]: event.target.value === "true" })}
        disabled={!onChange}
        className="rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 disabled:bg-gray-50 disabled:text-gray-400"
      >
        {value === MIXED_VALUE && <option value="" disabled>混合</option>}
        <option value="true">{trueLabel}</option>
        <option value="false">{falseLabel}</option>
      </select>
    </label>
  );
}

function BatchColorInput({ value, onChange }) {
  const isMixed = value === MIXED_VALUE;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">文字顏色</span>
      <span className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1">
        <input
          type="color"
          value={isMixed ? "#333333" : value}
          onChange={event => onChange?.({ font_color: event.target.value })}
          disabled={!onChange}
          aria-label="批次設定文字顏色"
          className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0 disabled:cursor-not-allowed"
        />
        <span className="truncate text-xs text-gray-500">{isMixed ? "混合" : value}</span>
      </span>
    </label>
  );
}

function FavoriteStyleControls({ favoriteStyles, onSaveFavoriteStyle, onApplyFavoriteStyle }) {
  const visibleStyles = favoriteStyles.slice(0, 6);
  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600">常用樣式</span>
        <button
          type="button"
          onClick={() => onSaveFavoriteStyle?.()}
          disabled={!onSaveFavoriteStyle}
          className="rounded border border-indigo-200 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
        >
          儲存目前樣式
        </button>
      </div>
      {visibleStyles.length > 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          {visibleStyles.map((style, index) => (
            <button
              key={`${style.id ?? style.name ?? "favorite"}-${index}`}
              type="button"
              onClick={() => onApplyFavoriteStyle?.(style)}
              disabled={!onApplyFavoriteStyle}
              title={`套用${style.name || style.label || `常用樣式 ${index + 1}`}`}
              className="truncate rounded border border-gray-200 bg-white px-2 py-1.5 text-left text-xs text-gray-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
            >
              {style.name || style.label || `常用樣式 ${index + 1}`}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">尚未儲存常用樣式</p>
      )}
    </div>
  );
}

function TextBatchStyleControls({ items, onBatchPropertyChange }) {
  const fontFamily = getCommonValue(items, data => data.font_family ?? "msjh");
  const fontSize = getCommonValue(items, data => data.font_size ?? 28);
  const fontColor = getCommonValue(items, data => data.font_color ?? "#333333");
  const textAlign = getCommonValue(items, data => data.text_align ?? "center");

  return (
    <div className="grid grid-cols-2 gap-2">
      <BatchSelect
        label="字體"
        propertyKey="font_family"
        value={fontFamily}
        options={FONT_OPTIONS}
        onChange={onBatchPropertyChange}
      />
      <BatchNumberInput
        label="字級（pt）"
        propertyKey="font_size"
        value={fontSize}
        min={10}
        max={96}
        onChange={onBatchPropertyChange}
      />
      <BatchColorInput value={fontColor} onChange={onBatchPropertyChange} />
      <BatchSelect
        label="文字對齊"
        propertyKey="text_align"
        value={textAlign}
        options={[
          { value: "left", label: "靠左" },
          { value: "center", label: "置中" },
          { value: "right", label: "靠右" },
        ]}
        onChange={onBatchPropertyChange}
      />
    </div>
  );
}

function PhotoBatchStyleControls({ items, onBatchPropertyChange }) {
  const border = getCommonValue(items, data => data.border ?? true);
  const borderWidth = getCommonValue(items, data => data.border_width ?? 8);
  const borderRadius = getCommonValue(items, data => data.border_radius ?? 0);
  const shadowEnabled = getCommonValue(items, data => data.shadow_enabled ?? (data.border !== false));

  return (
    <div className="grid grid-cols-2 gap-2">
      <BatchBooleanSelect
        label="白色外框"
        propertyKey="border"
        value={border}
        trueLabel="顯示"
        falseLabel="關閉"
        onChange={onBatchPropertyChange}
      />
      <BatchNumberInput
        label="外框寬度"
        propertyKey="border_width"
        value={borderWidth}
        min={0}
        onChange={onBatchPropertyChange}
      />
      <BatchNumberInput
        label="圓角半徑"
        propertyKey="border_radius"
        value={borderRadius}
        min={0}
        onChange={onBatchPropertyChange}
      />
      <BatchBooleanSelect
        label="陰影"
        propertyKey="shadow_enabled"
        value={shadowEnabled}
        trueLabel="開啟"
        falseLabel="關閉"
        onChange={onBatchPropertyChange}
      />
    </div>
  );
}

export default function GroupSelectionPanel({
  items,
  onGroup,
  onLinkMaterialText,
  materialActionsDisabled = false,
  onAlign,
  onDistribute,
  onMatchSize,
  canMatchSize = false,
  onBatchPropertyChange,
  onPropertyCommit,
  onSaveFavoriteStyle,
  favoriteStyles = [],
  onApplyFavoriteStyle,
}) {
  const isMaterialTextPair = items.length === 2
    && items.some(item => item.type === "sticker")
    && items.some(item => item.type === "text");
  const selectedType = items[0]?.type;
  const hasSingleType = items.length > 0 && items.every(item => item.type === selectedType);
  const hasBatchStyle = hasSingleType && (selectedType === "text" || selectedType === "photo");
  const canDistribute = items.length >= 3 && Boolean(onDistribute);

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
    <div
      className="space-y-3 rounded-lg border border-indigo-200 bg-white p-4"
      data-guide="group-selection-panel"
      onBlurCapture={() => onPropertyCommit?.()}
      onPointerUpCapture={() => onPropertyCommit?.()}
      onClickCapture={(event) => {
        if (event.target.closest?.("button")) queueMicrotask(() => onPropertyCommit?.());
      }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 rounded bg-indigo-50 p-1.5 text-indigo-600">
          <GroupIcon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">已選取 {items.length} 個物件</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            建立群組只新增關係；對齊與分布會移動目前物件。
          </p>
        </div>
      </div>

      <div className="max-h-32 space-y-1 overflow-y-auto">
        {items.map(item => (
          <div key={`${item.type}-${item.id}`} className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-700">
            {getItemIcon(item.type)}
            <span className="truncate">{getItemLabel(item)}</span>
          </div>
        ))}
      </div>

      <section className="space-y-2 rounded-lg border border-gray-200 bg-gray-50/60 p-3" data-guide="multi-selection-layout">
        <h4 className="text-xs font-semibold text-gray-700">對齊與分布</h4>
        <div className="grid grid-cols-3 gap-1.5">
          {ALIGNMENT_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => onAlign?.(option.value)}
              disabled={!onAlign}
              title={`將已選物件${option.label}`}
              className="rounded border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => onDistribute?.("horizontal")}
            disabled={!canDistribute}
            title={items.length < 3 ? "至少選取 3 個物件" : "水平平均分布"}
            className="rounded border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
          >
            水平分布
          </button>
          <button
            type="button"
            onClick={() => onDistribute?.("vertical")}
            disabled={!canDistribute}
            title={items.length < 3 ? "至少選取 3 個物件" : "垂直平均分布"}
            className="rounded border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
          >
            垂直分布
          </button>
          <button
            type="button"
            onClick={() => onMatchSize?.()}
            disabled={!canMatchSize || !onMatchSize}
            title={canMatchSize ? "比照主要選取物件的尺寸" : "目前選取無法統一尺寸"}
            className="rounded border border-gray-200 bg-white px-1.5 py-1.5 text-xs text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
          >
            等大
          </button>
        </div>
        {items.length < 3 && <p className="text-[11px] text-gray-400">平均分布需選取至少 3 個物件。</p>}
      </section>

      {hasBatchStyle && (
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-3" data-guide="multi-selection-style">
          <h4 className="text-xs font-semibold text-gray-700">
            {selectedType === "text" ? "批次文字樣式" : "批次照片樣式"}
          </h4>
          {selectedType === "text" ? (
            <TextBatchStyleControls items={items} onBatchPropertyChange={onBatchPropertyChange} />
          ) : (
            <PhotoBatchStyleControls items={items} onBatchPropertyChange={onBatchPropertyChange} />
          )}
          <FavoriteStyleControls
            favoriteStyles={favoriteStyles}
            onSaveFavoriteStyle={onSaveFavoriteStyle}
            onApplyFavoriteStyle={onApplyFavoriteStyle}
          />
        </section>
      )}

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
