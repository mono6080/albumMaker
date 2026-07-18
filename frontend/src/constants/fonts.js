// 字體定義
// 提供模板編輯器與屬性面板使用的字體選項清單，
// 每個字體同時記錄後端 key、顯示名稱、CSS 字體族與是否加粗
// 跨語言鏡像：value 必須存在於 backend/services/draw_helpers.py 的 FONT_MAP，
// 一致性由 tests/test_font_parity.py 釘住（漏加後端 PDF 會靜默 fallback 字型）

/**
 * 系統支援的中文字體列表。
 * value：對應後端 layout_json 中的 font_family 欄位。
 * css：瀏覽器渲染時使用的 CSS font-family 字串。
 * bold：是否以粗體渲染。
 */
export const FONT_OPTIONS = [
  {
    value: "msjh",
    label: "微軟正黑體",
    css: '"Album Noto Sans TC", sans-serif',
    bold: false,
  },
  {
    value: "msjhbd",
    label: "微軟正黑體 Bold",
    css: '"Album Noto Sans TC", sans-serif',
    bold: true,
  },
  {
    value: "kaiu",
    label: "標楷體",
    css: '"Album Noto Serif TC", serif',
    bold: false,
  },
  {
    value: "mingliu",
    label: "細明體",
    css: '"Album Noto Serif TC", serif',
    bold: false,
  },
  {
    value: "simsun",
    label: "新細明體",
    css: '"Album Noto Serif TC", serif',
    bold: false,
  },
  {
    value: "msyh",
    label: "微軟雅黑",
    css: '"Album Noto Sans TC", sans-serif',
    bold: false,
  },
];

/**
 * 根據字體 value 取得對應的 CSS 字體族字串。
 * 找不到時回傳 sans-serif 作為後備。
 */
export function getFontCss(fontValue) {
  const matched = FONT_OPTIONS.find((font) => font.value === fontValue);
  return matched ? matched.css : "sans-serif";
}

/**
 * 根據字體 value 判斷是否為粗體。
 */
export function isFontBold(fontValue) {
  const matched = FONT_OPTIONS.find((font) => font.value === fontValue);
  return matched?.bold ?? false;
}
