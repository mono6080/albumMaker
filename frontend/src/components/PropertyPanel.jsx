// PropertyPanel — 模板編輯器右側屬性面板
// 依選取元素類型（照片格 / 氣泡框 / 純文字 / 貼圖）顯示對應屬性控制項

import ColorPicker from "./ColorPicker";
import { BUBBLE_SHAPES } from "../constants/shapes";
import { FONT_OPTIONS } from "../constants/fonts";

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
    <div className="bg-white border rounded-lg p-4 space-y-4">
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
      <div className="grid grid-cols-2 gap-3">
        {[
          { key: "x",      label: "X 位置" },
          { key: "y",      label: "Y 位置" },
          { key: "width",  label: "寬度" },
          { key: "height", label: "高度" },
        ].map(field => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">{field.label}</span>
            <input
              type="number"
              value={elementData[field.key] ?? 0}
              onChange={event => onPropertyChange({ [field.key]: Number(event.target.value) })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>
        ))}
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

          {elementData.border && (
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
            <div className="flex items-center gap-2">
              <input
                type="range" min="0"
                max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                value={elementData.border_radius ?? 0}
                onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="0"
                max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                value={elementData.border_radius ?? 0}
                onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          {/* 陰影設定 */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
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
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={shadowField.min} max={shadowField.max}
                        value={elementData[shadowField.key] ?? shadowField.defaultValue}
                        onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                        className="flex-1"
                      />
                      <input
                        type="number"
                        min={shadowField.min} max={shadowField.max}
                        value={elementData[shadowField.key] ?? shadowField.defaultValue}
                        onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                        className="border rounded px-1 py-1 text-sm w-14 text-center"
                      />
                    </div>
                  </label>
                ))}

                <label className="flex flex-col gap-0.5">
                  <span className="text-xs text-gray-500">不透明度（%）</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min="0" max="100"
                      value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={event =>
                        onPropertyChange({ shadow_opacity: Math.round(Number(event.target.value) / 100 * 255) })
                      }
                      className="flex-1"
                    />
                    <input
                      type="number" min="0" max="100"
                      value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={event =>
                        onPropertyChange({ shadow_opacity: Math.round(Number(event.target.value) / 100 * 255) })
                      }
                      className="border rounded px-1 py-1 text-sm w-14 text-center"
                    />
                  </div>
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
              <div className="flex items-center gap-2">
                <input
                  type="range" min="0"
                  max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                  value={
                    elementData.border_radius ??
                    Math.round(Math.min(elementData.width, elementData.height) / 5)
                  }
                  onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                  className="flex-1"
                />
                <input
                  type="number" min="0"
                  max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                  value={
                    elementData.border_radius ??
                    Math.round(Math.min(elementData.width, elementData.height) / 5)
                  }
                  onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                  className="border rounded px-1 py-1 text-sm w-14 text-center"
                />
              </div>
            </label>
          )}

          <ColorPicker
            label="背景顏色"
            value={elementData.fill}
            onChange={colorValue => onPropertyChange({ fill: colorValue })}
          />

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">預設文字（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <div className="grid grid-cols-2 gap-1.5">
              {FONT_OPTIONS.map(fontOption => (
                <button
                  key={fontOption.value}
                  onClick={() => onPropertyChange({ font_family: fontOption.value })}
                  style={{ fontFamily: fontOption.css, fontWeight: fontOption.bold ? "bold" : "normal" }}
                  className={`px-2 py-1.5 rounded border text-sm text-left truncate transition-colors ${
                    elementData.font_family === fontOption.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-700"
                  }`}
                >
                  {fontOption.label}
                </button>
              ))}
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="10" max="72" step="1"
                value={elementData.font_size ?? 20}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="10" max="72"
                value={elementData.font_size ?? 20}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          <ColorPicker
            label="文字顏色"
            value={elementData.font_color ?? "#333333"}
            onChange={colorValue => onPropertyChange({ font_color: colorValue })}
          />

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
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">文字內容（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

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
            <div className="grid grid-cols-2 gap-1.5">
              {FONT_OPTIONS.map(fontOption => (
                <button
                  key={fontOption.value}
                  onClick={() => onPropertyChange({ font_family: fontOption.value })}
                  style={{ fontFamily: fontOption.css, fontWeight: fontOption.bold ? "bold" : "normal" }}
                  className={`px-2 py-1.5 rounded border text-sm text-left truncate transition-colors ${
                    elementData.font_family === fontOption.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-700"
                  }`}
                >
                  {fontOption.label}
                </button>
              ))}
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="10" max="96" step="1"
                value={elementData.font_size ?? 28}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="10" max="96"
                value={elementData.font_size ?? 28}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          <ColorPicker
            label="文字顏色"
            value={elementData.font_color ?? "#333333"}
            onChange={colorValue => onPropertyChange({ font_color: colorValue })}
          />
        </>
      )}
    </div>
  );
}
