import { Fragment, useState, useRef, useEffect, useMemo } from "react";
import { DndContext, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import { X, RefreshCw, Images, ZoomIn, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import toast from "react-hot-toast";
import { uploadPhoto, updatePhotoMapping } from "../api";
import { buildPhotoThumbnailUrl, buildPhotoUrl } from "../api/urls";
import ConfirmModal from "./ConfirmModal";
import { Button, SegmentedControl } from "./ui";
import PhotoSlotCard from "./PhotoSlotCard";
import PhotoEditModal, { usePhotoEditModal } from "./PhotoEditModal";
import { buildItems } from "../utils/photoUtils";
import { maybeCompressImageFile } from "../utils/imageCompression";
import { runWithConcurrency } from "../utils/concurrency";
import { isRetryableUploadError, retryDelayMs } from "../utils/uploadRetry";
import { getPhotoSlotDimensionMode } from "../utils/photoFrameGeometry.js";
import { useDndPhotoSensors } from "../hooks/useDndPhotoSensors";
import { getVisibleLayoutElements } from "../utils/layoutLayerState.js";

const PHOTO_UPLOAD_PARALLEL_LIMIT = 2;

// 照片格重置（清空/替換/刪除）用的預設 transform；buildItems 產生的 item 一律
// 帶齊這五個欄位，reset 位置也必須帶齊，否則下游要靠散落的 `?? 1` 補洞
const DEFAULT_PHOTO_TRANSFORM = { scale: 1.0, offsetX: 0, offsetY: 0, brightness: 1.0, contrast: 1.0 };

// 兩個 transform 是否需要重新儲存（scale / 位移 / 亮度 / 對比任一改變）
function isTransformDirty(transform, origTransform) {
  return (
    Math.abs(transform.scale - origTransform.scale) > 0.001 ||
    Math.abs(transform.offsetX - origTransform.offsetX) > 0.001 ||
    Math.abs(transform.offsetY - origTransform.offsetY) > 0.001 ||
    Math.abs((transform.brightness ?? 1) - (origTransform.brightness ?? 1)) > 0.001 ||
    Math.abs((transform.contrast ?? 1) - (origTransform.contrast ?? 1)) > 0.001
  );
}

// dnd-kit 包裝：照片格同時是拖曳來源與放置目標。
// 不展開 attributes（會加 aria-disabled 誤導輔助工具），只取 listeners。
function DndCell({ cellIndex, dragDisabled, dropDisabled, children }) {
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({
    id: `photo-cell-${cellIndex}`,
    data: { cellIndex },
    disabled: dragDisabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `photo-drop-${cellIndex}`,
    data: { cellIndex },
    disabled: dropDisabled,
  });
  return children({
    dndRef: (node) => { setDragRef(node); setDropRef(node); },
    dndListeners: listeners,
    isDragging,
    isOver,
  });
}

function uploadStatusLabel(status) {
  if (!status) return "";
  if (status.phase === "processing") return "處理中";
  if (status.phase === "saving") return "儲存中";
  return "上傳中";
}

function getUploadFailureMessage(error, count = 1) {
  const detail = error?.response?.data?.detail;
  if (error?.response?.status === 413) {
    return count > 1 ? `${count} 張照片超過大小上限，請壓縮後再上傳` : (detail || "照片超過大小上限，請壓縮後再上傳");
  }
  if (detail) return count > 1 ? `${count} 張照片上傳失敗：${detail}` : detail;
  return count > 1 ? `${count} 張照片上傳失敗` : "照片上傳失敗";
}

// activePage：與預覽/文字面板同步的當前頁（null＝顯示全部頁，相容舊用法）；
// 檢視範圍可切「本頁／整本」：顯示、多選上傳與空格計算跟著檢視走，
// 整本模式可一次上傳全書照片、跨頁拖曳調換；存檔邏輯永遠涵蓋整本。
// onPageFocus：整本模式點某格時回報該頁，讓預覽/文字面板同步跳頁
export default function PhotoManager({ projectId, studentId, pages, student, onPhotoSaved, onSaveStateChange, disabled = false, skippedPages = new Set(), activePage = null, onPageFocus = null }) {
  const allSlots = useMemo(() =>
    pages.flatMap((p, pi) =>
      getVisibleLayoutElements(p.layout, "photo").map((s, slotIndex) => ({
        pi, slotId: s.id, slotIndex,
        slotW: s.width, slotH: s.height,
        dimensionMode: getPhotoSlotDimensionMode(p.layout),
        border: s.border !== false, borderW: s.border_width ?? 8,
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
  const [activeDragIndex, setActiveDragIndex] = useState(null); // dnd-kit 拖曳中的格子
  const [selectedIdx, setSelectedIdx] = useState(null); // mobile tap-to-select
  // uploadStatus: null = 閒置；otherwise { phase, percent }
  const [uploadStatus, setUploadStatus] = useState(null);
  const [photoRefreshKey, setPhotoRefreshKey] = useState(0);
  // 本次進入頁面後是否成功存過照片：給「✓ 已儲存」正向回饋（與文字面板的存檔指示對齊）
  const [hasSavedPhotos, setHasSavedPhotos] = useState(false);
  // 待確認刪除的格位索引（刪照片要重傳，先確認再刪）
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState(null);
  const [isTouchDevice] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(hover: none)").matches
  );

  const multiRef = useRef(null);
  const replaceRefs = useRef({});

  // 照片編輯 Modal：state 與所有互動 handler 都在 usePhotoEditModal（見 PhotoEditModal.jsx）。
  // displayUrl / updateTransform 宣告在本元件後段，包一層 arrow 延遲取值（handler 觸發時才呼叫）
  const photoEdit = usePhotoEditModal({
    items,
    displayUrl: (it) => displayUrl(it),
    onApplyTransform: (idx, t) => updateTransform(idx, t),
  });
  const { openEditModal, closeEditModal } = photoEdit;

  // Refs for auto-save (avoid stale closures)
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const onPhotoSavedRef = useRef(onPhotoSaved);
  useEffect(() => { onPhotoSavedRef.current = onPhotoSaved; }, [onPhotoSaved]);
  const autoSaveTimerRef = useRef(null);

  // Debounced auto-save: fires 300ms after last items change
  useEffect(() => {
    const hasDirty = items.some(it =>
      it.pendingFile !== null || it.serverPath !== it.origServerPath ||
      isTransformDirty(it.transform, it.origTransform)
    );
    if (!hasDirty || !studentId) return;
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      const cur = itemsRef.current; // snapshot at fire time
      try {
        // Upload pending files, track returned server paths
        const uploadedPaths = {};
        const uploadFailures = {};
        const pendingIndices = cur.map((it, i) => it.pendingFile ? i : -1).filter(i => i >= 0);
        if (pendingIndices.length) {
          const progressByIndex = new Map(pendingIndices.map(i => [i, 0]));
          let completedUploads = 0;

          const updateAggregateStatus = (phaseOverride) => {
            const totalProgress = [...progressByIndex.values()].reduce((sum, pct) => sum + pct, 0);
            const percent = Math.round(totalProgress / pendingIndices.length);
            const phase = phaseOverride ?? (
              percent >= 100 && completedUploads < pendingIndices.length ? "processing" : "uploading"
            );
            setUploadStatus({
              phase,
              percent,
              completed: completedUploads,
              total: pendingIndices.length,
            });
          };

          updateAggregateStatus("uploading");

          // 暫時性失敗（503 排隊滿、網路斷）自動重試——不重試的話照片會從格子消失，
          // 老師得手動重選重傳；判斷與等待時間共用 utils/uploadRetry.js
          const uploadWithRetry = async (i, fileToSend, onProgress) => {
            const maxAttempts = 3;
            for (let attempt = 1; ; attempt++) {
              try {
                return await uploadPhoto(projectId, studentId, cur[i].pi, cur[i].slotId, fileToSend, onProgress);
              } catch (error) {
                if (!isRetryableUploadError(error) || attempt >= maxAttempts) throw error;
                await new Promise(resolve => setTimeout(resolve, retryDelayMs(error)));
              }
            }
          };

          const uploadOne = async (i) => {
            try {
              // 上傳前壓縮：手機原圖 4-12MB → ~0.5-1MB，傳輸省 ~80%
              const fileToSend = await maybeCompressImageFile(cur[i].pendingFile);
              const res = await uploadWithRetry(i, fileToSend, pct => {
                progressByIndex.set(i, pct);
                updateAggregateStatus();
              });
              progressByIndex.set(i, 100);
              uploadedPaths[i] = res.data.path;
            } catch (error) {
              progressByIndex.set(i, 100);
              uploadFailures[i] = error;
            } finally {
              completedUploads += 1;
              updateAggregateStatus(completedUploads === pendingIndices.length ? "saving" : undefined);
            }
          };

          await runWithConcurrency(pendingIndices, PHOTO_UPLOAD_PARALLEL_LIMIT, uploadOne);
        }
        // Save mapping for moved / transform-changed items (skip pending — just uploaded)
        const pagesMap = {};
        for (const it of cur) {
          if (it.pendingFile) continue;
          const dirty = it.serverPath !== it.origServerPath || isTransformDirty(it.transform, it.origTransform);
          if (!dirty) continue;
          if (!pagesMap[it.pi]) pagesMap[it.pi] = {};
          pagesMap[it.pi][String(it.slotId)] = it.serverPath === null ? null : {
            path: it.serverPath, scale: it.transform.scale,
            offset_x: it.transform.offsetX, offset_y: it.transform.offsetY,
            brightness: it.transform.brightness, contrast: it.transform.contrast,
          };
        }
        // 儲存 mapping；renames 保留相容舊後端，新後端交換照片不再重命名 R2 物件
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
            if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
            return {
              ...it,
              pendingFile: null,
              previewUrl: null,
              serverPath: uploadedPaths[i],
              origServerPath: uploadedPaths[i],
              origPi: snap.pi,
              origSlotId: snap.slotId,
              origTransform: { ...snap.transform },
            };
          }
          if (snap.pendingFile !== null && uploadFailures[i]) {
            if (it.pendingFile !== snap.pendingFile) return it;
            if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
            return {
              ...it,
              pendingFile: null,
              previewUrl: null,
              serverPath: snap.origServerPath,
              origPi: snap.origPi,
              origSlotId: snap.origSlotId,
              transform: { ...snap.origTransform },
            };
          }
          if (snap.pendingFile !== null) return it; // upload was attempted but failed
          // 舊後端可能回傳重命名後路徑；新後端維持原路徑以避免 R2 copy/delete。
          const renamedPath = renames[String(snap.pi)]?.[String(snap.slotId)];
          const syncedPath = renamedPath ?? snap.serverPath;
          return {
            ...it,
            serverPath: syncedPath,
            origServerPath: syncedPath,
            origPi: syncedPath ? snap.pi : null,
            origSlotId: syncedPath ? snap.slotId : null,
            origTransform: { ...snap.transform },
          };
        }));

        if (Object.keys(uploadedPaths).length || Object.keys(pagesMap).length) {
          setPhotoRefreshKey(Date.now());
          setHasSavedPhotos(true);
          onPhotoSavedRef.current?.(); // lightweight: just refresh preview timestamp
        }
        const failureList = Object.values(uploadFailures);
        if (failureList.length) {
          toast.error(getUploadFailureMessage(failureList[0], failureList.length));
        }
      } catch (error) {
        toast.error(getUploadFailureMessage(error));
      } finally {
        setUploadStatus(null);
      }
    }, 300);
  }, [items, studentId, projectId]);

  // Re-init when student changes
  useEffect(() => {
    setItems(prev => {
      prev.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
      return buildItems(allSlots, student);
    });
    setAspectMap({});
    closeEditModal();
    setSelectedIdx(null);
  }, [student, allSlots, closeEditModal]);

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
  const isDirty = (it) =>
    it.pendingFile !== null || it.serverPath !== it.origServerPath || isTransformDirty(it.transform, it.origTransform);
  const hasDirty = items.some(isDirty);
  const isSaveBusy = hasDirty || uploadStatus !== null;

  useEffect(() => {
    onSaveStateChange?.(isSaveBusy);
    return () => onSaveStateChange?.(false);
  }, [isSaveBusy, onSaveStateChange]);

  useEffect(() => {
    if (!isSaveBusy) return undefined;
    const warnBeforeUnload = event => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isSaveBusy]);
  // 檢視範圍：page＝跟著全域頁碼、book＝整本（一次上傳全書、跨頁調換用）
  const [viewScope, setViewScope] = useState("page");
  const effectiveActivePage = viewScope === "book" ? null : activePage;
  const isOnActivePage = (it) => effectiveActivePage == null || it.pi === effectiveActivePage;
  // 換頁或換檢視時清除觸控選取：被選格會因過濾隱藏，殘留選取會讓
  // 下一次點擊和「看不見的格子」交換照片
  useEffect(() => { setSelectedIdx(null); }, [activePage, viewScope]);
  const availableEmptyCount = items.filter(it =>
    !disabled && isOnActivePage(it) && !skippedPages.has(it.pi) && !it.pendingFile && !it.serverPath
  ).length;

  const photoUrlVersion = (it) => [
    student?.updated_at ?? "",
    it.serverPath ?? "",
    photoRefreshKey,
  ].join("|");

  const displayUrl = (it) => {
    if (it.previewUrl) return it.previewUrl;
    if (it.serverPath !== null && it.origPi !== null)
      return buildPhotoUrl(projectId, studentId, it.origPi, it.origSlotId, photoUrlVersion(it));
    return null;
  };

  const thumbnailUrl = (it) => {
    if (it.previewUrl) return it.previewUrl;
    if (it.serverPath !== null && it.origPi !== null)
      return buildPhotoThumbnailUrl(projectId, studentId, it.origPi, it.origSlotId, photoUrlVersion(it));
    return null;
  };

  // ── File helpers ──────────────────────────────────────────────────────────
  function assignFile(arr, i, file) {
    if (arr[i].previewUrl) URL.revokeObjectURL(arr[i].previewUrl);
    arr[i] = { ...arr[i], pendingFile: file, previewUrl: URL.createObjectURL(file),
      serverPath: null, origPi: null, origSlotId: null, transform: { ...DEFAULT_PHOTO_TRANSFORM } };
  }

  const handleMultiUpload = (files) => {
    const arr = Array.from(files);
    const emptyCount = itemsRef.current.filter(it =>
      !disabled && isOnActivePage(it) && !skippedPages.has(it.pi) && !it.pendingFile && !it.serverPath
    ).length;
    if (emptyCount === 0) {
      toast.error(effectiveActivePage != null ? "本頁沒有剩餘空格可上傳" : "沒有剩餘空格可上傳");
      return;
    }
    const acceptedFiles = arr.slice(0, emptyCount);
    const skippedCount = arr.length - acceptedFiles.length;
    if (skippedCount > 0) {
      toast(`只上傳前 ${acceptedFiles.length} 張，已略過 ${skippedCount} 張`);
    }
    setItems(prev => {
      const next = prev.map(it => ({ ...it }));
      let fi = 0;
      for (let i = 0; i < prev.length && fi < acceptedFiles.length; i++) {
        const it = prev[i];
        if (disabled || !isOnActivePage(it) || skippedPages.has(it.pi) || it.pendingFile || it.serverPath) continue;
        assignFile(next, i, acceptedFiles[fi++]);
      }
      return next;
    });
  };

  const handleReplace = (idx, file) => {
    setItems(prev => {
      const next = [...prev];
      const it = { ...next[idx] };
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      next[idx] = { ...it, pendingFile: file, previewUrl: URL.createObjectURL(file),
        serverPath: null, origPi: null, origSlotId: null, transform: { ...DEFAULT_PHOTO_TRANSFORM } };
      return next;
    });
    closeEditModal();
  };

  const handleDelete = (idx) => {
    setItems(prev => {
      const next = [...prev];
      const it = { ...next[idx] };
      if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
      next[idx] = { ...it, pendingFile: null, previewUrl: null, serverPath: null,
        origPi: null, origSlotId: null, transform: { ...DEFAULT_PHOTO_TRANSFORM } };
      return next;
    });
    closeEditModal();
  };

  const handleSwap = (i, j) => {
    if (i === j || i == null || j == null) return;
    // 不把照片搬進/搬出已刪除頁：DnD 有 dropDisabled 擋，
    // 但觸控點擊與左右移按鈕路徑也會走到這裡
    if (skippedPages.has(items[i]?.pi) || skippedPages.has(items[j]?.pi)) return;
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

  const dndSensors = useDndPhotoSensors();

  const handleCellDragStart = (event) => {
    setSelectedIdx(null);
    setActiveDragIndex(event.active.data.current.cellIndex);
  };
  const handleCellDragCancel = () => setActiveDragIndex(null);
  const handleCellDragEnd = (event) => {
    const { active, over } = event;
    setActiveDragIndex(null);
    const from = active.data.current.cellIndex;
    const to = over?.data.current?.cellIndex;
    if (to != null && from !== to) handleSwap(from, to);
  };

  const updateTransform = (idx, t) =>
    setItems(prev => { const n = [...prev]; n[idx] = { ...n[idx], transform: { ...n[idx].transform, ...t } }; return n; });

  // ── Render ────────────────────────────────────────────────────────────────
  const visibleItems = items.filter(isOnActivePage);
  // 計數排除已刪除頁：已刪除頁的格子照樣渲染（標示已刪除），但不算進度
  const countableItems = visibleItems.filter(it => !skippedPages.has(it.pi));
  const filledCount = countableItems.filter(it => displayUrl(it)).length;
  // 照片卡固定 110px 高、寬依格位長寬比（見 PhotoSlotCard），取最寬者決定格線欄寬
  const maxSlotCardWidth = visibleItems.length
    ? Math.max(...visibleItems.map(it => Math.round(110 * it.slotW / it.slotH)))
    : 110;
  // 左右移的合法目標：目前檢視中、非刪除頁的格子（依 items 原始順序）
  const swappableIndexes = items
    .map((it, itemIndex) => ({ it, itemIndex }))
    .filter(({ it }) => isOnActivePage(it) && !skippedPages.has(it.pi))
    .map(({ itemIndex }) => itemIndex);
  // 整本檢視時在每頁第一格前插入頁標，維持方向感
  const showPageGroupHeaders = effectiveActivePage == null && activePage != null;
  const uploadPercent = uploadStatus?.percent ?? 0;
  const uploadLabel = uploadStatusLabel(uploadStatus);


  return (
    <div
      className="w-full bg-white border border-gray-200 rounded-2xl p-5 shadow-sm overflow-hidden"
      data-guide="student-photo-manager"
      // dnd-kit 拖曳走 pointer event,不會觸發這裡的原生 HTML5 drag 事件；
      // 這兩個 handler 只會攔到「從作業系統拖檔案進來」的情境，避免瀏覽器
      // 用預設的開檔導覽把整個 SPA 換掉、弄丟尚未儲存的編輯
      onDragOver={e => e.preventDefault()}
      onDrop={e => e.preventDefault()}
    >
      {/* Edit Modal */}
      {photoEdit.editModal && (
        <PhotoEditModal edit={photoEdit} items={items} displayUrl={displayUrl} />
      )}

      {/* 刪除照片確認：刪了要重傳，成本不低 */}
      <ConfirmModal
        isOpen={confirmDeleteIdx !== null}
        message="確定刪除這格照片？刪除後需要重新上傳。"
        confirmLabel="刪除照片"
        onConfirm={() => { handleDelete(confirmDeleteIdx); setConfirmDeleteIdx(null); }}
        onCancel={() => setConfirmDeleteIdx(null)}
      />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Images className="w-4 h-4 text-amber-500 flex-shrink-0" />
        <h3 className="font-semibold text-gray-800 text-sm flex-shrink-0">照片管理</h3>
        <span className="text-xs text-gray-400 min-w-0">
          {activePage != null && (effectiveActivePage != null ? `第 ${activePage + 1} 頁・` : "整本・")}{filledCount} / {countableItems.length} 格
          {uploadStatus !== null
            ? <span className="text-indigo-600 ml-1">↑ {uploadLabel} {uploadPercent}%</span>
            : hasDirty
              ? <span className="text-amber-600 ml-1">● 未儲存</span>
              : hasSavedPhotos && <span className="text-emerald-600 ml-1">✓ 已儲存</span>
          }
        </span>
        <div className="ml-auto flex flex-shrink-0 gap-2">
          {/* 檢視範圍切換：整本＝一次上傳全書、跨頁拖曳調換（唯讀時仍可切換瀏覽） */}
          {activePage != null && (
            <div data-guide="student-photo-scope" className="flex-shrink-0">
              <SegmentedControl
                value={viewScope}
                onChange={setViewScope}
                size="sm"
                options={[
                  { value: "page", label: "本頁" },
                  { value: "book", label: "整本" },
                ]}
              />
            </div>
          )}
          <Button
            type="button"
            style={{ visibility: disabled ? "hidden" : "visible" }}
            onClick={() => multiRef.current?.click()}
            disabled={disabled || availableEmptyCount === 0}
            data-guide="student-multi-upload"
            data-empty-count={availableEmptyCount}
            title={availableEmptyCount > 0 ? `剩餘 ${availableEmptyCount} 格可上傳` : "沒有剩餘空格"}
            variant="secondary"
            size="sm"
            className="whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>多選上傳</span>
            <span className="text-xs text-indigo-400">剩 {availableEmptyCount}</span>
          </Button>
          <input ref={multiRef} type="file" accept="image/*,.heic,.heif,.hif" multiple className="hidden"
            disabled={disabled || availableEmptyCount === 0}
            onChange={e => { if (e.target.files?.length) { handleMultiUpload(e.target.files); e.target.value = ""; } }} />
        </div>
      </div>

      {/* Upload progress bar */}
      {uploadStatus !== null && (
        <div className="w-full h-1 bg-gray-100 rounded-full mb-3 overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-200"
            style={{ width: `${uploadPercent}%` }}
          />
        </div>
      )}

      {/* Photo grid */}
      <DndContext
        sensors={dndSensors}
        onDragStart={handleCellDragStart}
        onDragEnd={handleCellDragEnd}
        onDragCancel={handleCellDragCancel}
      >
      <div
        data-guide="student-photo-grid"
        // 手機固定 2 格一層（!important 蓋過 inline 欄寬）；
        // sm 以上欄寬跟著最寬的照片卡走（卡片是固定像素尺寸，PIL 對位需要）
        className="grid gap-3 max-sm:grid-cols-2!"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(min(${maxSlotCardWidth + 24}px, 100%), 1fr))`,
        }}
        onClick={e => {
          // Tap outside any cell deselects on touch
          if (isTouchDevice && e.target === e.currentTarget) setSelectedIdx(null);
        }}
      >
        {items.map((it, idx) => {
          // 只渲染當前頁的格子；items 索引保留給拖曳/交換 handler 使用
          if (!isOnActivePage(it)) return null;
          const url = displayUrl(it);
          const thumbUrl = thumbnailUrl(it);
          const dirty = isDirty(it);
          const rk = `${it.pi}_${it.slotId}`;
          const nat = aspectMap[rk];
          const isSelected = selectedIdx === idx;
          const isItemDisabled = disabled || skippedPages.has(it.pi);
          // 左右移只在「目前檢視中、非刪除頁」的格子間移動，避免把照片搬進看不見的頁
          const swapPosition = swappableIndexes.indexOf(idx);
          const swapPrevIdx = swapPosition > 0 ? swappableIndexes[swapPosition - 1] : null;
          const swapNextIdx = swapPosition >= 0 && swapPosition < swappableIndexes.length - 1
            ? swappableIndexes[swapPosition + 1]
            : null;
          // 整本檢視的頁界標示
          const isFirstOfPage = idx === 0 || items[idx - 1]?.pi !== it.pi;

          const handleCellClick = (forceSelection = false) => {
            if (isItemDisabled) return;
            // 整本模式：點格讓預覽/文字面板同步跳到該頁
            if (effectiveActivePage == null && activePage != null && it.pi !== activePage) onPageFocus?.(it.pi);
            if (isTouchDevice || forceSelection) {
              // 已選取另一格 → 點此格直接交換（空格 = 移動過去）
              if (selectedIdx != null && selectedIdx !== idx) {
                handleSwap(selectedIdx, idx);
                setSelectedIdx(null);
                return;
              }
              if (!url) { replaceRefs.current[rk]?.click(); return; }
              setSelectedIdx(prev => prev === idx ? null : idx);
            } else {
              if (!url) replaceRefs.current[rk]?.click();
            }
          };

          return (
            <Fragment key={rk}>
            {showPageGroupHeaders && isFirstOfPage && (
              <div className="col-span-full -mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
                第 {it.pi + 1} 頁
                {skippedPages.has(it.pi) && (
                  <span className="rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium text-red-400">已刪除</span>
                )}
              </div>
            )}
            <DndCell cellIndex={idx} dragDisabled={!url || isItemDisabled} dropDisabled={isItemDisabled}>
              {({ dndRef, dndListeners, isDragging, isOver }) => {
                const isDragOver = isOver && activeDragIndex !== null && activeDragIndex !== idx;
                return (
            <div
              data-guide="student-photo-cell"
              data-slot-id={it.slotId}
              data-page-index={it.pi}
              ref={dndRef}
              {...dndListeners}
              onClick={() => handleCellClick(false)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleCellClick(true);
                }
              }}
              role="button"
              tabIndex={isItemDisabled ? -1 : 0}
              aria-pressed={isSelected}
              aria-label={`第 ${it.pi + 1} 頁格位 ${it.slotIndex + 1}${url ? "，已有照片；按 Enter 選取後可與其他格交換" : "，空白；按 Enter 上傳或接收選取的照片"}`}
              // 方形用 padding-bottom 百分比而非 aspect-ratio：WebKit 在 grid 內
              // 不會用 aspect-ratio 撐行高，行高不足時上下列會互疊
              className="group relative w-full rounded-xl pb-[100%] transition-all"
              style={{
                touchAction: "manipulation",
                background: isItemDisabled ? "#f8fafc" : isSelected ? "rgba(99,102,241,0.1)" : isDragOver ? "rgba(99,102,241,0.08)" : dirty ? "rgba(251,191,36,0.08)" : "#f3f4f6",
                outline: isItemDisabled ? "2px dashed #e2e8f0" : isSelected ? "2px solid #6366f1" : isDragOver ? "2px solid #6366f1" : dirty ? "2px solid #fbbf24" : "2px solid transparent",
                cursor: isItemDisabled ? "default" : (url ? "grab" : "pointer"),
                opacity: isItemDisabled ? 0.5 : isDragging ? 0.4 : 1,
              }}
            >
              {/* Pure display（絕對定位置中：外層以 padding-bottom 撐方形） */}
              <div className="absolute inset-0 flex items-center justify-center">
                <PhotoSlotCard
                  it={it} url={thumbUrl} nat={nat} disabled={isItemDisabled}
                  onImgLoad={e => setAspectMap(prev => ({ ...prev, [rk]: e.target.naturalWidth / e.target.naturalHeight }))}
                  imgRefCallback={el => { thumbImgRefs.current[rk] = el; }}
                />
              </div>

              {/* 已刪除頁面遮罩 */}
              {skippedPages.has(it.pi) && (
                <div className="absolute inset-0 rounded-xl flex items-end justify-center pb-1 pointer-events-none">
                  <span className="text-[9px] text-red-400 bg-white/80 px-1 rounded">已刪除</span>
                </div>
              )}

              {/* Desktop hover overlay */}
              {url && !isItemDisabled && !isTouchDevice && (
                <div className="absolute inset-0 rounded-xl bg-black/50 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex items-center justify-center gap-1.5 pointer-events-none">
                  <div className="pointer-events-auto flex gap-1.5">
                    <button type="button" aria-label="編輯照片位置與縮放" onClick={e => { e.stopPropagation(); openEditModal(idx); }} title="位移/縮放"
                      className="w-7 h-7 bg-white/20 hover:bg-white/40 rounded-lg flex items-center justify-center transition-colors">
                      <ZoomIn className="w-3 h-3 text-white" />
                    </button>
                    <button type="button" aria-label="更換照片" onClick={e => { e.stopPropagation(); replaceRefs.current[rk]?.click(); }} title="更換"
                      className="w-7 h-7 bg-white/20 hover:bg-white/40 rounded-lg flex items-center justify-center transition-colors">
                      <RefreshCw className="w-3 h-3 text-white" />
                    </button>
                    <button type="button" aria-label="刪除照片" onClick={e => { e.stopPropagation(); setConfirmDeleteIdx(idx); }} title="刪除"
                      className="w-7 h-7 bg-red-500/70 hover:bg-red-600 rounded-lg flex items-center justify-center transition-colors">
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                </div>
              )}

              {/* Mobile tap-selected overlay */}
              {url && !isItemDisabled && isTouchDevice && isSelected && (
                <div className="absolute inset-0 rounded-xl bg-black/55 flex flex-col items-center justify-center gap-2">
                  <span className="text-[10px] text-white/90">點另一格可交換，或長按拖曳</span>
                  {/* Top row: move left / move right */}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-label="向前一格移動"
                      onClick={e => { e.stopPropagation(); if (swapPrevIdx != null) { handleSwap(idx, swapPrevIdx); setSelectedIdx(swapPrevIdx); } }}
                      disabled={swapPrevIdx == null}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center disabled:opacity-30 transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4 text-white" />
                    </button>
                    <button
                      type="button"
                      aria-label="向後一格移動"
                      onClick={e => { e.stopPropagation(); if (swapNextIdx != null) { handleSwap(idx, swapNextIdx); setSelectedIdx(swapNextIdx); } }}
                      disabled={swapNextIdx == null}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="w-4 h-4 text-white" />
                    </button>
                  </div>
                  {/* Bottom row: edit / replace / delete */}
                  <div className="flex gap-2">
                    <button type="button" aria-label="編輯照片位置與縮放" onClick={e => { e.stopPropagation(); setSelectedIdx(null); openEditModal(idx); }}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center transition-colors">
                      <ZoomIn className="w-4 h-4 text-white" />
                    </button>
                    <button type="button" aria-label="更換照片" onClick={e => { e.stopPropagation(); replaceRefs.current[rk]?.click(); }}
                      className="w-9 h-9 bg-white/20 active:bg-white/40 rounded-xl flex items-center justify-center transition-colors">
                      <RefreshCw className="w-4 h-4 text-white" />
                    </button>
                    <button type="button" aria-label="刪除照片" onClick={e => { e.stopPropagation(); setConfirmDeleteIdx(idx); setSelectedIdx(null); }}
                      className="w-9 h-9 bg-red-500/70 active:bg-red-600 rounded-xl flex items-center justify-center transition-colors">
                      <X className="w-4 h-4 text-white" />
                    </button>
                  </div>
                </div>
              )}

              {/* Slot label */}
              <div className="absolute bottom-1 left-0 right-0 text-center text-[10px] text-gray-400 pointer-events-none select-none">
                第{it.pi + 1}頁·格{it.slotIndex + 1}
              </div>

              {/* File input lives in the cell, not the card */}
              <input ref={el => { replaceRefs.current[rk] = el; }}
                type="file" accept="image/*,.heic,.heif,.hif" className="hidden"
                onChange={e => { if (e.target.files?.[0]) { handleReplace(idx, e.target.files[0]); e.target.value = ""; } }} />
            </div>
                );
              }}
            </DndCell>
            </Fragment>
          );
        })}
      </div>

      {/* 拖曳殘影：跟著游標/手指移動的縮圖 */}
      <DragOverlay dropAnimation={null}>
        {activeDragIndex != null && items[activeDragIndex] ? (
          <div className="h-20 w-20 overflow-hidden rounded-xl border-2 border-indigo-400 bg-white shadow-lg">
            {(thumbnailUrl(items[activeDragIndex]) || displayUrl(items[activeDragIndex])) && (
              <img
                src={thumbnailUrl(items[activeDragIndex]) || displayUrl(items[activeDragIndex])}
                alt=""
                className="h-full w-full object-cover"
              />
            )}
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>

    </div>
  );
}
