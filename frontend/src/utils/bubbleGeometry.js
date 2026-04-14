// 氣泡框幾何常數計算
// 供 BubbleSVG（預覽）與 BubbleKonvaShape（編輯器）共用，
// 確保前端兩種渲染方式與後端 PIL 輸出的幾何保持一致

/**
 * 計算氣泡框的共用幾何常數。
 *
 * @param {number} width        - 氣泡框寬度（顯示像素）
 * @param {number} height       - 氣泡框高度（顯示像素）
 * @param {number} [borderRadius] - 圓角半徑（未提供則取寬高最小值的 1/5）
 * @returns {{ tailHeight, tailWidth, centerX, centerY, cornerRadius }}
 */
export function getBubbleGeometry(width, height, borderRadius) {
  const tailHeight = Math.round(height / 4);
  const tailWidth = Math.round(width / 5);
  const centerX = width / 2;
  const centerY = height / 2;
  const defaultRadius = Math.round(Math.min(width, height) / 5);
  const cornerRadius = Math.max(0, borderRadius ?? defaultRadius);
  return { tailHeight, tailWidth, centerX, centerY, cornerRadius };
}
