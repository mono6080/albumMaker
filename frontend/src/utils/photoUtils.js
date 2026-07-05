// 照片資料處理工具函式

import { getPhotoContentRect, getPhotoFrameRect } from "./photoFrameGeometry.js";

// 亮度/對比的 CSS filter 字串：唯一組字串的地方，PhotoSlotCard 與
// PhotoEditModal 皆須引用，避免 parity-critical 公式各自維護、日後跑偏
// （後端對應公式在 backend/services/element_renderers.py 的
// _apply_photo_adjustments，兩邊需保持一致，見 docs/dev/rendering.md）。
export function buildPhotoFilterCss(brightness, contrast) {
  const b = brightness ?? 1;
  const c = contrast ?? 1;
  return b === 1 && c === 1 ? undefined : `brightness(${b}) contrast(${c})`;
}

export function normalizePhotoData(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { path: raw, scale: 1.0, offsetX: 0, offsetY: 0, brightness: 1.0, contrast: 1.0 };
  return {
    path: raw.path ?? null,
    scale: raw.scale ?? 1.0,
    offsetX: raw.offset_x ?? 0,
    offsetY: raw.offset_y ?? 0,
    brightness: raw.brightness ?? 1.0,
    contrast: raw.contrast ?? 1.0,
  };
}

export function buildItems(allSlots, student) {
  const pagesDataMap = Object.fromEntries(
    (student?.pages_data ?? []).map(p => [p.page_index, p])
  );
  return allSlots.map(({ pi, slotId, slotIndex, slotW, slotH, border, borderW, borderRadius, dimensionMode,
    shadowEnabled, shadowOffsetX, shadowOffsetY, shadowBlur, shadowOpacity }) => {
    const frameRect = getPhotoFrameRect({
      x: 0,
      y: 0,
      width: slotW ?? 400,
      height: slotH ?? 400,
      border,
      border_width: borderW,
    }, { dimensionMode });
    const raw = pagesDataMap[pi]?.photos?.[String(slotId)] ?? null;
    const photo = normalizePhotoData(raw);
    const transform = {
      scale: photo?.scale ?? 1.0,
      offsetX: photo?.offsetX ?? 0,
      offsetY: photo?.offsetY ?? 0,
      brightness: photo?.brightness ?? 1.0,
      contrast: photo?.contrast ?? 1.0,
    };
    return {
      pi, slotId, slotIndex, slotW: frameRect.width, slotH: frameRect.height,
      border: border !== false, borderW: borderW ?? 8, borderRadius: borderRadius ?? 0,
      shadowEnabled, shadowOffsetX, shadowOffsetY, shadowBlur, shadowOpacity,
      origPi: photo ? pi : null,
      origSlotId: photo ? slotId : null,
      serverPath: photo?.path ?? null,
      origServerPath: photo?.path ?? null,
      pendingFile: null,
      previewUrl: null,
      transform,
      origTransform: { ...transform },
    };
  });
}

export function getPhotoCropBox(slot) {
  const slotW = slot.slotW ?? slot.width ?? 400;
  const slotH = slot.slotH ?? slot.height ?? 400;
  const sourceSlot = {
    x: 0,
    y: 0,
    width: slotW,
    height: slotH,
    border: slot.border,
    border_width: slot.borderW ?? slot.border_width,
  };
  const frameRect = getPhotoFrameRect(sourceSlot, { dimensionMode: slot.dimensionMode });
  const contentRect = getPhotoContentRect(sourceSlot, { dimensionMode: slot.dimensionMode });

  return {
    x: contentRect.x - frameRect.x,
    y: contentRect.y - frameRect.y,
    right: frameRect.x + frameRect.width - contentRect.x - contentRect.width,
    bottom: frameRect.y + frameRect.height - contentRect.y - contentRect.height,
    width: Math.max(1, contentRect.width),
    height: Math.max(1, contentRect.height),
  };
}

// 計算照片顯示尺寸：比較照片與裁切框比例，取能剛好填滿裁切框的最小縮放。
export function photoDims(cropW, cropH, imgAspect, scale) {
  const cropAspect = cropW / cropH;
  let baseW, baseH;
  if (imgAspect > cropAspect) {
    baseH = cropH;
    baseW = cropH * imgAspect;
  } else {
    baseW = cropW;
    baseH = cropW / imgAspect;
  }
  return { w: baseW * scale, h: baseH * scale };
}

// 限制平移範圍不超出可見區域
export function clampPan(px, py, cropW, cropH, imgAspect, scale) {
  const { w, h } = photoDims(cropW, cropH, imgAspect, scale);
  const sx = Math.max(0, (w - cropW) / 2);
  const sy = Math.max(0, (h - cropH) / 2);
  return { panX: Math.max(-sx, Math.min(sx, px)), panY: Math.max(-sy, Math.min(sy, py)) };
}
