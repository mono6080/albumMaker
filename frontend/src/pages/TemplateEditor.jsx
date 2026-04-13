// 模板編輯器頁面
// 提供視覺化拖曳介面讓使用者設計相冊模板，
// 包含照片格、氣泡框、貼圖素材的新增、移動、縮放、旋轉與屬性編輯

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
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

// 各元素類型的預設 z_index 基底（確保未設定時維持原渲染順序）
const _Z_BASE = { photo: 0, bubble: 100, text: 200, sticker: 300 };

/** 取得所有元素（含類型、原始陣列索引），依 z_index 升序排列 */
function getAllElementsSorted(layout) {
  if (!layout) return [];
  return [
    ...(layout.photo_slots  || []).map((e, i) => ({ type: "photo",   data: e, index: i, zDefault: _Z_BASE.photo   + i })),
    ...(layout.text_bubbles || []).map((e, i) => ({ type: "bubble",  data: e, index: i, zDefault: _Z_BASE.bubble  + i })),
    ...(layout.text_labels  || []).map((e, i) => ({ type: "text",    data: e, index: i, zDefault: _Z_BASE.text    + i })),
    ...(layout.stickers     || []).map((e, i) => ({ type: "sticker", data: e, index: i, zDefault: _Z_BASE.sticker + i })),
  ].sort((a, b) => (a.data.z_index ?? a.zDefault) - (b.data.z_index ?? b.zDefault));
}

/** 取得目前佈局中最高的 z_index（新增元素時使其置於最上層） */
function getNextZIndex(layout) {
  const all = getAllElementsSorted(layout);
  if (all.length === 0) return 0;
  return Math.max(...all.map(e => e.data.z_index ?? e.zDefault)) + 1;
}

/** 將排序後的元素陣列（已修改 z_index）寫回佈局物件 */
function applyElementsToLayout(layout, sortedElements) {
  const keyMap = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };
  const newLayout = { ...layout };
  for (const { type, data } of sortedElements) {
    const key = keyMap[type];
    newLayout[key] = (newLayout[key] || []).map(e => e.id === data.id ? data : e);
  }
  return newLayout;
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
  // 各頁未儲存的草稿佈局（key = page id），換頁時暫存，避免修改丟失
  const draftLayouts = useRef({});

  // ── 載入與頁面切換 ────────────────────────────────────────────────────────

  const loadTemplate = useCallback(() => {
    fetchTemplate(templateId).then(response => {
      setTemplate(response.data);
      const pages = response.data.pages;
      if (pages.length > 0) {
        const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
        // 初次載入時優先使用記憶體中的草稿（例如已切換頁再切回來）
        setPageLayout(draftLayouts.current[safePage.id] ?? safePage.layout);
        setBackgroundUrl(
          safePage.background_filename
            ? `/api/templates/${templateId}/pages/${safePage.id}/background?t=${Date.now()}`
            : null
        );
      }
    });
  }, [templateId, currentPageIndex]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  // 切換頁面時更新佈局與背景圖（不自動儲存，改稿暫存在 draftLayouts）
  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
    // 優先讀取草稿，沒有草稿才回退到已儲存的佈局
    setPageLayout(draftLayouts.current[safePage.id] ?? safePage.layout);
    setSelectedElement(null);
    setBackgroundUrl(
      safePage.background_filename
        ? `/api/templates/${templateId}/pages/${safePage.id}/background?t=${Date.now()}`
        : null
    );
  }, [currentPageIndex, template, templateId]);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  // pageLayout 有任何變動時同步更新草稿，換頁時不會丟失
  useEffect(() => {
    if (currentPage && pageLayout) {
      draftLayouts.current[currentPage.id] = pageLayout;
    }
  }, [pageLayout, currentPage]);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = async () => {
    if (!pageLayout || !currentPage) return;
    setIsSaving(true);
    try {
      await updatePageLayout(templateId, currentPage.id, pageLayout);
      // 儲存成功後清除草稿，下次切回此頁直接讀已存資料
      delete draftLayouts.current[currentPage.id];
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

  const [bgCropFile, setBgCropFile] = useState(null);

  const handleBackgroundSelect = (event) => {
    const imageFile = event.target.files[0];
    if (!imageFile || !currentPage) return;
    setBgCropFile(imageFile);
    event.target.value = "";
  };

  const handleBgCropConfirm = async (croppedFile) => {
    setBgCropFile(null);
    await uploadBackground(templateId, currentPage.id, croppedFile);
    setBackgroundUrl(
      `/api/templates/${templateId}/pages/${currentPage.id}/background?t=${Date.now()}`
    );
    toast.success("背景已上傳");
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

  /** 從最上層往下逐層進行點擊碰撞測試，回傳被點到的元素識別資訊（依 z_index 由高到低） */
  const hitTestElement = (canvasPosition) => {
    if (!pageLayout) return null;
    const sortedDesc = getAllElementsSorted(pageLayout).reverse();
    for (const { type, data } of sortedDesc) {
      const displayX = toDisplayCoord(data.x);
      const displayY = toDisplayCoord(data.y);
      const displayW = toDisplayCoord(data.width);
      const displayH = toDisplayCoord(data.height);
      if (
        canvasPosition.x >= displayX && canvasPosition.x <= displayX + displayW &&
        canvasPosition.y >= displayY && canvasPosition.y <= displayY + displayH
      ) {
        return { type, id: data.id };
      }
    }
    return null;
  };

  /** 取得指定元素的資料物件 */
  const getElement = ({ type, id }) => {
    if (!pageLayout) return null;
    if (type === "photo") return pageLayout.photo_slots.find(slot => slot.id === id);
    if (type === "bubble") return pageLayout.text_bubbles.find(bubble => bubble.id === id);
    if (type === "text") return (pageLayout.text_labels || []).find(label => label.id === id);
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
      if (elementType === "text") {
        return {
          ...currentLayout,
          text_labels: (currentLayout.text_labels || []).map(label =>
            label.id === elementId ? { ...label, ...propertyUpdates } : label
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
  const deleteSelectedElement = useCallback(() => {
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
    } else if (selectedElement.type === "text") {
      setPageLayout(currentLayout => ({
        ...currentLayout,
        text_labels: (currentLayout.text_labels || []).filter(label => label.id !== selectedElement.id),
      }));
    } else if (selectedElement.type === "sticker") {
      setPageLayout(currentLayout => ({
        ...currentLayout,
        stickers: (currentLayout.stickers || []).filter(sticker => sticker.id !== selectedElement.id),
      }));
    }
    setSelectedElement(null);
  }, [selectedElement]);

  /** 調整選取元素的層次（上移/下移/移至最上/移至最底） */
  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    setPageLayout(currentLayout => {
      const sorted = getAllElementsSorted(currentLayout);
      // 正規化 z_index 為連續整數
      sorted.forEach((item, i) => { item.data = { ...item.data, z_index: i }; });
      const selectedIdx = sorted.findIndex(
        item => item.type === selectedElement.type && item.data.id === selectedElement.id
      );
      if (selectedIdx === -1) return currentLayout;

      if (direction === "up" && selectedIdx < sorted.length - 1) {
        const tmp = sorted[selectedIdx].data.z_index;
        sorted[selectedIdx].data     = { ...sorted[selectedIdx].data,     z_index: sorted[selectedIdx + 1].data.z_index };
        sorted[selectedIdx + 1].data = { ...sorted[selectedIdx + 1].data, z_index: tmp };
      } else if (direction === "down" && selectedIdx > 0) {
        const tmp = sorted[selectedIdx].data.z_index;
        sorted[selectedIdx].data     = { ...sorted[selectedIdx].data,     z_index: sorted[selectedIdx - 1].data.z_index };
        sorted[selectedIdx - 1].data = { ...sorted[selectedIdx - 1].data, z_index: tmp };
      } else if (direction === "top") {
        sorted[selectedIdx].data = { ...sorted[selectedIdx].data, z_index: sorted.length };
        sorted.sort((a, b) => a.data.z_index - b.data.z_index);
        sorted.forEach((item, i) => { item.data = { ...item.data, z_index: i }; });
      } else if (direction === "bottom") {
        sorted[selectedIdx].data = { ...sorted[selectedIdx].data, z_index: -1 };
        sorted.sort((a, b) => a.data.z_index - b.data.z_index);
        sorted.forEach((item, i) => { item.data = { ...item.data, z_index: i }; });
      }

      return applyElementsToLayout(currentLayout, sorted);
    });
  }, [selectedElement]);

  // Delete / Backspace 鍵盤快捷鍵刪除選取元素
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.key !== "Delete" && keyEvent.key !== "Backspace") return;
      // 避免在輸入框打字時觸發
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      deleteSelectedElement();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelectedElement]);

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
        z_index: getNextZIndex(pageLayout),
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
        z_index: getNextZIndex(pageLayout),
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        text_bubbles: [...currentLayout.text_bubbles, newBubble],
      }));
      setActiveTool("select");
      setSelectedElement({ type: "bubble", id: newBubble.id });
      return;
    }

    // 新增純文字工具
    if (activeTool === "addText") {
      const newTextLabel = {
        id: generateElementId(),
        x: toRealCoord(canvasPosition.x),
        y: toRealCoord(canvasPosition.y),
        width: 240, height: 80,
        rotation: 0,
        text: "{name}的文字標題",
        font_size: 28,
        font_color: "#3B6B8C",
        font_family: "msjh",
        text_align: "center",
        line_height: 1.4,
        z_index: getNextZIndex(pageLayout),
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        text_labels: [...(currentLayout.text_labels || []), newTextLabel],
      }));
      setActiveTool("select");
      setSelectedElement({ type: "text", id: newTextLabel.id });
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
    <div className="flex flex-col">
      {/* 頂部標題列 */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <button onClick={() => navigate("/templates")} className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回
        </button>
        <h1 className="text-lg font-bold">{template.name}</h1>
        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">模板編輯器</span>
        <div className="ml-auto flex items-center gap-2">
          {selectedElement && (
            <button
              onClick={deleteSelectedElement}
              className="px-3 py-1 text-sm rounded border border-red-300 text-red-500 hover:bg-red-50"
            >
              刪除選取
            </button>
          )}
          <button
            onClick={handleSaveLayout}
            disabled={isSaving}
            className="px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "儲存中..." : "儲存"}
          </button>
        </div>
      </div>

      {/* 背景裁切 Modal */}
      {bgCropFile && (
        <BackgroundCropModal
          file={bgCropFile}
          onConfirm={handleBgCropConfirm}
          onCancel={() => setBgCropFile(null)}
        />
      )}

      {/* 三欄主體 */}
      <div className="flex gap-4">
        {/* 左側工具欄 */}
        <div className="flex-shrink-0 w-40 flex flex-col gap-4" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }}>
          {/* 工具 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">工具</p>
            <div className="flex flex-col gap-1">
              {[
                { key: "select",    label: "↖ 選取" },
                { key: "addPhoto",  label: "＋ 照片格" },
                { key: "addText",   label: "＋ 純文字" },
              ].map(tool => (
                <button
                  key={tool.key}
                  onClick={() => setActiveTool(tool.key)}
                  className={`px-3 py-1.5 rounded text-sm text-left border transition-colors ${
                    activeTool === tool.key
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-700 hover:bg-gray-50 border-gray-200"
                  }`}
                >
                  {tool.label}
                </button>
              ))}
            </div>
          </div>

          {/* 素材 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">素材</p>
            <div className="flex flex-col gap-1">
              <label className="px-3 py-1.5 rounded text-sm text-left border bg-white hover:bg-gray-50 cursor-pointer text-gray-700 border-gray-200 transition-colors">
                ↑ 上傳背景
                <input type="file" accept="image/*" className="hidden" onChange={handleBackgroundSelect} />
              </label>
              <label className="px-3 py-1.5 rounded text-sm text-left border bg-white hover:bg-gray-50 cursor-pointer text-gray-700 border-gray-200 transition-colors">
                ＋ 貼圖素材
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
            </div>
          </div>

          {/* 頁面 */}
          <div className="flex flex-col flex-1 min-h-0">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">頁面</p>
            <div className="flex flex-col gap-1 overflow-y-auto flex-1">
              {template.pages.map((templatePage, pageTabIndex) => (
                <button
                  key={templatePage.id}
                  onClick={() => setCurrentPageIndex(pageTabIndex)}
                  className={`px-3 py-1.5 rounded text-sm text-left border transition-colors ${
                    currentPageIndex === pageTabIndex
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200"
                  }`}
                >
                  第 {pageTabIndex + 1} 頁
                </button>
              ))}
              <button
                onClick={handleAddPage}
                className="px-3 py-1.5 rounded text-sm text-left border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                ＋ 新增頁
              </button>
            </div>
            <button
              onClick={handleDeletePage}
              className="mt-2 px-3 py-1.5 rounded text-sm border border-red-200 text-red-400 hover:bg-red-50 transition-colors"
            >
              刪除此頁
            </button>
          </div>
        </div>

        {/* 中央畫布區 */}
        <div className="flex-shrink-0 flex flex-col">
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

            {/* 所有元素依 z_index 統一排序渲染 */}
            {getAllElementsSorted(pageLayout).map(({ type, data, index: elemIndex }) => {
              const isSelected = selectedElement?.type === type && selectedElement?.id === data.id;

              // ── 照片格 ──
              if (type === "photo") {
              const photoSlot = data;
              const slotIndex = elemIndex;
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
                // 外層：定位 + 旋轉 + 把手，overflow 保持 visible 才不截斷把手
                <div
                  key={`photo-${photoSlot.id}`}
                  style={{
                    position: "absolute",
                    left: toDisplayCoord(photoSlot.x),
                    top: toDisplayCoord(photoSlot.y),
                    width: toDisplayCoord(photoSlot.width),
                    height: toDisplayCoord(photoSlot.height),
                    transform: `rotate(${photoSlot.rotation}deg)`,
                    transformOrigin: "center",
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                >
                  {/* 內層：視覺樣式（圓角 / 陰影 / 外框），需 overflow hidden 裁切內容 */}
                  <div style={{
                    position: "absolute", inset: 0,
                    background: hasBorder ? "#ffffff" : "#EEEEEE",
                    boxShadow,
                    borderRadius: slotDisplayRadius,
                    outline: isSelected
                      ? "2px solid #4F46E5"
                      : hasBorder ? "1px solid #e2e8f0" : "1px solid #CCCCCC",
                    outlineOffset: isSelected ? 2 : 0,
                    boxSizing: "border-box",
                    overflow: "hidden",
                  }}>
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
                          P{currentPageIndex + 1}·{slotIndex + 1}
                        </span>
                      </div>
                    ) : (
                      <div style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <span style={{ fontSize: 10, color: "#AAAAAA", userSelect: "none" }}>
                          P{currentPageIndex + 1}·{slotIndex + 1}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 選取把手（放在外層，不受 overflow hidden 截斷） */}
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
              } // end photo

              // ── 氣泡框 ──
              if (type === "bubble") {
              const bubble = data;
              const isSelected = selectedElement?.type === "bubble" && selectedElement?.id === bubble.id;
              const displayWidth = toDisplayCoord(bubble.width);
              const displayHeight = toDisplayCoord(bubble.height);
              const displayBorderRadius = bubble.border_radius != null
                ? toDisplayCoord(bubble.border_radius)
                : Math.round(Math.min(displayWidth, displayHeight) / 5);
              const displayBorderWidth = bubble.border_width > 0 ? toDisplayCoord(bubble.border_width) : 0;

              return (
                <div
                  key={`bubble-${bubble.id}`}
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
              } // end bubble

              // ── 純文字 ──
              if (type === "text") {
              const textLabel = data;
              const isSelected = selectedElement?.type === "text" && selectedElement?.id === textLabel.id;
              return (
                <div
                  key={`text-${textLabel.id}`}
                  style={{
                    position: "absolute",
                    left: toDisplayCoord(textLabel.x),
                    top: toDisplayCoord(textLabel.y),
                    width: toDisplayCoord(textLabel.width),
                    height: toDisplayCoord(textLabel.height),
                    transform: `rotate(${textLabel.rotation ?? 0}deg)`,
                    transformOrigin: "center",
                    outline: isSelected ? "2px solid #4F46E5" : "1px dashed #AAAAAA",
                    outlineOffset: 2,
                    pointerEvents: "none",
                    overflow: "visible",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: textLabel.text_align === "left" ? "flex-start"
                      : textLabel.text_align === "right" ? "flex-end" : "center",
                  }}
                >
                  <span style={{
                    fontSize: Math.max(8, toDisplayCoord(textLabel.font_size ?? 24)),
                    color: textLabel.font_color ?? "#333333",
                    fontFamily: getFontCss(textLabel.font_family),
                    fontWeight: isFontBold(textLabel.font_family) ? "bold" : "normal",
                    textAlign: textLabel.text_align ?? "center",
                    padding: "0 4px",
                    userSelect: "none",
                    pointerEvents: "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    width: "100%",
                  }}>
                    {textLabel.text?.substring(0, 60)}
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
                        onMouseDown={event => startRotating(event, "text", textLabel.id)}
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
              } // end text

              // ── 貼圖 ──
              if (type === "sticker") {
              const sticker = data;
              const isSelected = selectedElement?.type === "sticker" && selectedElement?.id === sticker.id;
              return (
                <div
                  key={`sticker-${sticker.id}`}
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
              } // end sticker

              return null;
            })}
          </div>

          <p className="text-xs text-gray-400 mt-1.5">
            提示：點選工具後在畫布上點擊放置；拖曳移動；右下角拖曳調整大小
          </p>
        </div>

        {/* 右側：屬性面板 */}
        <div className="flex-1 min-w-0 overflow-y-auto" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }}>
          {selectedElement && selectedItem ? (
            <PropertyPanel
              selectedElement={selectedElement}
              elementData={selectedItem}
              onPropertyChange={(updates) => updateElement(selectedElement.type, selectedElement.id, updates)}
              onLayerChange={handleLayerChange}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-300 text-sm select-none" style={{ minHeight: 200 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3">
                <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" />
              </svg>
              <p>點選畫布元素</p>
              <p>以編輯屬性</p>
            </div>
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
 * @param {Function} onLayerChange      - 層次調整回呼 ('up'|'down'|'top'|'bottom')
 */
function PropertyPanel({ selectedElement, elementData, onPropertyChange, onLayerChange }) {
  const isPhotoSlot = selectedElement.type === "photo";
  const isBubble = selectedElement.type === "bubble";
  const isTextLabel = selectedElement.type === "text";
  const isSticker = selectedElement.type === "sticker";

  const panelTitle = isPhotoSlot ? "📷 照片格屬性"
    : isSticker ? "🖼️ 貼圖素材屬性"
    : isTextLabel ? "Ａ 純文字屬性"
    : "💬 氣泡框屬性";

  return (
    <div className="bg-white border rounded-lg p-4 space-y-4">
      <h3 className="font-semibold">{panelTitle}</h3>

      {/* 通用：層次控制 */}
      <div>
        <span className="text-xs text-gray-500 block mb-1">層次</span>
        <div className="flex gap-1">
          {[
            { dir: "bottom", label: "⬇ 最底" },
            { dir: "down",   label: "↓ 下移" },
            { dir: "up",     label: "↑ 上移" },
            { dir: "top",    label: "⬆ 最頂" },
          ].map(({ dir, label }) => (
            <button
              key={dir}
              onClick={() => onLayerChange(dir)}
              className="flex-1 px-1 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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

      {/* 純文字專屬屬性 */}
      {isTextLabel && (
        <>
          {/* 預設文字 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">文字內容（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

          {/* 對齊 */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">對齊</span>
            <div className="flex gap-1">
              {[
                { value: "left",   label: "靠左" },
                { value: "center", label: "置中" },
                { value: "right",  label: "靠右" },
              ].map(alignOption => (
                <button
                  key={alignOption.value}
                  onClick={() => onPropertyChange({ text_align: alignOption.value })}
                  className={`flex-1 px-2 py-1 rounded border text-sm transition-colors ${
                    (elementData.text_align ?? "center") === alignOption.value
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200"
                  }`}
                >
                  {alignOption.label}
                </button>
              ))}
            </div>
          </div>

          {/* 字體選擇 */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字體</span>
            <div className="grid grid-cols-2 gap-1.5">
              {FONT_OPTIONS.map(fontOption => (
                <button
                  key={fontOption.value}
                  onClick={() => onPropertyChange({ font_family: fontOption.value })}
                  style={{ fontFamily: fontOption.css, fontWeight: fontOption.bold ? "bold" : "normal" }}
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
                type="range" min="10" max="96" step="1"
                value={elementData.font_size ?? 28}
                onChange={event => onPropertyChange({ font_size: Number(event.target.value) })}
                className="flex-1"
              />
              <input
                type="number" min="10" max="96"
                value={elementData.font_size ?? 28}
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
        </>
      )}
    </div>
  );
}


// ── 背景裁切 Modal ─────────────────────────────────────────────────────────────

// 顯示尺寸：A4 比例 (794:1123)，以半尺寸呈現
const CROP_FRAME_W = 397;
const CROP_FRAME_H = Math.round(1123 * (397 / 794)); // ≈ 561

/**
 * 上傳背景前先讓使用者裁切至 A4 比例。
 * 支援拖曳平移與滾輪縮放，確認後以 canvas 輸出 794×1123 JPEG 並回傳。
 */
function BackgroundCropModal({ file, onConfirm, onCancel }) {
  const [scale, setScale] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [imgNat, setImgNat] = useState(null);
  const imgRef = useRef(null);
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // fitScale：讓圖片恰好覆蓋整個裁切框（object-fit: cover 效果）
  const fitScale = imgNat
    ? Math.max(CROP_FRAME_W / imgNat.w, CROP_FRAME_H / imgNat.h)
    : 1;
  const effectiveScale = fitScale * scale;

  const imgDisplayW = imgNat ? imgNat.w * effectiveScale : CROP_FRAME_W;
  const imgDisplayH = imgNat ? imgNat.h * effectiveScale : CROP_FRAME_H;

  // 限制平移範圍，確保圖片始終覆蓋裁切框
  const maxPanX = Math.max(0, (imgDisplayW - CROP_FRAME_W) / 2);
  const maxPanY = Math.max(0, (imgDisplayH - CROP_FRAME_H) / 2);
  const clampedPanX = Math.min(maxPanX, Math.max(-maxPanX, panX));
  const clampedPanY = Math.min(maxPanY, Math.max(-maxPanY, panY));

  const imgLeft = CROP_FRAME_W / 2 + clampedPanX - imgDisplayW / 2;
  const imgTop  = CROP_FRAME_H / 2 + clampedPanY - imgDisplayH / 2;

  const handleWheel = (wheelEvent) => {
    wheelEvent.preventDefault();
    const zoomFactor = wheelEvent.deltaY < 0 ? 1.1 : 0.9;
    setScale(currentScale => Math.max(1, Math.min(6, currentScale * zoomFactor)));
  };

  const handleMouseDown = (mouseEvent) => {
    isDragging.current = true;
    lastPos.current = { x: mouseEvent.clientX, y: mouseEvent.clientY };
  };
  const handleMouseMove = (mouseEvent) => {
    if (!isDragging.current) return;
    const deltaX = mouseEvent.clientX - lastPos.current.x;
    const deltaY = mouseEvent.clientY - lastPos.current.y;
    lastPos.current = { x: mouseEvent.clientX, y: mouseEvent.clientY };
    setPanX(prev => prev + deltaX);
    setPanY(prev => prev + deltaY);
  };
  const handleMouseUp = () => { isDragging.current = false; };

  const handleConfirm = () => {
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width  = 794;
    outputCanvas.height = 1123;
    const ctx = outputCanvas.getContext("2d");
    // renderScale：從顯示座標映射回 794×1123
    const renderScale = 794 / CROP_FRAME_W;
    ctx.drawImage(
      imgRef.current,
      imgLeft * renderScale,
      imgTop  * renderScale,
      imgDisplayW * renderScale,
      imgDisplayH * renderScale,
    );
    outputCanvas.toBlob(blob => {
      onConfirm(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-white rounded-xl shadow-2xl p-5 flex flex-col gap-4">
        <div>
          <h2 className="font-semibold text-gray-800">裁切背景圖</h2>
          <p className="text-xs text-gray-400 mt-0.5">拖曳平移 · 滾輪縮放 · 裁切範圍固定為 A4 比例</p>
        </div>

        {/* 裁切預覽框 */}
        <div
          style={{
            width: CROP_FRAME_W, height: CROP_FRAME_H,
            overflow: "hidden", position: "relative",
            cursor: isDragging.current ? "grabbing" : "grab",
            background: "#ddd",
          }}
          className="rounded border border-gray-300 select-none"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* A4 格線提示 */}
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1,
            boxShadow: "inset 0 0 0 2px rgba(99,102,241,0.5)",
          }} />
          <img
            ref={imgRef}
            src={url}
            onLoad={loadEvent => setImgNat({
              w: loadEvent.target.naturalWidth,
              h: loadEvent.target.naturalHeight,
            })}
            style={{
              position: "absolute",
              left: imgLeft, top: imgTop,
              width: imgDisplayW, height: imgDisplayH,
              pointerEvents: "none", userSelect: "none",
            }}
            draggable={false}
            alt=""
          />
        </div>

        {/* 縮放滑桿 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-8">縮放</span>
          <input
            type="range" min="1" max="6" step="0.01"
            value={scale}
            onChange={sliderEvent => setScale(Number(sliderEvent.target.value))}
            className="flex-1"
          />
          <span className="text-xs text-gray-400 w-10 text-right">{Math.round(scale * 100)}%</span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700"
          >
            確認裁切
          </button>
        </div>
      </div>
    </div>
  );
}
