import { useRef } from "react";

// 48 curated colors (6 rows × 8 cols)
const PRESETS = [
  // 相冊常用粉彩
  "#FDED6E","#FFE4B5","#FFD1DC","#FFAABB","#E8D5FF","#C8E6FF","#B5D5C5","#D4EDDA",
  // 鮮豔暖色
  "#FF4444","#FF6B35","#FFD700","#FFAA00","#FF69B4","#FF8C94","#FFA500","#FF6699",
  // 鮮豔冷色
  "#00CC55","#55DD88","#00AAFF","#4499FF","#6644EE","#9966FF","#00BCD4","#00E5FF",
  // 中性飽和
  "#E74C3C","#E67E22","#F39C12","#27AE60","#3498DB","#9B59B6","#E91E63","#00ACC1",
  // 深色調
  "#C0392B","#D35400","#B7950B","#1E8449","#1565C0","#6A1B9A","#AD1457","#006064",
  // 灰階
  "#FFFFFF","#E0E0E0","#BDBDBD","#9E9E9E","#616161","#424242","#212121","#000000",
];

/**
 * ColorPicker — 共用調色模組
 * Props:
 *   value    : 目前顏色（hex string, e.g. "#FF0000"）
 *   onChange : (hexString) => void
 *   label    : 選填標籤文字
 */
export default function ColorPicker({ value, onChange, label, guideId, recentColors = [] }) {
  const nativeRef = useRef(null);
  const safeValue = value || "#000000";
  const normalizedRecentColors = [...new Set(
    recentColors
      .map(color => String(color).trim().toUpperCase())
      .filter(color => /^#[0-9A-F]{6}$/.test(color)),
  )];
  const recentColorSet = new Set(normalizedRecentColors);
  const presetColorSet = new Set(PRESETS.map(color => color.toUpperCase()));
  const customRecentColors = normalizedRecentColors.filter(color => !presetColorSet.has(color));
  const renderSwatch = (color, keyPrefix = "preset") => {
    const isActive = safeValue.toLowerCase() === color.toLowerCase();
    const isRecent = recentColorSet.has(color.toUpperCase());
    return (
      <button
        key={`${keyPrefix}-${color}`}
        type="button"
        title={isRecent ? `${color}（最近使用）` : color}
        aria-label={`使用顏色 ${color}`}
        aria-pressed={isActive}
        onClick={() => onChange(color)}
        style={{
          background: color,
          boxShadow: isActive
            ? "0 0 0 2px #fff, 0 0 0 4px #4F46E5"
            : "inset 0 0 0 1px rgba(0,0,0,0.15)",
        }}
        className="relative h-11 w-11 rounded-md transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
      >
        {isRecent && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full border border-white bg-indigo-500"
          />
        )}
      </button>
    );
  };

  return (
    <div className="space-y-2" data-guide={guideId}>
      {label && (
        <span className="text-xs text-gray-500 block">{label}</span>
      )}

      {customRecentColors.length > 0 && (
        <div className="space-y-1">
          <span className="block text-[11px] font-medium text-gray-400">最近自訂</span>
          <div className="flex flex-wrap gap-1">
            {customRecentColors.map(color => renderSwatch(color, "custom-recent"))}
          </div>
        </div>
      )}

      {/* ── 常見色票 ── */}
      <div className="grid grid-cols-5 gap-1 xl:grid-cols-6">
        {PRESETS.map(color => renderSwatch(color))}
      </div>

      {/* ── 調色盤 + hex 輸入 ── */}
      <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
        {/* 目前色塊（點擊開啟系統調色盤） */}
        <button
          type="button"
          title="開啟調色盤"
          aria-label="開啟系統調色盤"
          onClick={() => nativeRef.current?.click()}
          style={{ background: safeValue }}
          className="h-11 w-11 flex-shrink-0 rounded-lg border border-gray-200 transition-all hover:ring-2 hover:ring-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        />
        {/* Hex 輸入 */}
        <input
          type="text"
          defaultValue={safeValue.toUpperCase()}
          key={safeValue}          /* reset when value changes externally */
          onBlur={e => {
            let v = e.target.value.trim();
            if (!v.startsWith("#")) v = "#" + v;
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toUpperCase());
            else e.target.value = safeValue.toUpperCase(); // revert invalid
          }}
          onKeyDown={e => {
            if (e.key === "Enter") e.target.blur();
          }}
          className="min-h-11 w-24 rounded border px-2 py-1 font-mono text-sm uppercase tracking-wider"
          placeholder="#000000"
          maxLength={7}
        />
        {/* 調色盤按鈕 */}
        <button
          type="button"
          onClick={() => nativeRef.current?.click()}
          className="ml-auto min-h-11 whitespace-nowrap rounded-lg border border-indigo-200 px-2 py-1 text-xs text-indigo-600 transition-colors hover:bg-indigo-50 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          調色盤
        </button>
        {/* 隱藏的 native color input */}
        <input
          ref={nativeRef}
          type="color"
          value={safeValue}
          onChange={e => onChange(e.target.value)}
          className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    </div>
  );
}
