import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { X, RefreshCw, Images, ZoomIn, ZoomOut, RotateCcw, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { uploadPhoto, updatePhotoMapping } from "../api";
import toast from "react-hot-toast";
import SlotFramePreview from "./SlotFramePreview";
import PhotoSlotCard from "./PhotoSlotCard";
import { buildItems, photoDims, clampPan } from "../utils/photoUtils";

const photoApiUrl = (projectId, studentId, pi, slotId) =>
  `/api/projects/${projectId}/students/${studentId}/pages/${pi}/photos/${slotId}`;


// ── 照片編輯 Modal ────────────────────────────────────────────────────────────

function PhotoEditModal({
  editModal, items, displayUrl,
  editModalRef, cropElRef, editDragRef,
  onCropMouseDown, onCropTouchStart, onCropTouchMove, onEditImgLoad,
  onApply, onAdjustZoom, setEditModal,
}) {
  // Non-passive wheel handler — 必須用 addEventListener 才能 preventDefault
  useEffect(() => {
    const el = cropElRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const m = editModalRef.current;
      if (!m?.imgAspect) return;
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      const newScale = parseFloat(Math.max(1.0, Math.min(3.0, m.scale + delta)).toFixed(3));
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
  const { cropW, cropH, scale, panX, panY, imgAspect } = editModal;
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
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden w-full sm:w-auto"
        style={{ maxHeight: "95dvh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-900 text-sm">編輯照片 — P{it.pi+1} 格{it.slotIndex + 1}</div>
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
          ref={cropElRef}
          onMouseDown={onCropMouseDown}
          onTouchStart={onCropTouchStart}
          onTouchMove={onCropTouchMove}
          style={{
            width: cropW, height: cropH, flexShrink: 0,
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
              onClick={() => onAdjustZoom(-0.1)}
              className="w-7 h-7 bg-white border border-gray-200 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
              <ZoomOut className="w-3.5 h-3.5 text-gray-600" />
            </button>
            <input
              type="range" min="1.0" max="3.0" step="0.02"
              value={scale}
              onChange={handleSliderChange}
              className="flex-1 accent-violet-500"
            />
            <button
              onClick={() => onAdjustZoom(0.1)}
              className="w-7 h-7 bg-white border border-gray-200 rounded-lg flex items-center justify-center hover:bg-gray-100 transition-colors"
            >
              <ZoomIn className="w-3.5 h-3.5 text-gray-600" />
            </button>
            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
              {scale.toFixed(2)}×
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
          <button
            onClick={() => setEditModal(prev => prev ? { ...prev, scale: 1.0, panX: 0, panY: 0 } : prev)}
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
              onClick={onApply}
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


export default function PhotoManager({ projectId, studentId, pages, student, onSaved, onPhotoSaved, disabled = false, skippedPages = new Set() }) {
  const allSlots = useMemo(() =>
    pages.flatMap((p, pi) =>
      (p.layout?.photo_slots || []).map((s, slotIndex) => ({
        pi, slotId: s.id, slotIndex,
        slotW: s.width, slotH: s.height,
        border: s.border ?? false, borderW: s.border_width ?? 8,
        borderRadius: s.border_radius ?? 0,
        shadowEnabled: s.shadow_enabled,
        shadowOffsetX: s.shadow_offset_x, shadowOffsetY: s.shadow_offset_y,
        shadowBlur: s.shadow_blur, shadowOpacity: s.shadow_opacity,
      }))
    )
  , [pages]);

  const [items, setItems] = useState(() => buildItems(allSlots, student));
  // aspectMap[rk] = naturalW/naturalH — set on img onLoad or for cached images
  const [aspectMap, setAspectMap] = useState({});
  const thumbImgRefs = useRef({});
  // editModal: null | { idx, scale, panX, panY, imgAspect, cropW, cropH }
  const [editModal, setEditModal] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const dragIdxRef = useRef(null);
  const [selectedIdx, setSelectedIdx] = useState(null); // mobile tap-to-select
  // uploadProgress: null = 閒置，0-100 = 上傳中
  const [uploadProgress, setUploadProgress] = useState(null);
  const [isTouchDevice] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(hover: none)").matches
  );

  const multiRef = useRef(null);
  const replaceRefs = useRef({});
  const editDragRef = useRef({ dragging: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0 });
  const editModalRef = useRef(null);
  const cropElRef = useRef(null);

  // Keep ref in sync for wheel handler
  useEffect(() => { editModalRef.current = editModal; }, [editModal]);

  // Refs for auto-save (avoid stale closures)
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  const onPhotoSavedRef = useRef(onPhotoSaved);
  useEffect(() => { onPhotoSavedRef.current = onPhotoSaved; }, [onPhotoSaved]);
  const autoSaveTimerRef = useRef(null);

  // Debounced auto-save: fires 300ms after last items change
  useEffect(() => {
    const hasDirty = items.some(it =>
      it.pendingFile !== null || it.serverPath !== it.origServerPath ||
      Math.abs(it.transform.scale - it.origTransform.scale) > 0.001 ||
      Math.abs(it.transform.offsetX - it.origTransform.offsetX) > 0.001 ||
      Math.abs(it.transform.offsetY - it.origTransform.offsetY) > 0.001
    );
    if (!hasDirty || !studentId) return;
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      const cur = itemsRef.current; // snapshot at fire time
      try {
        // Upload pending files, track returned server paths
        const uploadedPaths = {};
        const pendingIndices = cur.map((it, i) => it.pendingFile ? i : -1).filter(i => i >= 0);
        if (pendingIndices.length) setUploadProgress(0);
        for (let fileNo = 0; fileNo < pendingIndices.length; fileNo++) {
          const i = pendingIndices[fileNo];
          const res = await uploadPhoto(
            projectId, studentId, cur[i].pi, cur[i].slotId, cur[i].pendingFile,
            pct => setUploadProgress(Math.round((fileNo * 100 + pct) / pendingIndices.length))
          );
          uploadedPaths[i] = res.data.path;
        }
        // Save mapping for moved / transform-changed items (skip pending — just uploaded)
        const pagesMap = {};
        for (const it of cur) {
          if (it.pendingFile) continue;
          const dirty =
            it.serverPath !== it.origServerPath ||
            Math.abs(it.transform.scale - it.origTransform.scale) > 0.001 ||
            Math.abs(it.transform.offsetX - it.origTransform.offsetX) > 0.001 ||
            Math.abs(it.transform.offsetY - it.origTransform.offsetY) > 0.001;
          if (!dirty) continue;
          if (!pagesMap[it.pi]) pagesMap[it.pi] = {};
          pagesMap[it.pi][String(it.slotId)] = it.serverPath === null ? null : {
            path: it.serverPath, scale: it.transform.scale,
            offset_x: it.transform.offsetX, offset_y: it.transform.offsetY,
          };
        }
        // 儲存 mapping；若有重命名，後端回傳 renames 讓前端同步 serverPath
        let renames = {};
        if (Object.keys(pagesMap).length) {
          const res = await updatePhotoMapping(projectId, studentId, pagesMap);
          renames = res.data.renames || {};
        }

        // Sync orig values in-place so dirty flags clear without a full load().
        // This prevents the parent's load() → buildItems() from reverting changes
        // the user made between when the auto-save fired and when it completed.
        setItems(prev => prev.map((it, i) => {
          const snap = cur[i];
          if (!snap) return it;
          if (snap.pendingFile !== null && uploadedPaths[i] !== undefined) {
            // Guard: ignore if the user already replaced the file mid-upload
            if (it.pendingFile !== snap.pendingFile) return it;
            return {
              ...it,
              pendingFile: null,
              serverPath: uploadedPaths[i],
              origServerPath: uploadedPaths[i],
              origPi: snap.pi,
              origSlotId: snap.slotId,
              origTransform: { ...snap.transform },
            };
          }
          if (snap.pendingFile !== null) return it; // upload was attempted but failed
          // 若後端重命名了此 slot 的照片，同步更新 serverPath 避免下次存檔送出舊路徑
          const renamedPath = renames[String(snap.pi)]?.[String(snap.slotId)];
          const syncedPath = renamedPath ?? snap.serverPath;
          return { ...it, serverPath: syncedPath, origServerPath: syncedPath, origTransform: { ...snap.transform } };
        }));

        onPhotoSavedRef.current?.(); // lightweight: just refresh preview timestamp
      } catch (_) { /* silent — manual save remains available */ } finally {
        setUploadProgress(null);
      }
    }, 300);
  }, [items, studentId, projectId]);

  // 縮放調整（ZoomIn/Out 按鈕共用，delta 為正放大、負縮小）
  const adjustZoom = useCallback((delta) => {
    const m = editModalRef.current;
    if (!m?.imgAspect) return;
    const newScale = parseFloat(Math.max(1.0, Math.min(3.0, m.scale + delta)).toFixed(3));
    const ratio = newScale / m.scale;
    const { panX, panY } = clampPan(m.panX * ratio, m.panY * ratio, m.cropW, m.cropH, m.imgAspect, newScale);
    setEditModal(prev => prev ? { ...prev, scale: newScale, panX, panY } : prev);
  }, []);

  // Global mouse move/up for drag
  useEffect(() => {
    if (!editModal) return;
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
  }, [!!editModal]);

  // Re-init when student changes
  useEffect(() => {
    setItems(prev => {
      prev.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
      return buildItems(allSlots, student);
    });
    setAspectMap({});
    setEditModal(null);
    setSelectedIdx(null);
  }, [student, allSlots]);

  // Handle cached images: onLoad won't fire if img is already complete
  useEffect(() => {
    const map = {};
    Object.entries(thumbImgRefs.current).forEach(([rk, img]) => {
      if (img && img.complete && img.naturalWidth > 0) {
        map[rk] = img.naturalWidth / img.naturalHeight;
      }
    });
    if (Object.keys(map).length > 0) {
      setAspectMap(prev => ({ ...map, ...prev }));
    }
  }, [items]);

  useEffect(() => () => {
    setItems(prev => { prev.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); }); return prev; });
  }, []);

  // ── Dirty detection ───────────────────────────────────────────────────────
  const transformDirty = (it) =>
    Math.abs(it.transform.scale - it.origTransform.scale) > 0.001 ||
    Math.abs(it.transform.offsetX - it.origTransform.offsetX) > 0.001 ||
    Math.abs(it.transform.offsetY - it.origTransform.offsetY) > 0.001;

  const isDirty = (it) =>
    it.pendingFile !== null || it.serverPath !== it.origServerPath || transformDirty(it);
  const hasDirty = items.some(isDirty);

  const displayUrl = (it) => {
    if (it.previewUrl) return it.previewUrl;
    if (it.serverPath !== null && it.origPi !== null)
      return photoApiUrl(projectId, studentId, it.origPi, it.origSlotId);
    return null;
  };

  // ── File helpers ──────────────────────────────────────────────────────────
  function assignFile(arr, i, file) {
    if (arr[i].previewUrl) URL.revokeObjectURL(arr[i].previewUrl);
    arr[i] = { ...arr[i], pendingFile: file, previewUrl: URL.createObjectURL(file),
      serverPath: null, origPi: null, origSlotId: null, transform: { scale: 1.0, offsetX: 0, offsetY: 0 } };
  }

  const handleMultiUpload = (files) => {
    const arr = Array.from(files);
    setItems(prev => {
      const next = prev.map(it => ({ ...it }));
      let fi = 0;
      for (let i = 0; i < next.length && fi < arr.length; i++)
        if (!next[i].pendingFile && !next[i].serverPath) assignFile(next, i, arr[fi++]);
      for (let i = 0; i < next.length && fi < arr.length; i++)
        if (next[i].pendingFile || next[i].serverPath) assignFile(next, i, arr[fi++]);
      return next;
    });
  };

  const handleReplace = (idx, file) => {
    setItems(prev => {
      const next = [...prev];
      const it = { ...next[idx] };
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      next[idx] = { ...it, pendingFile: file, previewUrl: URL.createObjectURL(file),
        serverPath: null, origPi: null, origSlotId: null, transform: { scale: 1.0, offsetX: 0, offsetY: 0 } };
      return next;
    });
    setEditModal(null);
  };

  const handleDelete = (idx) => {
    setItems(prev => {
      const next = [...prev];
      const it = { ...next[idx] };
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      next[idx] = { ...it, pendingFile: null, previewUrl: null, serverPath: null,
        origPi: null, origSlotId: null, transform: { scale: 1.0, offsetX: 0, offsetY: 0 } };
      return next;
    });
    setEditModal(null);
  };

  const handleSwap = (i, j) => {
    if (i === j || i == null || j == null) return;
    setItems(prev => {
      const next = [...prev];
      const a = prev[i], b = prev[j];
      next[i] = { ...a, origPi: b.origPi, origSlotId: b.origSlotId, serverPath: b.serverPath,
        pendingFile: b.pendingFile, previewUrl: b.previewUrl, transform: { ...b.transform } };
      next[j] = { ...b, origPi: a.origPi, origSlotId: a.origSlotId, serverPath: a.serverPath,
        pendingFile: a.pendingFile, previewUrl: a.previewUrl, transform: { ...a.transform } };
      return next;
    });
  };

  // ── Drag-and-drop handlers ────────────────────────────────────────────────
  const handleDragStart = (e, idx) => {
    dragIdxRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIdxRef.current !== idx) setDragOverIdx(idx);
  };
  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverIdx(null);
  };
  const handleDrop = (e, idx) => {
    e.preventDefault();
    const from = dragIdxRef.current;
    dragIdxRef.current = null;
    setDragOverIdx(null);
    if (from !== null && from !== idx) handleSwap(from, idx);
  };
  const handleDragEnd = () => {
    dragIdxRef.current = null;
    setDragOverIdx(null);
  };

  const updateTransform = (idx, t) =>
    setItems(prev => { const n = [...prev]; n[idx] = { ...n[idx], transform: { ...n[idx].transform, ...t } }; return n; });


  // ── Edit modal ────────────────────────────────────────────────────────────
  const openEditModal = (idx) => {
    const it = items[idx];
    if (!displayUrl(it)) return;
    // Responsive crop area: cap to viewport
    const vw = Math.min(window.innerWidth - 32, 460);
    const CROP_MAX_W = vw, CROP_MAX_H = Math.round(window.innerHeight * 0.55);
    const bw = it.border ? it.borderW : 0;
    const effectiveW = it.slotW - bw * 2;
    const effectiveH = it.slotH - bw * 4;
    const rawAspect = effectiveH / effectiveW;
    const cropW = rawAspect > CROP_MAX_H / CROP_MAX_W
      ? Math.round(CROP_MAX_H / rawAspect) : CROP_MAX_W;
    const cropH = Math.round(cropW * rawAspect);
    setEditModal({ idx, scale: it.transform.scale, panX: 0, panY: 0, imgAspect: null, cropW, cropH });
  };

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
    const { idx, scale, panX, panY, imgAspect, cropW, cropH } = m;
    const { w, h } = photoDims(cropW, cropH, imgAspect, scale);
    const sx = (w - cropW) / 2, sy = (h - cropH) / 2;
    updateTransform(idx, {
      scale,
      offsetX: Math.max(-1, Math.min(1, sx > 0 ? -panX / sx : 0)),
      offsetY: Math.max(-1, Math.min(1, sy > 0 ? -panY / sy : 0)),
    });
    setEditModal(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const filledCount = items.filter(it => displayUrl(it)).length;


  return (
    <div className="w-full bg-white border border-gray-200 rounded-2xl p-5 shadow-sm overflow-hidden">
      {/* Edit Modal */}
      {editModal && (
        <PhotoEditModal
          editModal={editModal}
          items={items}
          displayUrl={displayUrl}
          editModalRef={editModalRef}
          cropElRef={cropElRef}
          editDragRef={editDragRef}
          onCropMouseDown={onCropMouseDown}
          onCropTouchStart={onCropTouchStart}
          onCropTouchMove={onCropTouchMove}
          onEditImgLoad={onEditImgLoad}
          onApply={applyEditModal}
          onAdjustZoom={adjustZoom}
          setEditModal={setEditModal}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Images className="w-4 h-4 text-amber-500" />
        <h3 className="font-semibold text-gray-800 text-sm">照片管理</h3>
        <span className="text-xs text-gray-400">
          {filledCount} / {allSlots.length} 格
          {uploadProgress !== null
            ? <span className="text-indigo-600 ml-1">↑ 上傳中 {uploadProgress}%</span>
            : hasDirty && <span className="text-amber-600 ml-1">● 未儲存</span>
          }
        </span>
        <div className="ml-auto flex gap-2" style={{ visibility: disabled ? "hidden" : "visible" }}>
          <button
            onClick={() => multiRef.current?.click()}
            className="flex items-center gap-1.5 text-sm bg-indigo-50 text-indigo-700 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors font-medium"
          >
            <Upload className="w-3.5 h-3.5" />
            多選上傳
          </button>
          <input ref={multiRef} type="file" accept="image/*" multiple className="hidden"
            onChange={e => { if (e.target.files?.length) { handleMultiUpload(e.target.files); e.target.value = ""; } }} />
        </div>
      </div>

      {/* Upload progress bar */}
      {uploadProgress !== null && (
        <div className="w-full h-1 bg-gray-100 rounded-full mb-3 overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-200"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
      )}

      {/* Photo grid */}
      <div
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 2xl:grid-cols-5 gap-3"
        onClick={e => {
          // Tap outside any cell deselects on touch
          if (isTouchDevice && e.target === e.currentTarget) setSelectedIdx(null);
        }}
      >
        {items.map((it, idx) => {
          const url = displayUrl(it);
          const dirty = isDirty(it);
          const rk = `${it.pi}_${it.slotId}`;
          const isDragOver = dragOverIdx === idx && dragIdxRef.current !== idx;
          const nat = aspectMap[rk];
          const isSelected = isTouchDevice && selectedIdx === idx;
          const isItemDisabled = disabled || skippedPages.has(it.pi);

          const handleCellClick = () => {
            if (isItemDisabled) return;
            if (isTouchDevice) {
              if (!url) { replaceRefs.current[rk]?.click(); return; }
              setSelectedIdx(prev => prev === idx ? null : idx);
            } else {
              if (!url) replaceRefs.current[rk]?.click();
            }
          };

          return (
            <div
              key={rk}
              draggable={!!url && !isItemDisabled && !isTouchDevice}
              onDragStart={e => handleDragStart(e, idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDragLeave={handleDragLeave}
              onDrop={e => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              onClick={handleCellClick}
              className="group aspect-square relative flex items-center justify-center rounded-xl transition-all"
              style={{
                background: isItemDisabled ? "#f8fafc" : isSelected ? "rgba(99,102,241,0.1)" : isDragOver ? "rgba(99,102,241,0.08)" : dirty ? "rgba(251,191,36,0.08)" : "#f3f4f6",
                outline: isItemDisabled ? "2px dashed #e2e8f0" : isSelected ? "2px solid #6366f1" : isDragOver ? "2px solid #6366f1" : dirty ? "2px solid #fbbf24" : "2px solid transparent",
                cursor: isItemDisabled ? "default" : (url && !isTouchDevice ? "grab" : "pointer"),
                opacity: isItemDisabled ? 0.5 : 1,
              }}
            >
              {/* Pure display */}
              <PhotoSlotCard
                it={it} url={url} nat={nat} disabled={isItemDisabled}
                onImgLoad={e => setAspectMap(prev => ({ ...prev, [rk]: e.target.naturalWidth / e.target.naturalHeight }))}
                imgRefCallback={el => { thumbImgRefs.current[rk] = el; }}
              />

              {/* 已刪除頁面遮罩 */}
              {skippedPages.has(it.pi) && (
                <div className="absolute inset-0 rounded-xl flex items-end justify-center pb-1 pointer-events-none">
                  <span className="text-[9px] text-red-400 bg-white/80 px-1 rounded">已刪除</span>
                </div>
              )}

              {/* Desktop hover overlay */}
              {url && !isItemDisabled && !isTouchDevice && (
                <div className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 pointer-events-none">
                  <div className="pointer-events-auto flex gap-1.5">
                    <button onClick={e => { e.stopPropagation(); openEditModal(idx); }} title="位移/縮放"
                      className="w-7 h-7 bg-white/20 hover:bg-white/40 rounded-lg flex items-center justify-center transition-colors">
                      <ZoomIn className="w-3 h-3 text-white" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); replaceRefs.current[rk]?.click(); }} title="更換"
                      className="w-7 h-7 bg-white/20 hover:bg-white/40 rounded-lg flex items-center justify-center transition-colors">
                      <RefreshCw className="w-3 h-3 text-white" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleDelete(idx); }} title="刪除"
                      className="w-7 h-7 bg-red-500/70 hover:bg-red-600 rounded-lg flex items-center justify-center transition-colors">
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                </div>
              )}

              {/* Mobile tap-selected overlay */}
              {url && !isItemDisabled && isTouchDevice && isSelected && (
                <div className="absolute inset-0 rounded-xl bg-black/55 flex flex-col items-center justify-center gap-2">
                  {/* Top row: move left / move right */}
                  <div className="flex gap-2">
                    <button
                      onClick={e => { e.stopPropagation(); if (idx > 0) { handleSwap(idx, idx - 1); setSelectedIdx(idx - 1); } }}
                      disabled={idx === 0}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center disabled:opacity-30 transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4 text-white" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); if (idx < items.length - 1) { handleSwap(idx, idx + 1); setSelectedIdx(idx + 1); } }}
                      disabled={idx === items.length - 1}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="w-4 h-4 text-white" />
                    </button>
                  </div>
                  {/* Bottom row: edit / replace / delete */}
                  <div className="flex gap-2">
                    <button onClick={e => { e.stopPropagation(); setSelectedIdx(null); openEditModal(idx); }}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center transition-colors">
                      <ZoomIn className="w-4 h-4 text-white" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); replaceRefs.current[rk]?.click(); }}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center transition-colors">
                      <RefreshCw className="w-4 h-4 text-white" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleDelete(idx); setSelectedIdx(null); }}
                      className="w-9 h-9 bg-red-500/70 active:bg-red-600 rounded-xl flex items-center justify-center transition-colors">
                      <X className="w-4 h-4 text-white" />
                    </button>
                  </div>
                </div>
              )}

              {/* Slot label */}
              <div className="absolute bottom-1 left-0 right-0 text-center text-[10px] text-gray-400 pointer-events-none select-none">
                P{it.pi + 1}·{it.slotIndex + 1}
              </div>

              {/* File input lives in the cell, not the card */}
              <input ref={el => { replaceRefs.current[rk] = el; }}
                type="file" accept="image/*" className="hidden"
                onChange={e => { if (e.target.files?.[0]) { handleReplace(idx, e.target.files[0]); e.target.value = ""; } }} />
            </div>
          );
        })}
      </div>

    </div>
  );
}
