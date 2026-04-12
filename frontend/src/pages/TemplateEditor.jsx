// 模板編輯器頁面
// 提供視覺化拖曳介面讓使用者設計相冊模板，
// 包含照片格、氣泡框、貼圖素材的新增、移動、縮放、旋轉與屬性編輯

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import {
  fetchTemplate,
  addTemplatePage,
  updatePageLayout,
  uploadBackground,
  deleteTemplatePage,
  uploadSticker,
} from "../api/templateApi";
import { buildStickerUrl } from "../api/urls";
import { BUBBLE_SHAPES } from "../constants/shapes";
import { FONT_OPTIONS, getFontCss, isFontBold } from "../constants/fonts";
import BubbleSVG from "../components/canvas/BubbleSVG";
import ColorPicker from "../components/ColorPicker";

// ── 畫布尺寸常數 ──────────────────────────────────────────────────────────────
// 顯示寬度固定為 530px，實際儲存尺寸為 A4（794×1123）
const CANVAS_DISPLAY_WIDTH = 530;
const CANVAS_SCALE = CANVAS_DISPLAY_WIDTH / 794;
const CANVAS_DISPLAY_HEIGHT = Math.round(1123 * CANVAS_SCALE);

// ── 座標轉換工具 ──────────────────────────────────────────────────────────────

/** 將實際座標值換算為畫布顯示座標 */
function toDisplayCoord(realValue) {
  return realValue * CANVAS_SCALE;
}

/** 將畫布顯示座標換算回實際座標值（四捨五入取整數） */
function toRealCoord(displayValue) {
  return Math.round(displayValue / CANVAS_SCALE);
}

/** 將數值限制在 [minValue, maxValue] 範圍內 */
function clampValue(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

/** 產生 5 位隨機整數 ID，用於新增元素時分配識別碼 */
function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}


// ─────────────────────────────────────────────────────────────────────────────

export default function TemplateEditor() {
  const { id: templateId } = useParams();
  const navigate = useNavigate();

  const [template, setTemplate] = useState(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageLayout, setPageLayout] = useState(null);
  const [selectedElement, setSelectedElement] = useState(null); // { type: 'photo'|'bubble'|'sticker', id }
  const [backgroundUrl, setBackgroundUrl] = useState(null);
  const [activeTool, setActiveTool] = useState("select"); // select | addPhoto | addBubble
  const [draggingState, setDraggingState] = useState(null);
  const [resizingState, setResizingState] = useState(null);
  const [rotatingState, setRotatingState] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  const canvasRef = useRef(null);
  const stickerFileInputRef = useRef(null);

  // ── 載入與頁面切換 ────────────────────────────────────────────────────────

  const loadTemplate = useCallback(() => {
    fetchTemplate(templateId).then(response => {
      setTemplate(response.data);
      const pages = response.data.pages;
      if (pages.length > 0) {
        const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
        setPageLayout(safePage.layout);
        setBackgroundUrl(
          safePage.background_filename
            ? `/api/templates/${templateId}/pages/${safePage.id}/background?t=${Date.now()}`
            : null
        );
      }
    });
  }, [templateId, currentPageIndex]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  // 切換頁面時更新佈局與背景圖
  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
    setPageLayout(safePage.layout);
    setSelectedElement(null);
    setBackgroundUrl(
      safePage.background_filename
        ? `/api/templates/${templateId}/pages/${safePage.id}/background?t=${Date.now()}`
        : null
    );
  }, [currentPageIndex, template, templateId]);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = async () => {
    if (!pageLayout || !currentPage) return;
    setIsSaving(true);
    try {
      await updatePageLayout(templateId, currentPage.id, pageLayout);
      toast.success("已儲存");
    } catch {
      toast.error("儲存失敗");
    }
    setIsSaving(false);
  };

  const handleAddPage = async () => {
    await addTemplatePage(templateId);
    await loadTemplate();
    setCurrentPageIndex(template.pages.length);
    toast.success("已新增頁面");
  };

  const handleDeletePage = async () => {
    if (!currentPage) return;
    if (!confirm("確定刪除此頁？")) return;
    await deleteTemplatePage(templateId, currentPage.id);
    setCurrentPageIndex(Math.max(0, currentPageIndex - 1));
    await loadTemplate();
    toast.success("已刪除頁面");
  };

  const handleBackgroundUpload = async (event) => {
    const imageFile = event.target.files[0];
    if (!imageFile || !currentPage) return;
    await uploadBackground(templateId, currentPage.id, imageFile);
    setBackgroundUrl(
      `/api/templates/${templateId}/pages/${currentPage.id}/background?t=${Date.now()}`
    );
    toast.success("背景已上傳");
    event.target.value = "";
  };

  const handleStickerUpload = async (stickerFile) => {
    if (!stickerFile) return;
    try {
      const response = await uploadSticker(templateId, stickerFile);
      const { path: stickerPath, filename: stickerFilename } = response.data;
      const newSticker = {
        id: generateElementId(),
        path: stickerPath,
        filename: stickerFilename,
        x: 50, y: 50,
        width: 150, height: 150,
        rotation: 0,
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        stickers: [...(currentLayout.stickers || []), newSticker],
      }));
      setSelectedElement({ type: "sticker", id: newSticker.id });
      toast.success("貼圖已上傳");
    } catch {
      toast.error("上傳失敗");
    }
  };

  // ── 畫布互動：座標計算與元素查找 ─────────────────────────────────────────

  /** 計算滑鼠事件相對於畫布左上角的座標 */
  const getCanvasPosition = (mouseEvent) => {
    const canvasRect = canvasRef.current.getBoundingClientRect();
    return {
      x: mouseEvent.clientX - canvasRect.left,
      y: mouseEvent.clientY - canvasRect.top,
    };
  };

  /** 從最上層往下逐層進行點擊碰撞測試，回傳被點到的元素識別資訊 */
  const hitTestElement = (canvasPosition) => {
    if (!pageLayout) return null;

    // 貼圖層（最上層，優先測試）
    for (const sticker of [...(pageLayout.stickers || [])].reverse()) {
      const displayX = toDisplayCoord(sticker.x);
      const displayY = toDisplayCoord(sticker.y);
      const displayW = toDisplayCoord(sticker.width);
      const displayH = toDisplayCoord(sticker.height);
      if (
        canvasPosition.x >= displayX && canvasPosition.x <= displayX + displayW &&
        canvasPosition.y >= displayY && canvasPosition.y <= displayY + displayH
      ) {
        return { type: "sticker", id: sticker.id };
      }
    }

    // 氣泡框層
    for (const bubble of [...pageLayout.text_bubbles].reverse()) {
      const displayX = toDisplayCoord(bubble.x);
      const displayY = toDisplayCoord(bubble.y);
      const displayW = toDisplayCoord(bubble.width);
      const displayH = toDisplayCoord(bubble.height);
      if (
        canvasPosition.x >= displayX && canvasPosition.x <= displayX + displayW &&
        canvasPosition.y >= displayY && canvasPosition.y <= displayY + displayH
      ) {
        return { type: "bubble", id: bubble.id };
      }
    }

    // 照片格層（最底層）
    for (const photoSlot of [...pageLayout.photo_slots].reverse()) {
      const displayX = toDisplayCoord(photoSlot.x);
      const displayY = toDisplayCoord(photoSlot.y);
      const displayW = toDisplayCoord(photoSlot.width);
      const displayH = toDisplayCoord(photoSlot.height);
      if (
        canvasPosition.x >= displayX && canvasPosition.x <= displayX + displayW &&
        canvasPosition.y >= displayY && canvasPosition.y <= displayY + displayH
      ) {
        return { type: "photo", id: photoSlot.id };
      }
    }

    return null;
  };

  /** 取得指定元素的資料物件 */
  const getElement = ({ type, id }) => {
    if (!pageLayout) return null;
    if (type === "photo") return pageLayout.photo_slots.find(slot => slot.id === id);
    if (type === "bubble") return pageLayout.text_bubbles.find(bubble => bubble.id === id);
    if (type === "sticker") return (pageLayout.stickers || []).find(sticker => sticker.id === id);
    return null;
  };

  /** 更新指定元素的部分屬性 */
  const updateElement = (elementType, elementId, propertyUpdates) => {
    setPageLayout(currentLayout => {
      if (elementType === "photo") {
        return {
          ...currentLayout,
          photo_slots: currentLayout.photo_slots.map(slot =>
            slot.id === elementId ? { ...slot, ...propertyUpdates } : slot
          ),
        };
      }
      if (elementType === "bubble") {
        return {
          ...currentLayout,
          text_bubbles: currentLayout.text_bubbles.map(bubble =>
            bubble.id === elementId ? { ...bubble, ...propertyUpdates } : bubble
          ),
        };
      }
      if (elementType === "sticker") {
        return {
          ...currentLayout,
          stickers: (currentLayout.stickers || []).map(sticker =>
            sticker.id === elementId ? { ...sticker, ...propertyUpdates } : sticker
          ),
        };
      }
      return currentLayout;
    });
  };

  /** 刪除目前選取的元素 */
  const deleteSelectedElement = () => {
    if (!selectedElement) return;
    if (selectedElement.type === "photo") {
      setPageLayout(currentLayout => ({
        ...currentLayout,
        photo_slots: currentLayout.photo_slots.filter(slot => slot.id !== selectedElement.id),
      }));
    } else if (selectedElement.type === "bubble") {
      setPageLayout(currentLayout => ({
        ...currentLayout,
        text_bubbles: currentLayout.text_bubbles.filter(bubble => bubble.id !== selectedElement.id),
      }));
    } else if (selectedElement.type === "sticker") {
      setPageLayout(currentLayout => ({
        ...currentLayout,
        stickers: (currentLayout.stickers || []).filter(sticker => sticker.id !== selectedElement.id),
      }));
    }
    setSelectedElement(null);
  };

  // ── 畫布滑鼠事件處理 ─────────────────────────────────────────────────────

  const onCanvasMouseDown = (mouseEvent) => {
    if (!pageLayout) return;
    const canvasPosition = getCanvasPosition(mouseEvent);

    // 新增照片格工具
    if (activeTool === "addPhoto") {
      const newPhotoSlot = {
        id: generateElementId(),
        x: toRealCoord(canvasPosition.x),
        y: toRealCoord(canvasPosition.y),
        width: 300, height: 220, rotation: 0,
        border: true, border_width: 8,
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        photo_slots: [...currentLayout.photo_slots, newPhotoSlot],
      }));
      setActiveTool("select");
      setSelectedElement({ type: "photo", id: newPhotoSlot.id });
      return;
    }

    // 新增氣泡框工具
    if (activeTool === "addBubble") {
      const newBubble = {
        id: generateElementId(),
        x: toRealCoord(canvasPosition.x),
        y: toRealCoord(canvasPosition.y),
        width: 180, height: 110,
        shape: "ellipse", fill: "#FDED6E",
        border_color: null, border_width: 0,
        text: "{name}的描述文字", font_size: 20,
        font_color: "#3B6B8C", line_height: 1.4,
        font_family: "msjh", tail_side: "right",
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        text_bubbles: [...currentLayout.text_bubbles, newBubble],
      }));
      setActiveTool("select");
      setSelectedElement({ type: "bubble", id: newBubble.id });
      return;
    }

    // 選取工具
    const hitResult = hitTestElement(canvasPosition);
    if (hitResult) {
      setSelectedElement(hitResult);
      const hitElement = getElement(hitResult);
      if (hitElement) {
        // 判斷是否點擊縮放把手（右下角 10px 區域）
        const resizeHandleX = toDisplayCoord(hitElement.x) + toDisplayCoord(hitElement.width) - 10;
        const resizeHandleY = toDisplayCoord(hitElement.y) + toDisplayCoord(hitElement.height) - 10;
        if (canvasPosition.x >= resizeHandleX && canvasPosition.y >= resizeHandleY) {
          setResizingState({
            ...hitResult,
            startX: canvasPosition.x,
            startY: canvasPosition.y,
            originalWidth: hitElement.width,
            originalHeight: hitElement.height,
          });
          return;
        }
      }
      // 否則進入拖曳模式
      setDraggingState({
        ...hitResult,
        startX: canvasPosition.x,
        startY: canvasPosition.y,
        originalX: getElement(hitResult)?.x,
        originalY: getElement(hitResult)?.y,
      });
    } else {
      setSelectedElement(null);
    }
  };

  const onCanvasMouseMove = (mouseEvent) => {
    const canvasPosition = getCanvasPosition(mouseEvent);

    if (draggingState) {
      const deltaX = toRealCoord(canvasPosition.x - draggingState.startX);
      const deltaY = toRealCoord(canvasPosition.y - draggingState.startY);
      const currentElement = getElement(draggingState);
      updateElement(draggingState.type, draggingState.id, {
        x: clampValue(draggingState.originalX + deltaX, 0, 794 - (currentElement?.width ?? 100)),
        y: clampValue(draggingState.originalY + deltaY, 0, 1123 - (currentElement?.height ?? 60)),
      });
    }

    if (resizingState) {
      const deltaX = toRealCoord(canvasPosition.x - resizingState.startX);
      const deltaY = toRealCoord(canvasPosition.y - resizingState.startY);
      if (mouseEvent.shiftKey) {
        // Shift 鍵：等比縮放
        const aspectRatio = resizingState.originalWidth / resizingState.originalHeight;
        const dominantDelta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY * aspectRatio;
        const newWidth = Math.max(60, resizingState.originalWidth + dominantDelta);
        const newHeight = Math.max(40, newWidth / aspectRatio);
        updateElement(resizingState.type, resizingState.id, { width: newWidth, height: newHeight });
      } else {
        updateElement(resizingState.type, resizingState.id, {
          width: Math.max(60, resizingState.originalWidth + deltaX),
          height: Math.max(40, resizingState.originalHeight + deltaY),
        });
      }
    }

    if (rotatingState) {
      const angle = Math.atan2(
        canvasPosition.y - rotatingState.centerY,
        canvasPosition.x - rotatingState.centerX
      ) * (180 / Math.PI);
      const angleDelta = angle - rotatingState.startAngle;
      const newRotation = rotatingState.originalRotation + angleDelta;
      // Shift 鍵：對齊至 15° 倍數；否則對齊至 0.5° 倍數
      const snapIncrement = mouseEvent.shiftKey ? 15 : 0.5;
      updateElement(rotatingState.type, rotatingState.id, {
        rotation: Math.round(newRotation / snapIncrement) * snapIncrement,
      });
    }
  };

  const onCanvasMouseUp = () => {
    setDraggingState(null);
    setResizingState(null);
    setRotatingState(null);
  };

  // ── 旋轉把手 onMouseDown（由子元素觸發） ────────────────────────────────

  const startRotating = (mouseEvent, elementType, elementId) => {
    mouseEvent.stopPropagation();
    const canvasPosition = getCanvasPosition(mouseEvent);
    const element = getElement({ type: elementType, id: elementId });
    const centerX = toDisplayCoord(element.x) + toDisplayCoord(element.width) / 2;
    const centerY = toDisplayCoord(element.y) + toDisplayCoord(element.height) / 2;
    const startAngle = Math.atan2(
      canvasPosition.y - centerY,
      canvasPosition.x - centerX
    ) * (180 / Math.PI);
    setRotatingState({
      type: elementType, id: elementId,
      centerX, centerY,
      startAngle,
      originalRotation: element.rotation ?? 0,
    });
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  if (!template) return <div className="text-gray-400">載入中...</div>;

  if (template.pages.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">編輯模板：{template.name}</h1>
        <button onClick={handleAddPage} className="bg-indigo-600 text-white px-4 py-2 rounded">
          新增第一頁
        </button>
      </div>
    );
  }

  const selectedItem = selectedElement ? getElement(selectedElement) : null;

  return (
    <div>
      {/* 頂部導覽列 */}
      <div className="flex items-center gap-4 mb-4">
        <button onClick={() => navigate("/templates")} className="text-gray-500 hover:text-gray-700">
          ← 返回
        </button>
        <h1 className="text-xl font-bold">{template.name}</h1>
        <span className="text-gray-400 text-sm">模板編輯器</span>
      </div>

      <div className="flex gap-6">
        {/* 左側：畫布區域 */}
        <div className="flex-shrink-0">
          {/* 頁面分頁標籤 */}
          <div className="flex gap-1 mb-2">
            {template.pages.map((templatePage, pageTabIndex) => (
              <button
                key={templatePage.id}
                onClick={() => setCurrentPageIndex(pageTabIndex)}
                className={`px-3 py-1 rounded text-sm border ${
                  currentPageIndex === pageTabIndex
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                第 {pageTabIndex + 1} 頁
              </button>
            ))}
            <button
              onClick={handleAddPage}
              className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50"
            >
              + 新增頁
            </button>
          </div>

          {/* 工具列 */}
          <div className="flex gap-2 mb-2">
            {[
              { key: "select",   label: "選取" },
              { key: "addPhoto", label: "＋照片格" },
              { key: "addBubble", label: "＋氣泡框" },
            ].map(tool => (
              <button
                key={tool.key}
                onClick={() => setActiveTool(tool.key)}
                className={`px-3 py-1 rounded text-sm border ${
                  activeTool === tool.key
                    ? "bg-indigo-600 text-white"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                {tool.label}
              </button>
            ))}

            <label className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50 cursor-pointer">
              上傳背景
              <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundUpload} />
            </label>

            <label className="px-3 py-1 rounded text-sm border bg-white hover:bg-gray-50 cursor-pointer">
              ＋貼圖素材
              <input
                ref={stickerFileInputRef}
                type="file" accept="image/*" className="hidden"
                onChange={event => {
                  if (event.target.files?.[0]) {
                    handleStickerUpload(event.target.files[0]);
                    event.target.value = "";
                  }
                }}
              />
            </label>

            {selectedElement && (
              <button
                onClick={deleteSelectedElement}
                className="px-3 py-1 rounded text-sm border border-red-300 text-red-500 hover:bg-red-50"
              >
                刪除選取
              </button>
            )}

            <button
              onClick={handleDeletePage}
              className="px-3 py-1 rounded text-sm border border-red-200 text-red-400 hover:bg-red-50"
            >
              刪除此頁
            </button>

            <button
              onClick={handleSaveLayout}
              disabled={isSaving}
              className="ml-auto px-4 py-1 rounded text-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {isSaving ? "儲存中..." : "儲存"}
            </button>
          </div>

          {/* 畫布本體 */}
          <div
            ref={canvasRef}
            style={{
              width: CANVAS_DISPLAY_WIDTH,
              height: CANVAS_DISPLAY_HEIGHT,
              position: "relative",
              cursor: rotatingState ? "grabbing" : activeTool === "select" ? "default" : "crosshair",
            }}
            className="border border-gray-300 rounded overflow-hidden bg-white select-none"
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}
          >
            {/* 背景圖層 */}
            {backgroundUrl && (
              <img
                src={backgroundUrl}
                style={{
                  position: "absolute", inset: 0,
                  width: "100%", height: "100%",
                  objectFit: "cover", pointerEvents: "none",
                }}
                alt=""
                draggable={false}
              />
            )}

            {!backgroundUrl && (
              <div
                style={{
                  position: "absolute", inset: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
                className="text-gray-300 text-sm pointer-events-none"
              >
                請上傳背景圖
              </div>
            )}

            {/* 照片格層 */}
            {pageLayout?.photo_slots?.map(photoSlot => {
              const isSelected = selectedElement?.type === "photo" && selectedElement?.id === photoSlot.id;
              const hasBorder = photoSlot.border !== false;
              const borderDisplayWidth = toDisplayCoord(photoSlot.border_width ?? 8);
              const slotDisplayRadius = toDisplayCoord(photoSlot.border_radius ?? 0);
              const shadowEnabled = photoSlot.shadow_enabled ?? hasBorder;
              const shadowX = toDisplayCoord(photoSlot.shadow_offset_x ?? 5);
              const shadowY = toDisplayCoord(photoSlot.shadow_offset_y ?? 8);
              const shadowBlur = toDisplayCoord(photoSlot.shadow_blur ?? 14);
              const shadowOpacity = ((photoSlot.shadow_opacity ?? 120) / 255).toFixed(2);
              const boxShadow = shadowEnabled
                ? `${shadowX}px ${shadowY}px ${shadowBlur}px rgba(0,0,0,${shadowOpacity})`
                : "none";

              return (
                <div
                  key={photoSlot.id}
                  style={{
                    position: "absolute",
                    left: toDisplayCoord(photoSlot.x),
                    top: toDisplayCoord(photoSlot.y),
                    width: toDisplayCoord(photoSlot.width),
                    height: toDisplayCoord(photoSlot.height),
                    transform: `rotate(${photoSlot.rotation}deg)`,
                    transformOrigin: "center",
                    background: hasBorder ? "#ffffff" : "#EEEEEE",
                    boxShadow,
                    borderRadius: slotDisplayRadius,
                    outline: isSelected
                      ? "2px solid #4F46E5"
                      : hasBorder ? "1px solid #e2e8f0" : "1px solid #CCCCCC",
                    outlineOffset: isSelected ? 2 : 0,
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    overflow: "hidden",
                  }}
                >
                  {/* 拍立得內部照片區（空槽標籤） */}
                  {hasBorder ? (
                    <div style={{
                      position: "absolute",
                      left: borderDisplayWidth, top: borderDisplayWidth,
                      right: borderDisplayWidth, bottom: borderDisplayWidth * 2,
                      background: "#EEEEEE",
                      borderRadius: Math.max(0, slotDisplayRadius - borderDisplayWidth),
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none" }}>
                        P{currentPageIndex + 1}·{photoSlot.id}
                      </span>
                    </div>
                  ) : (
                    <div style={{
                      position: "absolute", inset: 0,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none" }}>
                        P{currentPageIndex + 1}·{photoSlot.id}
                      </span>
                    </div>
                  )}

                  {/* 選取把手 */}
                  {isSelected && (
                    <>
                      {/* 縮放把手（右下角） */}
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto",
                      }} />
                      {/* 旋轉把手（頂部中央） */}
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute", top: -28, left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto", cursor: "grab",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        }}
                        onMouseDown={event => startRotating(event, "photo", photoSlot.id)}
                      >
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: "#fff", border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* 氣泡框層 */}
            {pageLayout?.text_bubbles?.map(bubble => {
              const isSelected = selectedElement?.type === "bubble" && selectedElement?.id === bubble.id;
              const displayWidth = toDisplayCoord(bubble.width);
              const displayHeight = toDisplayCoord(bubble.height);
              const displayBorderRadius = bubble.border_radius != null
                ? toDisplayCoord(bubble.border_radius)
                : Math.round(Math.min(displayWidth, displayHeight) / 5);
              const displayBorderWidth = bubble.border_width > 0 ? toDisplayCoord(bubble.border_width) : 0;

              return (
                <div
                  key={bubble.id}
                  style={{
                    position: "absolute",
                    left: toDisplayCoord(bubble.x),
                    top: toDisplayCoord(bubble.y),
                    width: displayWidth,
                    height: displayHeight,
                    transform: `rotate(${bubble.rotation ?? 0}deg)`,
                    transformOrigin: "center",
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  <BubbleSVG
                    displayWidth={displayWidth}
                    displayHeight={displayHeight}
                    fill={bubble.fill}
                    borderColor={bubble.border_color}
                    borderWidth={displayBorderWidth}
                    shape={bubble.shape ?? "ellipse"}
                    borderRadius={displayBorderRadius}
                    isSelected={isSelected}
                  />
                  {/* 氣泡預覽文字 */}
                  <span style={{
                    position: "absolute", inset: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: Math.max(8, toDisplayCoord(bubble.font_size ?? 20)),
                    color: bubble.font_color,
                    textAlign: "center", padding: 4, lineHeight: 1.3,
                    overflow: "hidden", pointerEvents: "none",
                    fontFamily: getFontCss(bubble.font_family),
                    fontWeight: isFontBold(bubble.font_family) ? "bold" : "normal",
                  }}>
                    {bubble.text?.substring(0, 30)}
                  </span>

                  {isSelected && (
                    <>
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto",
                      }} />
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute", top: -28, left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto", cursor: "grab",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        }}
                        onMouseDown={event => startRotating(event, "bubble", bubble.id)}
                      >
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: "#fff", border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            {/* 貼圖層 */}
            {(pageLayout?.stickers || []).map(sticker => {
              const isSelected = selectedElement?.type === "sticker" && selectedElement?.id === sticker.id;
              return (
                <div
                  key={sticker.id}
                  style={{
                    position: "absolute",
                    left: toDisplayCoord(sticker.x),
                    top: toDisplayCoord(sticker.y),
                    width: toDisplayCoord(sticker.width),
                    height: toDisplayCoord(sticker.height),
                    transform: `rotate(${sticker.rotation ?? 0}deg)`,
                    transformOrigin: "center",
                    outline: isSelected ? "2px solid #4F46E5" : "none",
                    outlineOffset: 2,
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  <img
                    src={buildStickerUrl(templateId, sticker.filename)}
                    alt=""
                    draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                  />
                  {isSelected && (
                    <>
                      <div style={{
                        position: "absolute", bottom: -4, right: -4,
                        width: 12, height: 12, background: "#4F46E5",
                        borderRadius: 2, cursor: "se-resize", pointerEvents: "auto",
                      }} />
                      <div
                        title="拖曳旋轉（Shift=15°對齊）"
                        style={{
                          position: "absolute", top: -28, left: "50%",
                          transform: "translateX(-50%)",
                          pointerEvents: "auto", cursor: "grab",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        }}
                        onMouseDown={event => startRotating(event, "sticker", sticker.id)}
                      >
                        <div style={{ width: 1, height: 10, background: "#4F46E5" }} />
                        <div style={{
                          width: 14, height: 14, borderRadius: "50%",
                          background: "#fff", border: "2px solid #4F46E5",
                          boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                        }} />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-gray-400 mt-1">
            提示：點選工具後在畫布上點擊放置；拖曳移動；右下角拖曳調整大小
          </p>
        </div>

        {/* 右側：屬性面板 */}
        <div className="flex-1 min-w-0">
          {selectedElement && selectedItem ? (
            <PropertyPanel
              selectedElement={selectedElement}
              elementData={selectedItem}
              onPropertyChange={(updates) => updateElement(selectedElement.type, selectedElement.id, updates)}
            />
          ) : (
            <div className="text-gray-400 text-sm mt-8">點選畫布上的元素以編輯屬性</div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── 屬性面板元件 ──────────────────────────────────────────────────────────────

/**
 * 右側屬性面板：依選取元素類型顯示對應的可編輯屬性。
 *
 * @param {Object}   selectedElement    - 目前選取的元素識別資訊 { type, id }
 * @param {Object}   elementData        - 元素的完整屬性資料
 * @param {Function} onPropertyChange   - 屬性變更時的回呼函式
 */
function PropertyPanel({ selectedElement, elementData, onPropertyChange }) {
  const isPhotoSlot = selectedElement.type === "photo";
  const isBubble = selectedElement.type === "bubble";
  const isSticker = selectedElement.type === "sticker";

  return (
    <div className="bg-white border rounded-lg p-4 space-y-4">
      <h3 className="font-semibold">
        {isPhotoSlot ? "📷 照片格屬性" : isSticker ? "🖼️ 貼圖素材屬性" : "💬 氣泡框屬性"}
      </h3>

      {/* 通用：位置與尺寸 */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { key: "x",      label: "X 位置" },
          { key: "y",      label: "Y 位置" },
          { key: "width",  label: "寬度" },
          { key: "height", label: "高度" },
        ].map(field => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">{field.label}</span>
            <input
              type="number"
              value={elementData[field.key] ?? 0}
              onChange={event => onPropertyChange({ [field.key]: Number(event.target.value) })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>
        ))}
      </div>

      {/* 通用：旋轉角度 */}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">旋轉角度（度）</span>
        <input
          type="number" step="0.5"
          value={elementData.rotation ?? 0}
          onChange={event => onPropertyChange({ rotation: Number(event.target.value) })}
          className="border rounded px-2 py-1 text-sm w-24"
        />
      </label>

      {/* 照片格專屬屬性 */}
      {isPhotoSlot && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={elementData.border ?? true}
              onChange={event => onPropertyChange({ border: event.target.checked })}
            />
            <span className="text-sm">白色外框（拍立得風格）</span>
          </label>

          {elementData.border && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">外框寬度</span>
              <input
                type="number"
                value={elementData.border_width ?? 8}
                onChange={event => onPropertyChange({ border_width: Number(event.target.value) })}
                className="border rounded px-2 py-1 text-sm w-24"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">圓角半徑（px）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="0"
                max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                value={elementData.border_radius ?? 0}
                onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="0"
                max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                value={elementData.border_radius ?? 0}
                onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          {/* 陰影設定 */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={elementData.shadow_enabled ?? (elementData.border !== false)}
                onChange={event => onPropertyChange({ shadow_enabled: event.target.checked })}
              />
              <span className="text-sm font-medium text-gray-700">陰影</span>
            </label>

            {(elementData.shadow_enabled ?? (elementData.border !== false)) && (
              <div className="space-y-2 pl-1">
                {[
                  { key: "shadow_offset_x", label: "偏移 X", defaultValue: 5,  min: -30, max: 30 },
                  { key: "shadow_offset_y", label: "偏移 Y", defaultValue: 8,  min: -30, max: 30 },
                  { key: "shadow_blur",     label: "模糊",   defaultValue: 14, min: 0,   max: 40 },
                ].map(shadowField => (
                  <label key={shadowField.key} className="flex flex-col gap-0.5">
                    <span className="text-xs text-gray-500">{shadowField.label}</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={shadowField.min} max={shadowField.max}
                        value={elementData[shadowField.key] ?? shadowField.defaultValue}
                        onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                        className="flex-1"
                      />
                      <input
                        type="number"
                        min={shadowField.min} max={shadowField.max}
                        value={elementData[shadowField.key] ?? shadowField.defaultValue}
                        onChange={event => onPropertyChange({ [shadowField.key]: Number(event.target.value) })}
                        className="border rounded px-1 py-1 text-sm w-14 text-center"
                      />
                    </div>
                  </label>
                ))}

                {/* 陰影不透明度 */}
                <label className="flex flex-col gap-0.5">
                  <span className="text-xs text-gray-500">不透明度（%）</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min="0" max="100"
                      value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={event =>
                        onPropertyChange({ shadow_opacity: Math.round(Number(event.target.value) / 100 * 255) })
                      }
                      className="flex-1"
                    />
                    <input
                      type="number" min="0" max="100"
                      value={Math.round(((elementData.shadow_opacity ?? 120) / 255) * 100)}
                      onChange={event =>
                        onPropertyChange({ shadow_opacity: Math.round(Number(event.target.value) / 100 * 255) })
                      }
                      className="border rounded px-1 py-1 text-sm w-14 text-center"
                    />
                  </div>
                </label>
              </div>
            )}
          </div>
        </>
      )}

      {/* 氣泡框專屬屬性 */}
      {isBubble && (
        <>
          {/* 形狀選擇器 */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">形狀</span>
            <div className="grid grid-cols-5 gap-1">
              {BUBBLE_SHAPES.map(shapeOption => (
                <button
                  key={shapeOption.value}
                  onClick={() => onPropertyChange({ shape: shapeOption.value })}
                  title={shapeOption.label}
                  className={`flex flex-col items-center gap-0.5 py-1.5 rounded border text-xs transition-colors ${
                    elementData.shape === shapeOption.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-600"
                  }`}
                >
                  <span className="text-base leading-none">{shapeOption.icon}</span>
                  <span className="text-[10px]">{shapeOption.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 圓角（非橢圓形狀才顯示） */}
          {elementData.shape !== "ellipse" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">圓角半徑（px）</span>
              <div className="flex items-center gap-2">
                <input
                  type="range" min="0"
                  max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                  value={
                    elementData.border_radius ??
                    Math.round(Math.min(elementData.width, elementData.height) / 5)
                  }
                  onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                  className="flex-1"
                />
                <input
                  type="number" min="0"
                  max={Math.round(Math.min(elementData.width, elementData.height) / 2)}
                  value={
                    elementData.border_radius ??
                    Math.round(Math.min(elementData.width, elementData.height) / 5)
                  }
                  onChange={event => onPropertyChange({ border_radius: Number(event.target.value) })}
                  className="border rounded px-1 py-1 text-sm w-14 text-center"
                />
              </div>
            </label>
          )}

          <ColorPicker
            label="背景顏色"
            value={elementData.fill}
            onChange={colorValue => onPropertyChange({ fill: colorValue })}
          />

          {/* 預設文字 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">預設文字（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

          {/* 字體選擇 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <div className="grid grid-cols-2 gap-1.5">
              {FONT_OPTIONS.map(fontOption => (
                <button
                  key={fontOption.value}
                  onClick={() => onPropertyChange({ font_family: fontOption.value })}
                  style={{
                    fontFamily: fontOption.css,
                    fontWeight: fontOption.bold ? "bold" : "normal",
                  }}
                  className={`px-2 py-1.5 rounded border text-sm text-left truncate transition-colors ${
                    elementData.font_family === fontOption.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 hover:border-gray-300 text-gray-700"
                  }`}
                >
                  {fontOption.label}
                </button>
              ))}
            </div>
          </label>

          {/* 字級 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字級（pt）</span>
            <div className="flex items-center gap-2">
              <input
                type="range" min="10" max="72" step="1"
                value={elementData.font_size ?? 20}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="10" max="72"
                value={elementData.font_size ?? 20}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="border rounded px-1 py-1 text-sm w-14 text-center"
              />
            </div>
          </label>

          <ColorPicker
            label="文字顏色"
            value={elementData.font_color ?? "#333333"}
            onChange={colorValue => onPropertyChange({ font_color: colorValue })}
          />

          {/* 外框設定 */}
          <div className="space-y-2 pt-1 border-t border-gray-100">
            <span className="text-xs text-gray-500 block">外框</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={!!(elementData.border_color && (elementData.border_width ?? 0) > 0)}
                  onChange={event => onPropertyChange(
                    event.target.checked
                      ? { border_color: elementData.border_color || "#555555", border_width: elementData.border_width || 2 }
                      : { border_color: null, border_width: 0 }
                  )}
                />
                顯示外框
              </label>
              {elementData.border_color && (elementData.border_width ?? 0) > 0 && (
                <label className="flex items-center gap-1 text-xs text-gray-500 ml-auto">
                  粗細
                  <input
                    type="number" min="1" max="20"
                    value={elementData.border_width ?? 2}
                    onChange={event => onPropertyChange({ border_width: Number(event.target.value) })}
                    className="border rounded px-1 py-0.5 text-sm w-14 text-center"
                  />
                </label>
              )}
            </div>
            {elementData.border_color && (elementData.border_width ?? 0) > 0 && (
              <ColorPicker
                value={elementData.border_color ?? "#555555"}
                onChange={colorValue => onPropertyChange({ border_color: colorValue })}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
