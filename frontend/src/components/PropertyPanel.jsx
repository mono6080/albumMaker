// PropertyPanel — 模板編輯器右側屬性面板
// 依選取元素類型（照片格 / 氣泡框 / 純文字 / 貼圖）顯示對應屬性控制項

import { useId, useRef } from "react";

import ColorPicker from "./ColorPicker";
import { BUBBLE_SHAPES } from "../constants/shapes";
import { FONT_OPTIONS } from "../constants/fonts";
import { NAME_VARIABLE, insertTextToken } from "../utils/textVariables";
import { TEXT_LABEL_ROLES, getTextLabelRole } from "../utils/textLabelRoles";

// 滑桿 + 數字輸入的組合控制項
function SliderInput({ min, max, step = 1, value, onChange, numWidth = "w-14" }) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value} onChange={onChange} className="flex-1" />
      <input type="number" min={min} max={max} step={step} value={value} onChange={onChange} className={`border rounded px-1 py-1 text-sm ${numWidth} text-center`} />
    </div>
  );
}

// 字體選擇器格狀按鈕
function FontPicker({ value, onChange, guideId }) {
  return (
    <div className="grid grid-cols-2 gap-1.5" data-guide={guideId}>
      {FONT_OPTIONS.map(fontOption => (
        <button
          key={fontOption.value}
          onClick={() => onChange(fontOption.value)}
          style={{ fontFamily: fontOption.css, fontWeight: fontOption.bold ? "bold" : "normal" }}
          className={`px-2 py-1.5 rounded border text-sm text-left truncate transition-colors ${
            value === fontOption.value
              ? "border-indigo-500 bg-indigo-50 text-indigo-700"
              : "border-gray-200 hover:border-gray-300 text-gray-700"
          }`}
        >
          {fontOption.label}
        </button>
      ))}
    </div>
  );
}

function VariableTextarea({ label, value, rows = 3, onChange, guideId }) {
  const textareaId = useId();
  const textareaRef = useRef(null);

  const handleInsertName = () => {
    const textarea = textareaRef.current;
    const next = insertTextToken(
      textarea?.value ?? value ?? "",
      textarea?.selectionStart,
      textarea?.selectionEnd,
      NAME_VARIABLE,
    );
    onChange(next.text);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="flex flex-col gap-1" data-guide={guideId}>
      <span className="flex items-center justify-between gap-2">
        <label htmlFor={textareaId} className="text-xs text-gray-500">{label}</label>
        <button
          type="button"
          onClick={handleInsertName}
          data-guide={guideId ? `${guideId}-insert-name` : undefined}
          className="px-2 py-1 text-xs rounded border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
        >
          插入 {NAME_VARIABLE}
        </button>
      </span>
      <textarea
        id={textareaId}
        ref={textareaRef}
        rows={rows}
        value={value ?? ""}
        onChange={event => onChange(event.target.value)}
        className="border rounded px-2 py-1 text-sm"
      />
    </div>
  );
}

function TextShadowControls({ elementData, onPropertyChange }) {
  const enabled = !!(elementData.text_shadow_enabled ?? false);

  return (
    <div className="space-y-2 pt-1 border-t border-gray-100" data-guide="text-shadow-controls">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => onPropertyChange({ text_shadow_enabled: event.target.checked })}
          data-guide="text-shadow-toggle"
        />
        <span className="text-sm font-medium text-gray-700">文字陰影</span>
      </label>

      {enabled && (
        <div className="space-y-2 pl-1">
          <ColorPicker
            label="陰影顏色"
            value={elementData.text_shadow_color ?? "#000000"}
            onChange={colorValue => onPropertyChange({ text_shadow_color: colorValue })}
          />

          {[
            { key: "text_shadow_offset_x", label: "偏移 X", defaultValue: 3, min: -30, max: 30 },
            { key: "text_shadow_offset_y", label: "偏移 Y", defaultValue: 3, min: -30, max: 30 },
            { key: "text_shadow_blur",     label: "模糊",   defaultValue: 4, min: 0,   max: 40 },
          ].map(shadowField => (
            <label key={shadowField.key} className="flex flex-col gap-0.5">
              <span className="text-xs text-gray-500">{shadowField.label}</span>
              <SliderInput
                min={shadowField.min}
                max={shadowField.max}
                value={elementData[shadowField.key] ?? shadowField.defaultValue}
                onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
              />
            </label>
          ))}

          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">不透明度（%）</span>
            <SliderInput
              min={0}
              max={100}
              value={Math.round(((elementData.text_shadow_opacity ?? 120) / 255) * 100)}
              onChange={event => onPropertyChange({
                text_shadow_opacity: Math.round(Number(event.target.value) / 100 * 255),
              })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export default function PropertyPanel({ selectedElement, elementData, onPropertyChange, onLayerChange }) {
  const isPhotoSlot = selectedElement.type === "photo";
  const isBubble = selectedElement.type === "bubble";
  const isTextLabel = selectedElement.type === "text";
  const isSticker = selectedElement.type === "sticker";

  const panelTitle = isPhotoSlot ? "📷 照片格屬性"
    : isSticker ? "🖼️ 貼圖素材屬性"
    : isTextLabel ? "Ａ 純文字屬性"
    : "💬 氣泡框屬性";

  return (
    <div className="bg-white border rounded-lg p-4 space-y-4" data-guide="property-panel">
      <h3 className="font-semibold">{panelTitle}</h3>

      {/* 通用：層次控制 */}
      <div>
        <span className="text-xs text-gray-500 block mb-1">層次</span>
        <div className="flex gap-1">
          {[
            { dir: "bottom", label: "⬇ 最底" },
            { dir: "down",   label: "↓ 下移" },
            { dir: "up",     label: "↑ 上移" },
            { dir: "top",    label: "⬆ 最頂" },
          ].map(({ dir, label }) => (
            <button
              key={dir}
              onClick={() => onLayerChange(dir)}
              className="flex-1 px-1 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 通用：位置與尺寸 */}
      <div data-guide="property-position-size">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">位置與尺寸</span>
          <button
            type="button"
            onClick={() => onPropertyChange({
              width: elementData.height ?? 0,
              height: elementData.width ?? 0,
            })}
            data-guide="flip-size"
            className="px-2 py-1 text-xs rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            翻轉長寬
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { key: "x",      label: isPhotoSlot ? "照片 X" : "X 位置" },
            { key: "y",      label: isPhotoSlot ? "照片 Y" : "Y 位置" },
            { key: "width",  label: isPhotoSlot ? "照片寬度" : "寬度" },
            { key: "height", label: isPhotoSlot ? "照片高度" : "高度" },
          ].map(field => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">{field.label}</span>
              <input
                type="number"
                value={elementData[field.key] ?? 0}
                onChange={event => {
                  const nextValue = Number(event.target.value);
                  // 照片格鎖定長寬比例：改寬度或高度時，另一邊等比連動
                  const isSizeField = field.key === "width" || field.key === "height";
                  if (isPhotoSlot && isSizeField && nextValue > 0 && elementData.width > 0 && elementData.height > 0) {
                    const aspectRatio = elementData.width / elementData.height;
                    onPropertyChange(field.key === "width"
                      ? { width: nextValue, height: Math.round(nextValue / aspectRatio) }
                      : { width: Math.round(nextValue * aspectRatio), height: nextValue });
                    return;
                  }
                  onPropertyChange({ [field.key]: nextValue });
                }}
                className="border rounded px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
      </div>

      {/* 通用：旋轉角度 */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">旋轉角度（度）</span>
        <input
          type="number" step="0.5"
          value={elementData.rotation ?? 0}
          onChange={event => onPropertyChange({ rotation: Number(event.target.value) })}
          className="border rounded px-2 py-1 text-sm w-24"
        />
      </label>

      {/* 照片格專屬屬性 */}
      {isPhotoSlot && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={elementData.border ?? true}
              onChange={event => onPropertyChange({ border: event.target.checked })}
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
                className="border rounded px-2 py-1 text-sm w-24"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">圓角半徑（px）</span>
            <SliderInput
              min={0}
              max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
              value={elementData.border_radius ?? 0}
              onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
            />
          </label>

          {/* 陰影設定 */}
          <div className="space-y-2 pt-1 border-t border-gray-100" data-guide="photo-visual-style">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={elementData.shadow_enabled ?? (elementData.border !== false)}
                onChange={event => onPropertyChange({ shadow_enabled: event.target.checked })}
              />
              <span className="text-sm font-medium text-gray-700">陰影</span>
            </label>

            {(elementData.shadow_enabled ?? (elementData.border !== false)) && (
              <div className="space-y-2 pl-1">
                {[
                  { key: "shadow_offset_x", label: "偏移 X", defaultValue: 5,  min: -30, max: 30 },
                  { key: "shadow_offset_y", label: "偏移 Y", defaultValue: 8,  min: -30, max: 30 },
                  { key: "shadow_blur",     label: "模糊",   defaultValue: 14, min: 0,   max: 40 },
                ].map(shadowField => (
                  <label key={shadowField.key} className="flex flex-col gap-0.5">
                    <span className="text-xs text-gray-500">{shadowField.label}</span>
                    <SliderInput
                      min={shadowField.min} max={shadowField.max}
                      value={elementData[shadowField.key] ?? shadowField.defaultValue}
                      onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                    />
                  </label>
                ))}

                <label className="flex flex-col gap-0.5">
                  <span className="text-xs text-gray-500">不透明度（%）</span>
                  <SliderInput
                    min={0} max={100}
                    value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                    onChange={event => onPropertyChange({ shadow_opacity: Math.round(Number(event.target.value) / 100 * 255) })}
                  />
                </label>
              </div>
            )}
          </div>
        </>
      )}

      {/* 氣泡框專屬屬性 */}
      {isBubble && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">形狀</span>
            <div className="grid grid-cols-5 gap-1">
              {BUBBLE_SHAPES.map(shapeOption => (
                <button
                  key={shapeOption.value}
                  onClick={() => onPropertyChange({ shape: shapeOption.value })}
                  title={shapeOption.label}
                  className={`flex flex-col items-center gap-0.5 py-1.5 rounded border text-xs transition-colors ${
                    elementData.shape === shapeOption.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-600"
                  }`}
                >
                  <span className="text-base leading-none">{shapeOption.icon}</span>
                  <span className="text-[10px]">{shapeOption.label}</span>
                </button>
              ))}
            </div>
          </div>

          {elementData.shape !== "ellipse" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">圓角半徑（px）</span>
              <SliderInput
                min={0}
                max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                value={elementData.border_radius ?? Math.round(Math.min(elementData.width, elementData.height) / 5)}
                onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
              />
            </label>
          )}

          <ColorPicker
            label="背景顏色"
            value={elementData.fill}
            onChange={colorValue => onPropertyChange({ fill: colorValue })}
          />

          <VariableTextarea
            label={`預設文字（可用 ${NAME_VARIABLE} 代入姓名）`}
            value={elementData.text ?? ""}
            onChange={textValue => onPropertyChange({ text: textValue })}
            guideId="bubble-text-content"
          />

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <FontPicker
              value={elementData.font_family}
              onChange={fontValue => onPropertyChange({ font_family: fontValue })}
              guideId="bubble-font-picker"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <SliderInput
              min={10} max={72}
              value={elementData.font_size ?? 20}
              onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
            />
          </label>

          <ColorPicker
            label="文字顏色"
            value={elementData.font_color ?? "#333333"}
            onChange={colorValue => onPropertyChange({ font_color: colorValue })}
            guideId="bubble-text-color"
          />

          <TextShadowControls elementData={elementData} onPropertyChange={onPropertyChange} />

          <div className="space-y-2 pt-1 border-t border-gray-100">
            <span className="text-xs text-gray-500 block">外框</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={!!(elementData.border_color && (elementData.border_width ?? 0) > 0)}
                  onChange={event => onPropertyChange(
                    event.target.checked
                      ? { border_color: elementData.border_color || "#555555", border_width: elementData.border_width || 2 }
                      : { border_color: null, border_width: 0 }
                  )}
                />
                顯示外框
              </label>
              {elementData.border_color && (elementData.border_width ?? 0) > 0 && (
                <label className="flex items-center gap-1 text-xs text-gray-500 ml-auto">
                  粗細
                  <input
                    type="number" min="1" max="20"
                    value={elementData.border_width ?? 2}
                    onChange={event => onPropertyChange({ border_width: Number(event.target.value) })}
                    className="border rounded px-1 py-0.5 text-sm w-14 text-center"
                  />
                </label>
              )}
            </div>
            {elementData.border_color && (elementData.border_width ?? 0) > 0 && (
              <ColorPicker
                value={elementData.border_color ?? "#555555"}
                onChange={colorValue => onPropertyChange({ border_color: colorValue })}
              />
            )}
          </div>
        </>
      )}

      {/* 純文字專屬屬性 */}
      {isTextLabel && (
        <>
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
                  className={`px-2 py-1.5 rounded border text-sm transition-colors ${
                    getTextLabelRole(elementData) === roleOption.value
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200"
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
              : `文字內容（可用 ${NAME_VARIABLE} 代入姓名）`}
            value={elementData.text ?? ""}
            onChange={textValue => onPropertyChange({ text: textValue })}
            guideId="text-content"
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">對齊</span>
            <div className="flex gap-1">
              {[
                { value: "left",   label: "靠左" },
                { value: "center", label: "置中" },
                { value: "right",  label: "靠右" },
              ].map(alignOption => (
                <button
                  key={alignOption.value}
                  onClick={() => onPropertyChange({ text_align: alignOption.value })}
                  className={`flex-1 px-2 py-1 rounded border text-sm transition-colors ${
                    (elementData.text_align ?? "center") === alignOption.value
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200"
                  }`}
                >
                  {alignOption.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <FontPicker
              value={elementData.font_family}
              onChange={fontValue => onPropertyChange({ font_family: fontValue })}
              guideId="text-font-picker"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <SliderInput
              min={10} max={96}
              value={elementData.font_size ?? 28}
              onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
            />
          </label>

          <ColorPicker
            label="文字顏色"
            value={elementData.font_color ?? "#333333"}
            onChange={colorValue => onPropertyChange({ font_color: colorValue })}
            guideId="text-color"
          />

          <TextShadowControls elementData={elementData} onPropertyChange={onPropertyChange} />

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">行距</span>
            <SliderInput
              min={0.8} max={3.0} step={0.1} numWidth="w-16"
              value={elementData.line_height ?? 1.4}
              onChange={event => onPropertyChange({ line_height: Number(event.target.value) })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字間距（px）</span>
            <SliderInput
              min={0} max={30} step={1}
              value={elementData.letter_spacing ?? 0}
              onChange={event => onPropertyChange({ letter_spacing: Number(event.target.value) })}
            />
          </label>
        </>
      )}
    </div>
  );
}
