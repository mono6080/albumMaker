// BubbleKonvaShape — Konva Canvas 2D 氣泡框繪製元件
// 幾何計算與 BubbleSVG.jsx 及後端 PIL _draw_speech_bubble 保持一致

import { useCallback } from "react";
import { Shape } from "react-konva";

function drawRoundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export default function BubbleKonvaShape({ width: w, height: h, shape, fill, borderColor, borderWidth, borderRadius }) {
  const hasStroke = !!(borderColor && borderWidth > 0);
  const defaultBorderRadius = Math.round(Math.min(w, h) / 5);
  const cornerRadius = Math.max(0, borderRadius ?? defaultBorderRadius);
  const tailHeight = Math.round(h / 4);
  const tailWidth = Math.round(w / 5);
  const centerX = w / 2;
  const centerY = h / 2;

  const sceneFunc = useCallback((context) => {
    const ctx = context._context;
    ctx.save();

    const doFill = () => { ctx.fillStyle = fill; ctx.fill(); };
    const doStroke = () => {
      if (hasStroke) {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth;
        ctx.stroke();
      }
    };

    if (shape === "rect") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();

    } else if (shape === "speech_right") {
      const tipY = h * 3 / 4;
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(w - 2, tipY - tailHeight / 2);
      ctx.lineTo(w - 2, tipY + tailHeight / 2);
      ctx.lineTo(w + tailWidth, tipY);
      ctx.closePath();
      doFill();
      if (hasStroke) doStroke();

    } else if (shape === "speech_left") {
      const tipY = h * 3 / 4;
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(2, tipY - tailHeight / 2);
      ctx.lineTo(2, tipY + tailHeight / 2);
      ctx.lineTo(-tailWidth, tipY);
      ctx.closePath();
      doFill();
      if (hasStroke) doStroke();

    } else if (shape === "speech_bottom") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(centerX - tailWidth / 2, h - 2);
      ctx.lineTo(centerX + tailWidth / 2, h - 2);
      ctx.lineTo(centerX, h + tailHeight);
      ctx.closePath();
      doFill();

    } else if (shape === "speech_top") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(centerX - tailWidth / 2, 2);
      ctx.lineTo(centerX + tailWidth / 2, 2);
      ctx.lineTo(centerX, -tailHeight);
      ctx.closePath();
      doFill();

    } else if (shape === "cloud") {
      const bodyTopY = h * 2 / 5;
      const cloudRadius = Math.min(cornerRadius, h / 4);
      const bumpCount = Math.max(3, Math.floor(w / 60));
      const bumpRadius = Math.floor(w / (bumpCount * 2));
      drawRoundRectPath(ctx, 0, bodyTopY, w, h - bodyTopY, cloudRadius);
      doFill();
      for (let i = 0; i < bumpCount; i++) {
        const bumpCenterX = bumpRadius + i * (w - bumpRadius * 2) / Math.max(bumpCount - 1, 1);
        ctx.beginPath();
        ctx.arc(bumpCenterX, bodyTopY, bumpRadius, 0, Math.PI * 2);
        doFill();
      }
      if (hasStroke) {
        drawRoundRectPath(ctx, 0, bodyTopY, w, h - bodyTopY, cloudRadius);
        doStroke();
      }

    } else if (shape === "star") {
      const outerRadius = Math.min(w, h) / 2;
      const innerRadius = outerRadius * 2 / 5;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const angle = Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const px = centerX + radius * Math.cos(angle);
        const py = centerY - radius * Math.sin(angle);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      doFill(); doStroke();

    } else if (shape === "heart") {
      const halfWidth = Math.floor(w / 2);
      const lowerH = Math.round(h * 0.55);
      ctx.beginPath();
      ctx.ellipse((halfWidth + 4) / 2, lowerH, (halfWidth + 4) / 2, lowerH, 0, 0, Math.PI * 2);
      doFill();
      ctx.beginPath();
      ctx.ellipse((halfWidth - 4 + w) / 2, lowerH, (w - (halfWidth - 4)) / 2, lowerH, 0, 0, Math.PI * 2);
      doFill();
      ctx.beginPath();
      ctx.moveTo(0, lowerH);
      ctx.lineTo(w, lowerH);
      ctx.lineTo(centerX, h);
      ctx.closePath();
      doFill();

    } else if (shape === "diamond") {
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(w, centerY);
      ctx.lineTo(centerX, h);
      ctx.lineTo(0, centerY);
      ctx.closePath();
      doFill(); doStroke();

    } else {
      // 預設：橢圓
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w / 2, h / 2, 0, 0, Math.PI * 2);
      doFill(); doStroke();
    }

    ctx.restore();
  }, [w, h, shape, fill, borderColor, borderWidth, hasStroke, cornerRadius, tailHeight, tailWidth, centerX, centerY]);

  return (
    <Shape
      width={w} height={h}
      sceneFunc={sceneFunc}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}
