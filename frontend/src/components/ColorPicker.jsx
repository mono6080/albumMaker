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
export default function ColorPicker({ value, onChange, label, guideId }) {
  const nativeRef = useRef(null);
  const safeValue = value || "#000000";

  return (
    <div className="space-y-2" data-guide={guideId}>
      {label && (
        <span className="text-xs text-gray-500 block">{label}</span>
      )}

      {/* ── 常見色票 ── */}
      <div className="grid grid-cols-8 gap-1">
        {PRESETS.map(c => {
          const isActive = safeValue.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              title={c}
              onClick={() => onChange(c)}
              style={{
                background: c,
                boxShadow: isActive
                  ? "0 0 0 2px #fff, 0 0 0 4px #4F46E5"
                  : "inset 0 0 0 1px rgba(0,0,0,0.15)",
              }}
              className="w-6 h-6 rounded-md transition-transform hover:scale-110 focus:outline-none"
            />
          );
        })}
      </div>

      {/* ── 調色盤 + hex 輸入 ── */}
      <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
        {/* 目前色塊（點擊開啟系統調色盤） */}
        <button
          title="開啟調色盤"
          onClick={() => nativeRef.current?.click()}
          style={{ background: safeValue }}
          className="w-8 h-8 rounded-lg border border-gray-200 flex-shrink-0 hover:ring-2 hover:ring-indigo-300 transition-all"
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
          className="border rounded px-2 py-1 text-sm font-mono w-24 uppercase tracking-wider"
          placeholder="#000000"
          maxLength={7}
        />
        {/* 調色盤按鈕 */}
        <button
          onClick={() => nativeRef.current?.click()}
          className="ml-auto text-xs text-indigo-600 hover:text-indigo-800 px-2 py-1 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors whitespace-nowrap"
        >
          調色盤
        </button>
        {/* 隱藏的 native color input */}
        <input
          ref={nativeRef}
          type="color"
          value={safeValue}
          onChange={e => onChange(e.target.value)}
          className="sr-only"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
