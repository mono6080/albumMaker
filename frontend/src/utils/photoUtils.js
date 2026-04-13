// 照片資料處理工具函式

export function normalizePhotoData(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { path: raw, scale: 1.0, offsetX: 0, offsetY: 0 };
  return { path: raw.path ?? null, scale: raw.scale ?? 1.0, offsetX: raw.offset_x ?? 0, offsetY: raw.offset_y ?? 0 };
}

export function buildItems(allSlots, student) {
  const pagesDataMap = Object.fromEntries(
    (student?.pages_data ?? []).map(p => [p.page_index, p])
  );
  return allSlots.map(({ pi, slotId, slotIndex, slotW, slotH, border, borderW, borderRadius,
    shadowEnabled, shadowOffsetX, shadowOffsetY, shadowBlur, shadowOpacity }) => {
    const raw = pagesDataMap[pi]?.photos?.[String(slotId)] ?? null;
    const photo = normalizePhotoData(raw);
    const transform = { scale: photo?.scale ?? 1.0, offsetX: photo?.offsetX ?? 0, offsetY: photo?.offsetY ?? 0 };
    return {
      pi, slotId, slotIndex, slotW: slotW ?? 400, slotH: slotH ?? 400,
      border: border ?? false, borderW: borderW ?? 8, borderRadius: borderRadius ?? 0,
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

// 計算照片顯示尺寸（cover fill + 使用者縮放）
export function photoDims(cropW, cropH, imgAspect, scale) {
  const cropAspect = cropW / cropH;
  let baseW, baseH;
  if (imgAspect > cropAspect) { baseH = cropH; baseW = cropH * imgAspect; }
  else                         { baseW = cropW; baseH = cropW / imgAspect; }
  return { w: Math.max(cropW, baseW * scale), h: Math.max(cropH, baseH * scale) };
}

// 限制平移範圍不超出可見區域
export function clampPan(px, py, cropW, cropH, imgAspect, scale) {
  const { w, h } = photoDims(cropW, cropH, imgAspect, scale);
  const sx = Math.max(0, (w - cropW) / 2);
  const sy = Math.max(0, (h - cropH) / 2);
  return { panX: Math.max(-sx, Math.min(sx, px)), panY: Math.max(-sy, Math.min(sy, py)) };
}
