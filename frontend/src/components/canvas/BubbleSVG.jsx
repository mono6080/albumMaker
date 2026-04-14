// 氣泡框 SVG 元件
// 純顯示元件，依照形狀參數繪製對應的 SVG 路徑，
// 幾何計算方式與後端 PIL 渲染保持一致，確保預覽與輸出外觀相符

import { getBubbleGeometry } from "../../utils/bubbleGeometry";

/**
 * 繪製氣泡框 SVG。
 * 所有尺寸參數（displayWidth / displayHeight / borderRadius / borderWidth）
 * 均以「顯示像素」為單位（已套用畫布縮放比例）。
 *
 * @param {number}  displayWidth    - 氣泡框顯示寬度（px）
 * @param {number}  displayHeight   - 氣泡框顯示高度（px）
 * @param {string}  fill            - 氣泡框填充色
 * @param {string}  borderColor     - 外框顏色（null 表示無外框）
 * @param {number}  borderWidth     - 外框粗細（0 表示無外框）
 * @param {string}  shape           - 形狀識別碼（ellipse / rect / speech_* / cloud / star / heart / diamond）
 * @param {number}  borderRadius    - 圓角半徑（僅 rect / speech_* 形狀有效）
 * @param {boolean} isSelected      - 是否顯示選取外框
 */
export default function BubbleSVG({
  displayWidth,
  displayHeight,
  fill,
  borderColor,
  borderWidth,
  shape,
  borderRadius,
  isSelected,
}) {
  const hasStroke = !!(borderColor && borderWidth > 0);
  const strokeColor = hasStroke ? borderColor : "none";
  const strokeWidth = hasStroke ? borderWidth : 0;

  const { tailHeight, tailWidth, centerX, centerY, cornerRadius } =
    getBubbleGeometry(displayWidth, displayHeight, borderRadius);

  // 選取時的高亮外框
  const selectionStroke = isSelected ? "#4F46E5" : "none";
  const selectionStrokeWidth = isSelected ? 2 : 0;

  /**
   * 依形狀渲染對應的 SVG 元素組合。
   * 同一函式呼叫兩次：一次填色、一次繪製選取框（避免選取框被填色遮蓋）。
   */
  function renderShapeElements(shapeFill, shapeStroke, shapeStrokeWidth) {
    switch (shape) {
      case "rect":
        return (
          <rect
            x={0} y={0}
            width={displayWidth} height={displayHeight}
            rx={cornerRadius}
            fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth}
          />
        );

      case "speech_right": {
        // 尾巴向右延伸，位於右側 3/4 高度處
        const tipY = displayHeight * 3 / 4;
        const points = `${displayWidth - 2},${tipY - tailHeight / 2} ${displayWidth - 2},${tipY + tailHeight / 2} ${displayWidth + tailWidth},${tipY}`;
        return (
          <>
            <rect x={0} y={0} width={displayWidth} height={displayHeight} rx={cornerRadius}
              fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
            <polygon points={points}
              fill={shapeFill} stroke={hasStroke ? shapeStroke : "none"} strokeWidth={shapeStrokeWidth} />
          </>
        );
      }

      case "speech_left": {
        // 尾巴向左延伸，位於左側 3/4 高度處
        const tipY = displayHeight * 3 / 4;
        const points = `${2},${tipY - tailHeight / 2} ${2},${tipY + tailHeight / 2} ${-tailWidth},${tipY}`;
        return (
          <>
            <rect x={0} y={0} width={displayWidth} height={displayHeight} rx={cornerRadius}
              fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
            <polygon points={points}
              fill={shapeFill} stroke={hasStroke ? shapeStroke : "none"} strokeWidth={shapeStrokeWidth} />
          </>
        );
      }

      case "speech_bottom": {
        // 尾巴向下延伸，位於底部中央
        const points = `${centerX - tailWidth / 2},${displayHeight - 2} ${centerX + tailWidth / 2},${displayHeight - 2} ${centerX},${displayHeight + tailHeight}`;
        return (
          <>
            <rect x={0} y={0} width={displayWidth} height={displayHeight} rx={cornerRadius}
              fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
            <polygon points={points} fill={shapeFill} />
          </>
        );
      }

      case "speech_top": {
        // 尾巴向上延伸，位於頂部中央
        const points = `${centerX - tailWidth / 2},${2} ${centerX + tailWidth / 2},${2} ${centerX},${-tailHeight}`;
        return (
          <>
            <rect x={0} y={0} width={displayWidth} height={displayHeight} rx={cornerRadius}
              fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
            <polygon points={points} fill={shapeFill} />
          </>
        );
      }

      case "cloud": {
        // 雲朵：底部矩形 + 頂部多個半圓凸起
        const bodyTopY = displayHeight * 2 / 5;
        const cloudRadius = Math.min(cornerRadius, displayHeight / 4);
        const bumpCount = Math.max(3, Math.floor(displayWidth / 60));
        const bumpRadius = Math.floor(displayWidth / (bumpCount * 2));
        return (
          <>
            <rect x={0} y={bodyTopY} width={displayWidth} height={displayHeight - bodyTopY}
              rx={cloudRadius} fill={shapeFill} />
            {Array.from({ length: bumpCount }, (_, bumpIndex) => {
              const bumpCenterX = bumpRadius + bumpIndex * (displayWidth - bumpRadius * 2) / Math.max(bumpCount - 1, 1);
              return (
                <ellipse key={bumpIndex}
                  cx={bumpCenterX} cy={bodyTopY}
                  rx={bumpRadius} ry={bumpRadius}
                  fill={shapeFill}
                />
              );
            })}
            {hasStroke && (
              <rect x={0} y={bodyTopY} width={displayWidth} height={displayHeight - bodyTopY}
                rx={cloudRadius} fill="none" stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
            )}
          </>
        );
      }

      case "star": {
        // 五角星：外圓 + 內圓交替取點
        const outerRadius = Math.min(displayWidth, displayHeight) / 2;
        const innerRadius = outerRadius * 2 / 5;
        const starPoints = Array.from({ length: 10 }, (_, pointIndex) => {
          const angle = Math.PI / 2 + pointIndex * Math.PI / 5;
          const radius = pointIndex % 2 === 0 ? outerRadius : innerRadius;
          return `${centerX + radius * Math.cos(angle)},${centerY - radius * Math.sin(angle)}`;
        }).join(" ");
        return (
          <polygon points={starPoints}
            fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
        );
      }

      case "heart": {
        // 愛心：兩個橢圓 + 底部三角形拼合
        const halfWidth = Math.floor(displayWidth / 2);
        const lowerHeight = Math.round(displayHeight * 0.55);
        return (
          <>
            <ellipse cx={(halfWidth + 4) / 2} cy={lowerHeight} rx={(halfWidth + 4) / 2} ry={lowerHeight} fill={shapeFill} />
            <ellipse cx={(halfWidth - 4 + displayWidth) / 2} cy={lowerHeight} rx={(displayWidth - (halfWidth - 4)) / 2} ry={lowerHeight} fill={shapeFill} />
            <polygon points={`0,${lowerHeight} ${displayWidth},${lowerHeight} ${centerX},${displayHeight}`} fill={shapeFill} />
          </>
        );
      }

      case "diamond": {
        // 菱形：四個頂點
        const points = `${centerX},0 ${displayWidth},${centerY} ${centerX},${displayHeight} 0,${centerY}`;
        return (
          <polygon points={points}
            fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth} />
        );
      }

      default: // ellipse（預設為橢圓）
        return (
          <ellipse cx={centerX} cy={centerY}
            rx={displayWidth / 2} ry={displayHeight / 2}
            fill={shapeFill} stroke={shapeStroke} strokeWidth={shapeStrokeWidth}
          />
        );
    }
  }

  return (
    <svg
      width={displayWidth}
      height={displayHeight}
      viewBox={`0 0 ${displayWidth} ${displayHeight}`}
      style={{
        position: "absolute",
        left: 0, top: 0,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {/* 底層：實際填色的形狀 */}
      {renderShapeElements(fill, strokeColor, strokeWidth)}
      {/* 頂層：選取高亮框（只有在選取時才繪製，且不填色） */}
      {isSelected && renderShapeElements("none", selectionStroke, selectionStrokeWidth)}
    </svg>
  );
}
