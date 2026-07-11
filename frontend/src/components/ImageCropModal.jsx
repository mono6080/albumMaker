// ImageCropModal — 通用圖片裁切 Modal
// 支援拖曳平移、滾輪/滑桿縮放、觸控手勢。
// 縮放時自動等比例調整 panX/panY，保持裁切中心穩定。
// 確認後以 9-arg ctx.drawImage 精確裁切至目標尺寸並回呼 onConfirm(file)。

import { useState, useRef, useEffect } from "react";

const FRAME_DISPLAY_W = 397;

export default function ImageCropModal({
  file,
  targetWidth  = 794,
  targetHeight = 1123,
  title = "裁切圖片",
  hint  = "拖曳移動 · 滾輪縮放 · 裁切範圍固定比例",
  onConfirm,
  onCancel,
}) {
  // 裁切框自適應視窗：固定 397px 在 390px 手機必定溢出，
  // 直式格也要限制高度讓「套用裁切」按鈕保持可及
  const availW = typeof window !== "undefined"
    ? Math.min(FRAME_DISPLAY_W, window.innerWidth - 56)
    : FRAME_DISPLAY_W;
  const availH = typeof window !== "undefined"
    ? Math.max(200, Math.round(window.innerHeight * 0.55))
    : 620;
  const cropAspect = targetHeight / targetWidth;
  let frameW = availW;
  let frameH = Math.round(frameW * cropAspect);
  if (frameH > availH) {
    frameH = availH;
    frameW = Math.round(frameH / cropAspect);
  }

  const [scale, setScale]   = useState(1);
  const [panX,  setPanX]    = useState(0);
  const [panY,  setPanY]    = useState(0);
  const [imgNat, setImgNat] = useState(null);
  const [isDragActive, setIsDragActive] = useState(false);

  const imgRef       = useRef(null);
  const containerRef = useRef(null);
  const isDragging   = useRef(false);
  const lastPos      = useRef({ x: 0, y: 0 });

  // 保持最新狀態供非同步事件處理器使用（避免 stale closure）
  const stateRef = useRef({ scale: 1, panX: 0, panY: 0, imgNat: null });
  useEffect(() => { stateRef.current = { scale, panX, panY, imgNat }; });

  // objectURL 用 state＋effect 建立：useMemo＋cleanup 撤銷在 StrictMode 的
  // mount→cleanup→remount 會撤銷掉同一個 URL 卻不重建，導致圖片破圖
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // ── 幾何計算 ──────────────────────────────────────────────────────────────
  const fitScale     = imgNat ? Math.max(frameW / imgNat.w, frameH / imgNat.h) : 1;
  const effectiveScale = fitScale * scale;
  const imgDisplayW  = imgNat ? imgNat.w * effectiveScale : frameW;
  const imgDisplayH  = imgNat ? imgNat.h * effectiveScale : frameH;
  const maxPanX      = Math.max(0, (imgDisplayW - frameW) / 2);
  const maxPanY      = Math.max(0, (imgDisplayH - frameH) / 2);
  const clampedPanX  = Math.min(maxPanX, Math.max(-maxPanX, panX));
  const clampedPanY  = Math.min(maxPanY, Math.max(-maxPanY, panY));
  const imgLeft      = frameW / 2 + clampedPanX - imgDisplayW / 2;
  const imgTop       = frameH / 2 + clampedPanY - imgDisplayH / 2;

  // ── 縮放輔助：等比例調整 pan，保持裁切中心不跳動 ──────────────────────────
  function applyScale(newScale, curPanX, curPanY, nat) {
    if (!nat) return;
    const clamped    = Math.max(1, Math.min(6, newScale));
    const ratio      = clamped / stateRef.current.scale;
    const newEffective = Math.max(frameW / nat.w, frameH / nat.h) * clamped;
    const newMaxX    = Math.max(0, (nat.w * newEffective - frameW) / 2);
    const newMaxY    = Math.max(0, (nat.h * newEffective - frameH) / 2);
    setScale(clamped);
    setPanX(Math.min(newMaxX, Math.max(-newMaxX, curPanX * ratio)));
    setPanY(Math.min(newMaxY, Math.max(-newMaxY, curPanY * ratio)));
  }

  // ── 滾輪縮放（non-passive，防止頁面捲動） ────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      e.preventDefault();
      const { scale: s, panX: px, panY: py, imgNat: nat } = stateRef.current;
      if (!nat) return;
      const factor   = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(1, Math.min(6, s * factor));
      const ratio    = newScale / s;
      const newEff   = Math.max(frameW / nat.w, frameH / nat.h) * newScale;
      const newMaxX  = Math.max(0, (nat.w * newEff - frameW) / 2);
      const newMaxY  = Math.max(0, (nat.h * newEff - frameH) / 2);
      setScale(newScale);
      setPanX(Math.min(newMaxX, Math.max(-newMaxX, px * ratio)));
      setPanY(Math.min(newMaxY, Math.max(-newMaxY, py * ratio)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }); // 每次 render 都重新綁定，確保 stateRef 是最新的

  // ── 滑桿縮放 ────────────────────────────────────────────────────────────
  const handleSliderChange = (e) => {
    applyScale(Number(e.target.value), panX, panY, imgNat);
  };

  // ── 滑鼠拖曳 ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e) => {
    isDragging.current = true;
    setIsDragActive(true);
    lastPos.current = { x: e.clientX, y: e.clientY };
  };
  const handleMouseMove = (e) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPanX(prev => Math.min(maxPanX, Math.max(-maxPanX, prev + dx)));
    setPanY(prev => Math.min(maxPanY, Math.max(-maxPanY, prev + dy)));
  };
  const handleMouseUp = () => {
    isDragging.current = false;
    setIsDragActive(false);
  };

  // ── 觸控拖曳 ─────────────────────────────────────────────────────────────
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    isDragging.current = true;
    setIsDragActive(true);
    lastPos.current = { x: t.clientX, y: t.clientY };
  };
  const handleTouchMove = (e) => {
    e.preventDefault();
    const t  = e.touches[0];
    const dx = t.clientX - lastPos.current.x;
    const dy = t.clientY - lastPos.current.y;
    lastPos.current = { x: t.clientX, y: t.clientY };
    setPanX(prev => Math.min(maxPanX, Math.max(-maxPanX, prev + dx)));
    setPanY(prev => Math.min(maxPanY, Math.max(-maxPanY, prev + dy)));
  };
  const handleTouchEnd = () => {
    isDragging.current = false;
    setIsDragActive(false);
  };

  // ── 確認裁切 ─────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    if (!imgNat || !imgRef.current) return;
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width  = targetWidth;
    outputCanvas.height = targetHeight;
    const ctx = outputCanvas.getContext("2d");

    // 9-arg drawImage：從原始像素座標裁出 frameW×frameH 區域 → 填滿輸出畫布
    // imgLeft/imgTop 是圖片在 display 座標中的左上角位置（≤ 0）
    // 轉換為原始像素：除以 effectiveScale
    const srcX = (-imgLeft) / effectiveScale;
    const srcY = (-imgTop)  / effectiveScale;
    const srcW = frameW / effectiveScale;
    const srcH = frameH / effectiveScale;
    ctx.drawImage(imgRef.current, srcX, srcY, srcW, srcH, 0, 0, targetWidth, targetHeight);

    outputCanvas.toBlob(blob => {
      onConfirm(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2">
      <div className="bg-white rounded-xl shadow-2xl p-5 flex flex-col gap-4 max-h-[94dvh] max-w-[calc(100vw-8px)] overflow-y-auto">
        <div>
          <h2 className="font-semibold text-gray-800">{title}</h2>
          {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
        </div>

        {/* 裁切預覽區 */}
        <div
          ref={containerRef}
          style={{
            width: frameW, height: frameH,
            overflow: "hidden", position: "relative",
            cursor: isDragActive ? "grabbing" : "grab",
            background: "#ddd",
            touchAction: "none",
          }}
          className="rounded border border-gray-300 select-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* 裁切框邊框 */}
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1,
            boxShadow: "inset 0 0 0 2px rgba(99,102,241,0.5)",
          }} />
          {url && <img
            ref={imgRef}
            src={url}
            onLoad={e => setImgNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
            style={{
              position: "absolute",
              left: imgLeft, top: imgTop,
              width: imgDisplayW, height: imgDisplayH,
              maxWidth: "none", maxHeight: "none",
              pointerEvents: "none", userSelect: "none",
            }}
            draggable={false}
            alt=""
          />}
        </div>

        {/* 縮放滑桿 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-8">縮放</span>
          <input
            type="range" min="1" max="6" step="0.01"
            value={scale}
            onChange={handleSliderChange}
            className="flex-1"
          />
          <span className="text-xs text-gray-400 w-10 text-right">{Math.round(scale * 100)}%</span>
        </div>

        {/* 操作按鈕 */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!imgNat}
            className="px-4 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            套用裁切
          </button>
        </div>
      </div>
    </div>
  );
}
