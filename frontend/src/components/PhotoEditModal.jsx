// 照片編輯 Modal（位移 / 縮放 / 亮度 / 對比）
//   usePhotoEditModal：管理 modal state 與所有互動 handler（滾輪、拖曳、觸控、套用），
//   對呼叫端只暴露 openEditModal(idx) / closeEditModal / applyEditModal 等最小介面；
//   套用時透過 onApplyTransform(idx, transform) 回寫，items 的更新邏輯留在呼叫端。

import { useCallback, useEffect, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { PHOTO_SCALE_MAX } from "../constants/photoTransform.js";
import { photoDims, clampPan, getPhotoCropBox, buildPhotoFilterCss } from "../utils/photoUtils";
import useDialogA11y from "../hooks/useDialogA11y";

// eslint-disable-next-line react-refresh/only-export-components -- hook 與 Modal 同檔是刻意的打包
export function usePhotoEditModal({ items, displayUrl, onApplyTransform }) {
  // editModal: null | { idx, scale, panX, panY, imgAspect, cropW, cropH, brightness, contrast }
  const [editModal, setEditModal] = useState(null);
  const editDragRef = useRef({ dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 });
  const editModalRef = useRef(null);
  const cropElRef = useRef(null);

  // Keep ref in sync for wheel handler
  useEffect(() => { editModalRef.current = editModal; }, [editModal]);

  // 縮放調整（ZoomIn/Out 按鈕共用，delta 為正放大、負縮小）
  const adjustZoom = useCallback((delta) => {
    const m = editModalRef.current;
    if (!m?.imgAspect) return;
    const newScale = parseFloat(
      Math.max(1.0, Math.min(PHOTO_SCALE_MAX, m.scale + delta)).toFixed(3),
    );
    const ratio = newScale / m.scale;
    const { panX, panY } = clampPan(m.panX * ratio, m.panY * ratio, m.cropW, m.cropH, m.imgAspect, newScale);
    setEditModal(prev => prev ? { ...prev, scale: newScale, panX, panY } : prev);
  }, []);

  // Global mouse move/up for drag
  const isEditModalOpen = editModal !== null;
  useEffect(() => {
    if (!isEditModalOpen) return;
    const onMove = (e) => {
      if (!editDragRef.current.dragging) return;
      const m = editModalRef.current;
      if (!m?.imgAspect) return;
      const dx = e.clientX - editDragRef.current.startX;
      const dy = e.clientY - editDragRef.current.startY;
      const { panX, panY } = clampPan(
        editDragRef.current.startPanX + dx,
        editDragRef.current.startPanY + dy,
        m.cropW, m.cropH, m.imgAspect, m.scale
      );
      setEditModal(prev => prev ? { ...prev, panX, panY } : prev);
    };
    const onUp = () => { editDragRef.current.dragging = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [isEditModalOpen]);

  const openEditModal = (idx) => {
    const it = items[idx];
    if (!displayUrl(it)) return;
    // Responsive crop area: cap to viewport
    const vw = Math.min(window.innerWidth - 32, 460);
    const CROP_MAX_W = vw, CROP_MAX_H = Math.round(window.innerHeight * 0.55);
    const cropBox = getPhotoCropBox(it);
    const effectiveW = cropBox.width;
    const effectiveH = cropBox.height;
    const rawAspect = effectiveH / effectiveW;
    const cropW = rawAspect > CROP_MAX_H / CROP_MAX_W
      ? Math.round(CROP_MAX_H / rawAspect) : CROP_MAX_W;
    const cropH = Math.round(cropW * rawAspect);
    setEditModal({
      idx, scale: it.transform.scale, panX: 0, panY: 0, imgAspect: null, cropW, cropH,
      brightness: it.transform.brightness,
      contrast: it.transform.contrast,
    });
  };

  const closeEditModal = useCallback(() => setEditModal(null), []);

  const onEditImgLoad = (e) => {
    const imgAspect = e.target.naturalWidth / e.target.naturalHeight;
    const m = editModalRef.current;
    if (!m) return;
    const it = items[m.idx];
    const { w, h } = photoDims(m.cropW, m.cropH, imgAspect, m.scale);
    const sx = (w - m.cropW) / 2, sy = (h - m.cropH) / 2;
    setEditModal(prev => prev ? {
      ...prev, imgAspect,
      panX: -it.transform.offsetX * sx,
      panY: -it.transform.offsetY * sy,
    } : prev);
  };

  const onCropMouseDown = (e) => {
    e.preventDefault();
    const m = editModalRef.current;
    if (!m) return;
    editDragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY,
      startPanX: m.panX, startPanY: m.panY };
  };

  const onCropTouchStart = (e) => {
    const touch = e.touches[0];
    const m = editModalRef.current;
    if (!m) return;
    editDragRef.current = { dragging: true, startX: touch.clientX, startY: touch.clientY,
      startPanX: m.panX, startPanY: m.panY };
  };

  const onCropTouchMove = (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const d = editDragRef.current;
    const m = editModalRef.current;
    if (!d?.dragging || !m?.imgAspect) return;
    const dx = touch.clientX - d.startX;
    const dy = touch.clientY - d.startY;
    const { panX, panY } = clampPan(d.startPanX + dx, d.startPanY + dy, m.cropW, m.cropH, m.imgAspect, m.scale);
    setEditModal(prev => prev ? { ...prev, panX, panY } : prev);
  };

  const applyEditModal = () => {
    const m = editModalRef.current;
    if (!m?.imgAspect) return;
    const { idx, scale, panX, panY, imgAspect, cropW, cropH, brightness, contrast } = m;
    const { w, h } = photoDims(cropW, cropH, imgAspect, scale);
    const sx = (w - cropW) / 2, sy = (h - cropH) / 2;
    onApplyTransform(idx, {
      scale,
      offsetX: Math.max(-1, Math.min(1, sx > 0 ? -panX / sx : 0)),
      offsetY: Math.max(-1, Math.min(1, sy > 0 ? -panY / sy : 0)),
      brightness,
      contrast,
    });
    setEditModal(null);
  };

  return {
    editModal, setEditModal,
    editModalRef, editDragRef, cropElRef,
    openEditModal, closeEditModal,
    onEditImgLoad, onCropMouseDown, onCropTouchStart, onCropTouchMove,
    applyEditModal, adjustZoom,
  };
}

export default function PhotoEditModal({ edit, items, displayUrl }) {
  const {
    editModal, setEditModal,
    editModalRef, cropElRef, editDragRef,
    onCropMouseDown, onCropTouchStart, onCropTouchMove, onEditImgLoad,
    applyEditModal, adjustZoom,
  } = edit;
  const dialogRef = useDialogA11y({ onClose: () => setEditModal(null) });

  // Non-passive wheel handler — 必須用 addEventListener 才能 preventDefault
  useEffect(() => {
    const el = cropElRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const m = editModalRef.current;
      if (!m?.imgAspect) return;
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      const newScale = parseFloat(
        Math.max(1.0, Math.min(PHOTO_SCALE_MAX, m.scale + delta)).toFixed(3),
      );
      const ratio = newScale / m.scale;
      const { panX, panY } = clampPan(m.panX * ratio, m.panY * ratio, m.cropW, m.cropH, m.imgAspect, newScale);
      setEditModal(prev => prev ? { ...prev, scale: newScale, panX, panY } : prev);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }); // run every render so cropElRef stays current

  const handleSliderChange = (e) => {
    const m = editModalRef.current;
    const newScale = parseFloat(e.target.value);
    if (!m?.imgAspect) { setEditModal(prev => prev ? { ...prev, scale: newScale } : prev); return; }
    const ratio = newScale / m.scale;
    const { panX, panY } = clampPan(m.panX * ratio, m.panY * ratio, m.cropW, m.cropH, m.imgAspect, newScale);
    setEditModal(prev => prev ? { ...prev, scale: newScale, panX: panX, panY: panY } : prev);
  };

  const it = items[editModal.idx];
  const url = displayUrl(it);
  const { cropW, cropH, scale, panX, panY, imgAspect, brightness, contrast } = editModal;
  const dims = imgAspect ? photoDims(cropW, cropH, imgAspect, scale) : null;
  const photoLeft = dims ? (cropW - dims.w) / 2 + panX : 0;
  const photoTop  = dims ? (cropH - dims.h) / 2 + panY : 0;

  return (
    <div
      className="fixed inset-0 bg-black/75 z-50 flex items-end sm:items-center justify-center backdrop-blur-sm"
      onMouseUp={() => { editDragRef.current.dragging = false; }}
      onTouchEnd={() => { editDragRef.current.dragging = false; }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="編輯照片"
        data-guide="photo-edit-modal"
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden w-full sm:w-auto"
        style={{ maxHeight: "95dvh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-900 text-sm">編輯照片 — 第{it.pi + 1}頁 格{it.slotIndex + 1}</div>
            <div className="text-xs text-gray-400 mt-0.5">拖曳移動 · 滾輪縮放</div>
          </div>
          <button
            onClick={() => setEditModal(null)}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Crop area */}
        <div
          data-guide="photo-edit-crop"
          ref={cropElRef}
          onMouseDown={onCropMouseDown}
          onTouchStart={onCropTouchStart}
          onTouchMove={onCropTouchMove}
          style={{
            width: cropW, height: cropH, flexShrink: 0,
            alignSelf: "center",
            overflow: "hidden", position: "relative",
            background: "#1a1a1a",
            cursor: imgAspect ? "grab" : "default",
            touchAction: "none",
          }}
        >
          {url && (
            <img
              src={url} alt="" draggable={false}
              onLoad={onEditImgLoad}
              style={{
                position: "absolute",
                width: dims?.w ?? "100%", height: dims?.h ?? "100%",
                maxWidth: "none", maxHeight: "none",
                left: photoLeft, top: photoTop,
                userSelect: "none", pointerEvents: "none",
                opacity: imgAspect ? 1 : 0,
                transition: "opacity 0.15s",
                // 與後端 PIL 渲染同公式的即時預覽（見 buildPhotoFilterCss）
                filter: buildPhotoFilterCss(brightness, contrast) ?? "none",
              }}
            />
          )}
          {!imgAspect && (
            <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm">
              載入中...
            </div>
          )}
        </div>

        {/* Zoom control */}
        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center gap-3">
            <button
              onClick={() => adjustZoom(-0.1)}
              className="w-7 h-7 bg-white border border-gray-200 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5 text-gray-600" />
            </button>
            <input
              type="range" min="1.0" max={PHOTO_SCALE_MAX} step="0.02"
              value={scale}
              onChange={handleSliderChange}
              className="flex-1 accent-violet-500"
            />
            <button
              onClick={() => adjustZoom(0.1)}
              className="w-7 h-7 bg-white border border-gray-200 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5 text-gray-600" />
            </button>
            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
              {scale.toFixed(2)}×
            </span>
          </div>

          {/* 亮度 / 對比 */}
          <div className="mt-2.5 flex items-center gap-3">
            <span className="w-8 text-xs text-gray-500">亮度</span>
            <input
              type="range" min="0.5" max="1.5" step="0.01"
              value={brightness}
              onChange={e => {
                const value = parseFloat(e.target.value);
                setEditModal(prev => prev ? { ...prev, brightness: value } : prev);
              }}
              className="flex-1 accent-amber-500"
            />
            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
              {brightness >= 1 ? "+" : ""}{Math.round((brightness - 1) * 100)}%
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <span className="w-8 text-xs text-gray-500">對比</span>
            <input
              type="range" min="0.5" max="1.5" step="0.01"
              value={contrast}
              onChange={e => {
                const value = parseFloat(e.target.value);
                setEditModal(prev => prev ? { ...prev, contrast: value } : prev);
              }}
              className="flex-1 accent-sky-500"
            />
            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
              {contrast >= 1 ? "+" : ""}{Math.round((contrast - 1) * 100)}%
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
          <button
            onClick={() => setEditModal(prev => prev ? { ...prev, scale: 1.0, panX: 0, panY: 0, brightness: 1, contrast: 1 } : prev)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重置
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => setEditModal(null)}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={applyEditModal}
              disabled={!imgAspect}
              className="px-4 py-2 text-sm bg-violet-600 text-white rounded-xl hover:bg-violet-700 disabled:opacity-40 transition-colors"
            >
              套用
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
