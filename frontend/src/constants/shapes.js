// 氣泡框形狀定義
// 提供模板編輯器與屬性面板使用的形狀選項清單

/** 所有可用的氣泡框形狀，含顯示名稱與圖示 */
export const BUBBLE_SHAPES = [
  { value: "ellipse",       label: "橢圓",   icon: "⭕" },
  { value: "rect",          label: "方形",   icon: "⬛" },
  { value: "speech_right",  label: "泡→",   icon: "💬" },
  { value: "speech_left",   label: "←泡",   icon: "💬" },
  { value: "speech_bottom", label: "泡↓",   icon: "🗨️" },
  { value: "speech_top",    label: "泡↑",   icon: "🗯️" },
  { value: "cloud",         label: "雲朵",   icon: "☁️" },
  { value: "star",          label: "星形",   icon: "⭐" },
  { value: "heart",         label: "愛心",   icon: "❤️" },
  { value: "diamond",       label: "菱形",   icon: "🔷" },
];

/** 氣泡框背景顏色快選調色板 */
export const BUBBLE_PRESET_COLORS = [
  "#FDED6E",
  "#B5D5C5",
  "#FFD1DC",
  "#C8E6FF",
  "#E8D5FF",
  "#FFFFFF",
];
