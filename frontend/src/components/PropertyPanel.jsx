// PropertyPanel — 模板編輯器右側屬性面板
// 依選取元素類型（照片格 / 純文字 / 貼圖）顯示對應屬性控制項

import { useId, useMemo, useRef, useState } from "react";
import Konva from "konva";

import ColorPicker from "./ColorPicker";
import CompositionTextarea from "./CompositionTextarea";
import { FONT_OPTIONS } from "../constants/fonts";
import { MAX_LABEL_TEXT_LENGTH } from "../constants/textContent.js";
import {
  FULL_NAME_VARIABLE,
  NAME_VARIABLE,
  STUDENT_NAME_VARIABLES,
  insertTextToken,
} from "../utils/textVariables";
import { TEXT_LABEL_ROLES, getTextLabelRole } from "../utils/textLabelRoles";
import { snapPhotoSlotStandardRatio } from "../utils/photoFrameGeometry.js";
import { measureTextLabelCjkCapacity } from "../utils/textRenderModel.js";

function InspectorSection({ title, children, defaultOpen = true, dataGuide, className = "" }) {
  const contentId = useId();
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className={`overflow-hidden rounded-lg border border-gray-200 bg-white ${className}`} data-guide={dataGuide}>
      <h4>
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={contentId}
          onClick={() => setIsOpen(currentValue => !currentValue)}
          className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        >
          <span>{title}</span>
          <span aria-hidden="true" className="text-base leading-none text-gray-400">
            {isOpen ? "−" : "+"}
          </span>
        </button>
      </h4>
      <div id={contentId} hidden={!isOpen} className="space-y-3 border-t border-gray-100 p-3">
        {children}
      </div>
    </section>
  );
}

function PropertyCommitBoundary({ onPropertyCommit, children }) {
  const handleClickCapture = (event) => {
    if (!onPropertyCommit || !event.target.closest?.("button")) return;
    queueMicrotask(onPropertyCommit);
  };

  return (
    <div
      onBlurCapture={() => onPropertyCommit?.()}
      onPointerUpCapture={() => onPropertyCommit?.()}
      onClickCapture={handleClickCapture}
    >
      {children}
    </div>
  );
}

function LockedPropertyNotice() {
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"
    >
      此物件已鎖定。解除鎖定後才能修改屬性。
    </div>
  );
}

// 滑桿 + 數字輸入的組合控制項
function SliderInput({ label, min, max, step = 1, value, onChange, numWidth = "w-14" }) {
  return (
    <div className="flex items-center gap-2">
      <input aria-label={`${label}滑桿`} type="range" min={min} max={max} step={step} value={value} onChange={onChange} className="h-11 flex-1" />
      <input aria-label={`${label}數值`} type="number" min={min} max={max} step={step} value={value} onChange={onChange} className={`min-h-11 rounded border px-1 py-1 text-center text-sm ${numWidth}`} />
    </div>
  );
}

// 字體選擇器格狀按鈕
function FontPicker({ value, onChange, guideId, recentFonts = [] }) {
  const recentFontValues = new Set(recentFonts.map(fontValue => String(fontValue).trim()));
  const renderFontButton = (fontOption) => {
    const isRecent = recentFontValues.has(fontOption.value);
    return (
    <button
      key={fontOption.value}
      type="button"
      onClick={() => onChange(fontOption.value)}
      aria-label={fontOption.label}
      aria-pressed={value === fontOption.value}
      title={isRecent ? `${fontOption.label}（最近使用）` : fontOption.label}
      style={{ fontFamily: fontOption.css, fontWeight: fontOption.bold ? "bold" : "normal" }}
      className={`flex min-h-11 min-w-0 items-center gap-1 rounded border px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
        value === fontOption.value
          ? "border-indigo-500 bg-indigo-50 text-indigo-700"
          : "border-gray-200 text-gray-700 hover:border-gray-300"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{fontOption.label}</span>
      {isRecent && (
        <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-400" />
      )}
    </button>
    );
  };

  return (
    <div className="grid grid-cols-2 gap-1.5" data-guide={guideId}>
      {FONT_OPTIONS.map(fontOption => renderFontButton(fontOption))}
    </div>
  );
}

function VariableTextarea({ label, value, rows = 3, onChange, guideId }) {
  const textareaId = useId();
  const textareaRef = useRef(null);

  const handleInsertVariable = (token) => {
    const textarea = textareaRef.current;
    const next = insertTextToken(
      textarea?.value ?? value ?? "",
      textarea?.selectionStart,
      textarea?.selectionEnd,
      token,
    );
    onChange(next.text.slice(0, MAX_LABEL_TEXT_LENGTH));
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="flex flex-col gap-1" data-guide={guideId}>
      <label htmlFor={textareaId} className="text-xs text-gray-500">{label}</label>
      <div className="grid grid-cols-2 gap-1.5">
        {STUDENT_NAME_VARIABLES.map(variable => (
          <button
            key={variable.token}
            type="button"
            onClick={() => handleInsertVariable(variable.token)}
            data-guide={guideId
              ? `${guideId}-insert-${variable.token === NAME_VARIABLE ? "name" : "full-name"}`
              : undefined}
            title={variable.description}
            className="min-h-11 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100"
          >
            {variable.label} {variable.token}
          </button>
        ))}
      </div>
      <CompositionTextarea
        id={textareaId}
        ref={textareaRef}
        rows={rows}
        maxLength={MAX_LABEL_TEXT_LENGTH}
        value={value ?? ""}
        onChange={nextValue => onChange(nextValue.slice(0, MAX_LABEL_TEXT_LENGTH))}
        className="min-h-11 rounded border px-2 py-1 text-sm"
      />
    </div>
  );
}

function TextShadowControls({ elementData, onPropertyChange, recentColors }) {
  const enabled = !!(elementData.text_shadow_enabled ?? false);

  return (
    <div className="space-y-2" data-guide="text-shadow-controls">
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => onPropertyChange({ text_shadow_enabled: event.target.checked })}
          data-guide="text-shadow-toggle"
          className="h-5 w-5"
        />
        <span className="text-sm font-medium text-gray-700">文字陰影</span>
      </label>

      {enabled && (
        <div className="space-y-2 pl-1">
          <ColorPicker
            label="陰影顏色"
            value={elementData.text_shadow_color ?? "#000000"}
            recentColors={recentColors}
            onChange={colorValue => onPropertyChange({ text_shadow_color: colorValue })}
          />

          {[
            { key: "text_shadow_offset_x", label: "偏移 X", defaultValue: 3, min: -30, max: 30 },
            { key: "text_shadow_offset_y", label: "偏移 Y", defaultValue: 3, min: -30, max: 30 },
            { key: "text_shadow_blur",     label: "模糊",   defaultValue: 4, min: 0,   max: 40 },
          ].map(shadowField => (
            <div key={shadowField.key} className="flex flex-col gap-0.5">
              <span className="text-xs text-gray-500">{shadowField.label}</span>
              <SliderInput
                label={shadowField.label}
                min={shadowField.min}
                max={shadowField.max}
                value={elementData[shadowField.key] ?? shadowField.defaultValue}
                onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
              />
            </div>
          ))}

          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">不透明度（%）</span>
            <SliderInput
              label="不透明度"
              min={0}
              max={100}
              value={Math.round(((elementData.text_shadow_opacity ?? 120) / 255) * 100)}
              onChange={event => onPropertyChange({
                text_shadow_opacity: Math.round(Number(event.target.value) / 100 * 255),
              })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function IsolationBreadcrumb({ trail, onNavigate, tailLabel }) {
  if (!trail?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 rounded bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700" data-guide="isolation-breadcrumb">
      <button
        type="button"
        onClick={() => onNavigate?.(-1)}
        aria-label="回到根圖層"
        className="inline-flex min-h-11 items-center rounded px-1 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        圖層
      </button>
      {trail.map((trailItem, index) => (
        <span key={`property-trail-${trailItem.id}`} className="inline-flex items-center gap-1">
          <span aria-hidden="true">›</span>
          <button
            type="button"
            onClick={() => onNavigate?.(index)}
            aria-current={index === trail.length - 1 ? "location" : undefined}
            className="inline-flex min-h-11 items-center rounded px-1 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {trailItem.label || `群組 ${index + 1}`}
          </button>
        </span>
      ))}
      {tailLabel && <span aria-hidden="true">›</span>}
      {tailLabel && <span>{tailLabel}</span>}
    </div>
  );
}

function FavoriteStyleControls({
  elementType,
  elementData,
  favoriteStyles,
  onSaveFavoriteStyle,
  onApplyFavoriteStyle,
  onRemoveFavoriteStyle,
}) {
  const matchingStyles = favoriteStyles.filter(favoriteStyle => favoriteStyle?.type === elementType);

  return (
    <section
      className="space-y-2 rounded-lg border border-gray-200 bg-white p-3"
      data-guide="favorite-style-controls"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-gray-700">常用樣式</h4>
        <button
          type="button"
          onClick={() => onSaveFavoriteStyle?.(elementType, elementData)}
          disabled={!onSaveFavoriteStyle}
          className="min-h-11 rounded border border-indigo-200 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
        >
          儲存目前樣式
        </button>
      </div>

      {matchingStyles.length > 0 ? (
        <div className="space-y-1.5">
          {matchingStyles.map((favoriteStyle, index) => {
            const label = favoriteStyle.name || favoriteStyle.label || `常用樣式 ${index + 1}`;
            return (
              <div
                key={favoriteStyle.id ?? `${elementType}-favorite-${index}`}
                className="flex min-w-0 items-center overflow-hidden rounded border border-gray-200 bg-white"
              >
                <button
                  type="button"
                  onClick={() => onApplyFavoriteStyle?.(favoriteStyle)}
                  disabled={!onApplyFavoriteStyle}
                  title={`套用${label}`}
                  className="min-h-11 min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
                >
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveFavoriteStyle?.(favoriteStyle.id)}
                  disabled={!onRemoveFavoriteStyle}
                  aria-label={`刪除常用樣式 ${label}`}
                  className="flex h-11 w-11 flex-shrink-0 items-center justify-center border-l border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:text-gray-300"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-gray-400">尚未儲存常用樣式</p>
      )}
    </section>
  );
}

function GroupPropertyPanel({
  group,
  bounds,
  isLocked,
  isolationTrail,
  onNavigateIsolation,
  onLayerChange,
  onEnterGroup,
  onUngroup,
}) {
  return (
    <div className="space-y-3" data-guide="property-panel">
      <div className="px-1 py-1">
        <h3 className="font-semibold">物件群組</h3>
      </div>

      {isLocked && <LockedPropertyNotice />}

      <IsolationBreadcrumb
        trail={isolationTrail}
        onNavigate={onNavigateIsolation}
        tailLabel="子群組"
      />

      <p className="text-xs leading-relaxed text-gray-500">
        外層操作整組；雙擊畫布或進入群組後，可分別編輯每個子物件。
      </p>

      <button
        type="button"
        onClick={() => onEnterGroup?.(group?.id)}
        className="min-h-11 w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        進入群組
      </button>

      <div className="grid grid-cols-2 gap-2 rounded bg-gray-50 p-2 text-xs text-gray-600">
        <span>X {Math.round(bounds?.x ?? 0)}</span>
        <span>Y {Math.round(bounds?.y ?? 0)}</span>
        <span>寬 {Math.round(bounds?.width ?? 0)}</span>
        <span>高 {Math.round(bounds?.height ?? 0)}</span>
      </div>

      <fieldset disabled={isLocked} className="space-y-3 border-0 p-0 disabled:opacity-60">
        <InspectorSection title="圖層順序" defaultOpen={false} dataGuide="property-section-layer-order">
          <div className="flex gap-1">
            {[
              { dir: "bottom", label: "⬇ 最底" },
              { dir: "down", label: "↓ 下移" },
              { dir: "up", label: "↑ 上移" },
              { dir: "top", label: "⬆ 最頂" },
            ].map(({ dir, label }) => (
              <button
                key={dir}
                type="button"
                onClick={() => onLayerChange?.(dir)}
                className="min-h-11 flex-1 rounded border border-gray-200 px-1 py-1 text-xs hover:bg-gray-50"
              >
                {label}
              </button>
            ))}
          </div>
        </InspectorSection>

        <button
          type="button"
          onClick={() => onUngroup?.(group?.id)}
          className="min-h-11 w-full rounded border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
        >
          解除群組
        </button>
      </fieldset>
    </div>
  );
}

function LayerOrderSection({ onLayerChange }) {
  return (
    <InspectorSection
      title="圖層順序"
      defaultOpen={false}
      dataGuide="property-section-layer-order"
    >
      <div className="grid grid-cols-4 gap-1">
        {[
          { dir: "bottom", label: "⬇ 最底" },
          { dir: "down", label: "↓ 下移" },
          { dir: "up", label: "↑ 上移" },
          { dir: "top", label: "⬆ 最頂" },
        ].map(({ dir, label }) => (
          <button
            key={dir}
            type="button"
            onClick={() => onLayerChange(dir)}
            className="min-h-11 rounded border border-gray-200 px-1 py-1 text-xs hover:bg-gray-50"
          >
            {label}
          </button>
        ))}
      </div>
    </InspectorSection>
  );
}

function TransformSection({ isPhotoSlot, elementData, onPropertyChange }) {
  return (
    <InspectorSection
      title="位置與尺寸"
      defaultOpen={false}
      dataGuide="property-section-transform"
    >
      <div data-guide="property-position-size">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-gray-500">座標與大小</span>
          <button
            type="button"
            onClick={() => onPropertyChange({
              width: elementData.height ?? 0,
              height: elementData.width ?? 0,
            })}
            data-guide="flip-size"
            className="min-h-11 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            翻轉長寬
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { key: "x", label: isPhotoSlot ? "照片 X" : "X 位置" },
            { key: "y", label: isPhotoSlot ? "照片 Y" : "Y 位置" },
            { key: "width", label: isPhotoSlot ? "照片寬度" : "寬度" },
            { key: "height", label: isPhotoSlot ? "照片高度" : "高度" },
          ].map(field => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">{field.label}</span>
              <input
                type="number"
                value={elementData[field.key] ?? 0}
                onChange={event => {
                  const nextValue = Number(event.target.value);
                  const isSizeField = field.key === "width" || field.key === "height";
                  if (isPhotoSlot && isSizeField && nextValue > 0 && elementData.width > 0 && elementData.height > 0) {
                    const snapped = snapPhotoSlotStandardRatio(
                      elementData.width,
                      elementData.height,
                      field.key,
                      nextValue,
                    );
                    if (snapped) {
                      onPropertyChange(snapped);
                      return;
                    }
                    const aspectRatio = elementData.width / elementData.height;
                    onPropertyChange(field.key === "width"
                      ? { width: nextValue, height: Math.round(nextValue / aspectRatio) }
                      : { width: Math.round(nextValue * aspectRatio), height: nextValue });
                    return;
                  }
                  onPropertyChange({ [field.key]: nextValue });
                }}
                className="min-h-11 rounded border px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">旋轉角度（度）</span>
        <input
          type="number"
          step="0.5"
          value={elementData.rotation ?? 0}
          onChange={event => onPropertyChange({ rotation: Number(event.target.value) })}
          className="min-h-11 w-24 rounded border px-2 py-1 text-sm"
        />
      </label>
    </InspectorSection>
  );
}

function PhotoAppearanceSection({ elementData, onPropertyChange }) {
  return (
    <InspectorSection title="外觀" dataGuide="photo-appearance">
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={elementData.border ?? true}
          onChange={event => onPropertyChange({ border: event.target.checked })}
          className="h-5 w-5"
        />
        <span className="text-sm">白色外框（拍立得風格）</span>
      </label>

      {elementData.border !== false && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">外框寬度</span>
          <input
            type="number"
            value={elementData.border_width ?? 8}
            onChange={event => onPropertyChange({ border_width: Number(event.target.value) })}
            className="min-h-11 w-24 rounded border px-2 py-1 text-sm"
          />
        </label>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">圓角半徑（px）</span>
        <SliderInput
          label="圓角半徑"
          min={0}
          max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
          value={elementData.border_radius ?? 0}
          onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
        />
      </div>
    </InspectorSection>
  );
}

function PhotoEffectsSection({ elementData, onPropertyChange }) {
  const shadowEnabled = elementData.shadow_enabled ?? (elementData.border !== false);
  return (
    <InspectorSection
      title="陰影與效果"
      defaultOpen={false}
      dataGuide="property-section-effects"
    >
      <div className="space-y-2" data-guide="photo-visual-style">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={shadowEnabled}
            onChange={event => onPropertyChange({ shadow_enabled: event.target.checked })}
            className="h-5 w-5"
          />
          <span className="text-sm font-medium text-gray-700">陰影</span>
        </label>

        {shadowEnabled && (
          <div className="space-y-2 pl-1">
            {[
              { key: "shadow_offset_x", label: "偏移 X", defaultValue: 5, min: -30, max: 30 },
              { key: "shadow_offset_y", label: "偏移 Y", defaultValue: 8, min: -30, max: 30 },
              { key: "shadow_blur", label: "模糊", defaultValue: 14, min: 0, max: 40 },
            ].map(shadowField => (
              <div key={shadowField.key} className="flex flex-col gap-0.5">
                <span className="text-xs text-gray-500">{shadowField.label}</span>
                <SliderInput
                  label={shadowField.label}
                  min={shadowField.min}
                  max={shadowField.max}
                  value={elementData[shadowField.key] ?? shadowField.defaultValue}
                  onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                />
              </div>
            ))}

            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-gray-500">不透明度（%）</span>
              <SliderInput
                label="不透明度"
                min={0}
                max={100}
                value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                onChange={event => onPropertyChange({
                  shadow_opacity: Math.round(Number(event.target.value) / 100 * 255),
                })}
              />
            </div>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function TextContentSection({ elementData, onPropertyChange }) {
  return (
    <InspectorSection title="文字內容" dataGuide="text-content-section">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">文字用途</span>
        <div className="grid grid-cols-2 gap-1">
          {[
            { value: TEXT_LABEL_ROLES.FILLABLE, label: "可填文字" },
            { value: TEXT_LABEL_ROLES.STATIC, label: "固定文字" },
          ].map(roleOption => (
            <button
              key={roleOption.value}
              type="button"
              aria-pressed={getTextLabelRole(elementData) === roleOption.value}
              onClick={() => onPropertyChange({ text_role: roleOption.value })}
              className={`min-h-11 rounded border px-2 py-1.5 text-sm transition-colors ${
                getTextLabelRole(elementData) === roleOption.value
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {roleOption.label}
            </button>
          ))}
        </div>
      </div>

      <VariableTextarea
        label={getTextLabelRole(elementData) === TEXT_LABEL_ROLES.STATIC
          ? "固定文字內容"
          : `文字內容（${NAME_VARIABLE}=相本稱呼，${FULL_NAME_VARIABLE}=完整姓名）`}
        value={elementData.text ?? ""}
        onChange={textValue => onPropertyChange({ text: textValue })}
        guideId="text-content"
      />
    </InspectorSection>
  );
}

function TextTypographySection({ elementData, onPropertyChange, recentColors, recentFonts }) {
  return (
    <InspectorSection title="字體與排版" dataGuide="text-typography">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">對齊</span>
        <div className="grid grid-cols-3 gap-1">
          {[
            { value: "left", label: "靠左" },
            { value: "center", label: "置中" },
            { value: "right", label: "靠右" },
          ].map(alignOption => (
            <button
              key={alignOption.value}
              type="button"
              aria-pressed={(elementData.text_align ?? "center") === alignOption.value}
              onClick={() => onPropertyChange({ text_align: alignOption.value })}
              className={`min-h-11 rounded border px-2 py-1 text-sm transition-colors ${
                (elementData.text_align ?? "center") === alignOption.value
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {alignOption.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">字體</span>
        <FontPicker
          value={elementData.font_family}
          recentFonts={recentFonts}
          onChange={fontValue => onPropertyChange({ font_family: fontValue })}
          guideId="text-font-picker"
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">字級（pt）</span>
        <SliderInput
          label="字級"
          min={10}
          max={96}
          value={elementData.font_size ?? 28}
          onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">行距</span>
        <SliderInput
          label="行距"
          min={0.8}
          max={3.0}
          step={0.1}
          numWidth="w-16"
          value={elementData.line_height ?? 1.4}
          onChange={event => onPropertyChange({ line_height: Number(event.target.value) })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">字間距（px）</span>
        <SliderInput
          label="字間距"
          min={0}
          max={30}
          step={1}
          value={elementData.letter_spacing ?? 0}
          onChange={event => onPropertyChange({ letter_spacing: Number(event.target.value) })}
        />
      </div>

      <ColorPicker
        label="文字顏色"
        value={elementData.font_color ?? "#333333"}
        recentColors={recentColors}
        onChange={colorValue => onPropertyChange({ font_color: colorValue })}
        guideId="text-color"
      />
    </InspectorSection>
  );
}

export default function PropertyPanel({
  selectedElement,
  elementData,
  onPropertyChange,
  onPropertyCommit,
  onLayerChange,
  isLocked = false,
  recentColors = [],
  recentFonts = [],
  favoriteStyles = [],
  onSaveFavoriteStyle,
  onApplyFavoriteStyle,
  onRemoveFavoriteStyle,
  selectionScope = "root",
  selectedGroup = null,
  isolationTrail = [],
  materialTextLink = null,
  materialActionsDisabled = false,
  isAnalyzingMaterial = false,
  onEnterGroup,
  onNavigateIsolation,
  onUngroup,
  onAnalyzeMaterial,
}) {
  const materialTextCapacity = useMemo(() => {
    if (selectedElement.type !== "text" || !materialTextLink) return null;
    return measureTextLabelCjkCapacity(elementData, Konva.Text);
  }, [
    elementData,
    materialTextLink,
    selectedElement.type,
  ]);

  if (selectedElement.type === "group") {
    return (
      <PropertyCommitBoundary onPropertyCommit={onPropertyCommit}>
        <GroupPropertyPanel
          group={selectedGroup ?? elementData}
          bounds={elementData}
          isLocked={isLocked}
          isolationTrail={isolationTrail}
          onNavigateIsolation={onNavigateIsolation}
          onLayerChange={onLayerChange}
          onEnterGroup={onEnterGroup}
          onUngroup={onUngroup}
        />
      </PropertyCommitBoundary>
    );
  }

  const isPhotoSlot = selectedElement.type === "photo";
  const isTextLabel = selectedElement.type === "text";
  const isSticker = selectedElement.type === "sticker";
  const panelTitle = isPhotoSlot ? "照片格屬性"
    : isSticker ? "貼圖素材屬性"
    : "純文字屬性";

  return (
    <PropertyCommitBoundary onPropertyCommit={onPropertyCommit}>
      <div className="flex flex-col gap-3" data-guide="property-panel">
        <div className="order-first px-1 py-1">
          <h3 className="font-semibold">{panelTitle}</h3>
        </div>

        {isLocked && <LockedPropertyNotice />}

        {selectionScope === "isolation" && (
          <IsolationBreadcrumb
            trail={isolationTrail}
            onNavigate={onNavigateIsolation}
            tailLabel={isSticker ? "圖片" : isTextLabel ? "文字" : "子物件"}
          />
        )}

        <fieldset disabled={isLocked} className="flex flex-col gap-3 border-0 p-0 disabled:opacity-60">
          {(isPhotoSlot || isTextLabel) && (
            <FavoriteStyleControls
              elementType={selectedElement.type}
              elementData={elementData}
              favoriteStyles={favoriteStyles}
              onSaveFavoriteStyle={onSaveFavoriteStyle}
              onApplyFavoriteStyle={onApplyFavoriteStyle}
              onRemoveFavoriteStyle={onRemoveFavoriteStyle}
            />
          )}

          {!materialActionsDisabled && (isSticker || (isTextLabel && materialTextLink)) && (
            <>
              <button
                type="button"
                disabled={isAnalyzingMaterial}
                onClick={() => onAnalyzeMaterial?.({ type: selectedElement.type, id: selectedElement.id })}
                className="min-h-11 w-full rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isAnalyzingMaterial
                  ? "分析圖片中…"
                  : materialTextLink ? "重新分析並重設文字框" : "分析圖片並建立文字框"}
              </button>
              {isTextLabel && materialTextCapacity != null && (
                <p
                  data-guide="material-text-capacity"
                  className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600"
                >
                  目前文字框約可放
                  <strong className="mx-1 font-semibold text-slate-800">{materialTextCapacity}</strong>
                  個全形中文字（不縮字）
                </p>
              )}
            </>
          )}

          {/* 照片格專屬屬性 */}
          {isPhotoSlot && (
            <PhotoAppearanceSection elementData={elementData} onPropertyChange={onPropertyChange} />
          )}

          {/* 純文字專屬屬性 */}
          {isTextLabel && (
            <>
              <TextContentSection elementData={elementData} onPropertyChange={onPropertyChange} />
              <TextTypographySection
                elementData={elementData}
                onPropertyChange={onPropertyChange}
                recentColors={recentColors}
                recentFonts={recentFonts}
              />
            </>
          )}

          <TransformSection
            isPhotoSlot={isPhotoSlot}
            elementData={elementData}
            onPropertyChange={onPropertyChange}
          />

          {isTextLabel && (
            <InspectorSection
              title="陰影與效果"
              defaultOpen={false}
              dataGuide="property-section-effects"
            >
              <TextShadowControls
                elementData={elementData}
                onPropertyChange={onPropertyChange}
                recentColors={recentColors}
              />
            </InspectorSection>
          )}

          {isPhotoSlot && (
            <PhotoEffectsSection elementData={elementData} onPropertyChange={onPropertyChange} />
          )}

          <LayerOrderSection onLayerChange={onLayerChange} />
        </fieldset>
      </div>
    </PropertyCommitBoundary>
  );
}
