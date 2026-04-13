// 空格位框架預覽（相框樣式縮圖，供 PhotoManager 空格顯示）

import { Upload } from "lucide-react";

export default function SlotFramePreview({ slotW, slotH, border, borderW, borderRadius = 0,
  shadowEnabled, shadowOffsetX = 5, shadowOffsetY = 8, shadowBlur = 14, shadowOpacity = 120,
  disabled }) {
  const aspect = slotW / slotH;
  const frameH = 126;
  const frameW = Math.round(frameH * aspect);
  const scale = frameH / slotH;
  const shOn = shadowEnabled ?? border;
  const shX = Math.round(shadowOffsetX * scale);
  const shY = Math.round(shadowOffsetY * scale);
  const shB = Math.round(shadowBlur * scale);
  const shA = (shadowOpacity / 255).toFixed(2);
  const boxShadow = shOn ? `${shX}px ${shY}px ${shB}px rgba(0,0,0,${shA})` : "none";

  if (border) {
    const bwPx = Math.max(3, Math.round(borderW * scale));
    const rPx = Math.round(borderRadius * scale);
    const innerR = Math.max(0, rPx - bwPx);
    return (
      <div style={{
        width: frameW, height: frameH, flexShrink: 0,
        background: "#fff",
        boxShadow,
        borderRadius: rPx,
        position: "relative",
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute",
          top: bwPx, left: bwPx, right: bwPx, bottom: bwPx * 2,
          background: disabled ? "#f1f5f9" : "#EEEEEE",
          borderRadius: innerR,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 3,
        }}>
          <Upload size={14} className={disabled ? "text-gray-300" : "text-gray-400"} />
          {!disabled && <span style={{ fontSize: 9, color: "#999" }}>點此上傳</span>}
        </div>
      </div>
    );
  }
  const rPx = Math.round(borderRadius * scale);
  return (
    <div style={{
      width: frameW, height: frameH, flexShrink: 0,
      background: "#EEEEEE",
      border: "1px solid #CCCCCC",
      borderRadius: rPx,
      boxShadow,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 3,
      overflow: "hidden",
    }}>
      <Upload size={14} className={disabled ? "text-gray-300" : "text-gray-400"} />
      {!disabled && <span style={{ fontSize: 9, color: "#999" }}>點此上傳</span>}
    </div>
  );
}
