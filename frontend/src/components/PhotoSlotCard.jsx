// 照片格縮圖卡片（純顯示，含 PIL 精確位移縮放計算）

import { getPhotoCropBox } from "../utils/photoUtils";

export default function PhotoSlotCard({ it, url, nat, disabled, onImgLoad, imgRefCallback }) {
  const SHADOW_SCALE = 110 / it.slotH;
  const shEnabled = it.shadowEnabled ?? it.border;
  const shX = ((it.shadowOffsetX ?? 5) * SHADOW_SCALE).toFixed(1);
  const shY = ((it.shadowOffsetY ?? 8) * SHADOW_SCALE).toFixed(1);
  const shB = ((it.shadowBlur ?? 14) * SHADOW_SCALE).toFixed(1);
  const shA = ((it.shadowOpacity ?? 120) / 255).toFixed(2);
  const slotShadow = shEnabled ? `${shX}px ${shY}px ${shB}px rgba(0,0,0,${shA})` : null;

  const outerRPct = `${((it.borderRadius || 0) / it.slotH * 100).toFixed(1)}%`;
  const innerRPct = it.border
    ? `${(Math.max(0, (it.borderRadius || 0) - it.borderW) / it.slotH * 100).toFixed(1)}%`
    : undefined;

  const cropBox = getPhotoCropBox(it);
  const cropTopPct = (cropBox.y / it.slotH) * 100;
  const cropLeftPct = (cropBox.x / it.slotW) * 100;
  const cropRightPct = (cropBox.right / it.slotW) * 100;
  const cropBottomPct = (cropBox.bottom / it.slotH) * 100;

  // PIL-accurate positioning: pixel-based (card fixed at 110px tall)
  const physScale = 110 / it.slotH;
  let imgStyle = null;
  if (nat && url) {
    const cropTW = cropBox.width;
    const cropTH = cropBox.height;
    const cropAspect = cropTW / cropTH;
    let baseW, baseH;
    if (nat > cropAspect) { baseH = cropTH; baseW = cropTH * nat; }
    else                  { baseW = cropTW; baseH = cropTW / nat; }
    const dW = baseW * it.transform.scale;
    const dH = baseH * it.transform.scale;
    const availX = Math.max(0, dW - cropTW);
    const availY = Math.max(0, dH - cropTH);
    const startX = availX / 2 + it.transform.offsetX * availX / 2;
    const startY = availY / 2 + it.transform.offsetY * availY / 2;
    imgStyle = {
      position: "absolute",
      width: Math.round(dW * physScale),
      height: Math.round(dH * physScale),
      left: Math.round(-startX * physScale),
      top: Math.round(-startY * physScale),
      userSelect: "none", pointerEvents: "none",
      maxWidth: "none", maxHeight: "none",
    };
  }

  return (
    <div data-guide="photo-slot-card" style={{
      position: "relative",
      flexShrink: 0,
      height: 110,
      width: Math.round(110 * it.slotW / it.slotH),
      borderRadius: outerRPct,
      overflow: "hidden",
      background: it.border ? "#fff" : (url ? "#111" : "#EEEEEE"),
      border: !url && !it.border ? "1px dashed #d1d5db" : undefined,
      boxShadow: slotShadow ?? "none",
    }}>
      {/* Photo / empty area */}
      <div data-guide="photo-slot-crop" style={{
        position: "absolute",
        top: `${cropTopPct}%`, left: `${cropLeftPct}%`,
        right: `${cropRightPct}%`,
        bottom: `${cropBottomPct}%`,
        overflow: "hidden",
        borderRadius: innerRPct,
        background: url ? "transparent" : (disabled ? "#f1f5f9" : "#EEEEEE"),
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {url ? (
          <img
            data-guide="photo-slot-image"
            ref={imgRefCallback}
            src={url} alt="" draggable={false}
            style={imgStyle ?? {
              width: "100%", height: "100%", objectFit: "cover",
              objectPosition: `${50 + it.transform.offsetX * 50}% ${50 + it.transform.offsetY * 50}%`,
              userSelect: "none", pointerEvents: "none",
            }}
            onLoad={onImgLoad}
          />
        ) : (
          !disabled && <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none", pointerEvents: "none" }}>P{it.pi + 1}·{it.slotIndex + 1}</span>
        )}
      </div>
    </div>
  );
}
