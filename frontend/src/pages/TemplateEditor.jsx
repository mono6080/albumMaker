// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Stage, Layer, Rect, Image as KonvaImage, Text as KonvaText, Group, Shape, Transformer } from "react-konva";

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
import ColorPicker from "../components/ColorPicker";

// ── 畫布尺寸常數 ──────────────────────────────────────────────────────────────
const CANVAS_DISPLAY_WIDTH = 530;
const CANVAS_SCALE = CANVAS_DISPLAY_WIDTH / 794;
const CANVAS_DISPLAY_HEIGHT = Math.round(1123 * CANVAS_SCALE);

function toDisplayCoord(realValue) {
  return realValue * CANVAS_SCALE;
}

function toRealCoord(displayValue) {
  return Math.round(displayValue / CANVAS_SCALE);
}

function clampValue(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

const _Z_BASE = { photo: 0, bubble: 100, text: 200, sticker: 300 };

function getAllElementsSorted(layout) {
  if (!layout) return [];
  return [
    ...(layout.photo_slots  || []).map((e, i) => ({ type: "photo",   data: e, index: i, zDefault: _Z_BASE.photo   + i })),
    ...(layout.text_bubbles || []).map((e, i) => ({ type: "bubble",  data: e, index: i, zDefault: _Z_BASE.bubble  + i })),
    ...(layout.text_labels  || []).map((e, i) => ({ type: "text",    data: e, index: i, zDefault: _Z_BASE.text    + i })),
    ...(layout.stickers     || []).map((e, i) => ({ type: "sticker", data: e, index: i, zDefault: _Z_BASE.sticker + i })),
  ].sort((a, b) => (a.data.z_index ?? a.zDefault) - (b.data.z_index ?? b.zDefault));
}

function getNextZIndex(layout) {
  const all = getAllElementsSorted(layout);
  if (all.length === 0) return 0;
  return Math.max(...all.map(e => e.data.z_index ?? e.zDefault)) + 1;
}

function applyElementsToLayout(layout, sortedElements) {
  const keyMap = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };
  const newLayout = { ...layout };
  for (const { type, data } of sortedElements) {
    const key = keyMap[type];
    newLayout[key] = (newLayout[key] || []).map(e => e.id === data.id ? data : e);
  }
  return newLayout;
}

// ── Canvas 2D 圓角矩形路徑 ────────────────────────────────────────────────────
function drawRoundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── 氣泡框 Konva Shape 元件 ───────────────────────────────────────────────────

/**
 * 以 Canvas 2D sceneFunc 繪製氣泡形狀，幾何計算與 BubbleSVG.jsx 保持一致。
 */
function BubbleKonvaShape({ width: w, height: h, shape, fill, borderColor, borderWidth, borderRadius }) {
  const hasStroke = !!(borderColor && borderWidth > 0);
  const defaultBorderRadius = Math.round(Math.min(w, h) / 5);
  const cornerRadius = Math.max(0, borderRadius ?? defaultBorderRadius);
  const tailHeight = Math.round(h / 4);
  const tailWidth = Math.round(w / 5);
  const centerX = w / 2;
  const centerY = h / 2;

  const sceneFunc = useCallback((context) => {
    const ctx = context._context;
    ctx.save();

    const doFill = () => { ctx.fillStyle = fill; ctx.fill(); };
    const doStroke = () => {
      if (hasStroke) {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = borderWidth;
        ctx.stroke();
      }
    };

    if (shape === "rect") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();

    } else if (shape === "speech_right") {
      const tipY = h * 3 / 4;
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(w - 2, tipY - tailHeight / 2);
      ctx.lineTo(w - 2, tipY + tailHeight / 2);
      ctx.lineTo(w + tailWidth, tipY);
      ctx.closePath();
      doFill();
      if (hasStroke) doStroke();

    } else if (shape === "speech_left") {
      const tipY = h * 3 / 4;
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(2, tipY - tailHeight / 2);
      ctx.lineTo(2, tipY + tailHeight / 2);
      ctx.lineTo(-tailWidth, tipY);
      ctx.closePath();
      doFill();
      if (hasStroke) doStroke();

    } else if (shape === "speech_bottom") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(centerX - tailWidth / 2, h - 2);
      ctx.lineTo(centerX + tailWidth / 2, h - 2);
      ctx.lineTo(centerX, h + tailHeight);
      ctx.closePath();
      doFill();

    } else if (shape === "speech_top") {
      drawRoundRectPath(ctx, 0, 0, w, h, cornerRadius);
      doFill(); doStroke();
      ctx.beginPath();
      ctx.moveTo(centerX - tailWidth / 2, 2);
      ctx.lineTo(centerX + tailWidth / 2, 2);
      ctx.lineTo(centerX, -tailHeight);
      ctx.closePath();
      doFill();

    } else if (shape === "cloud") {
      const bodyTopY = h * 2 / 5;
      const cloudRadius = Math.min(cornerRadius, h / 4);
      const bumpCount = Math.max(3, Math.floor(w / 60));
      const bumpRadius = Math.floor(w / (bumpCount * 2));
      drawRoundRectPath(ctx, 0, bodyTopY, w, h - bodyTopY, cloudRadius);
      doFill();
      for (let i = 0; i < bumpCount; i++) {
        const bumpCenterX = bumpRadius + i * (w - bumpRadius * 2) / Math.max(bumpCount - 1, 1);
        ctx.beginPath();
        ctx.arc(bumpCenterX, bodyTopY, bumpRadius, 0, Math.PI * 2);
        doFill();
      }
      if (hasStroke) {
        drawRoundRectPath(ctx, 0, bodyTopY, w, h - bodyTopY, cloudRadius);
        doStroke();
      }

    } else if (shape === "star") {
      const outerRadius = Math.min(w, h) / 2;
      const innerRadius = outerRadius * 2 / 5;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const angle = Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const px = centerX + radius * Math.cos(angle);
        const py = centerY - radius * Math.sin(angle);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      doFill(); doStroke();

    } else if (shape === "heart") {
      const halfWidth = Math.floor(w / 2);
      const lowerH = Math.round(h * 0.55);
      ctx.beginPath();
      ctx.ellipse((halfWidth + 4) / 2, lowerH, (halfWidth + 4) / 2, lowerH, 0, 0, Math.PI * 2);
      doFill();
      ctx.beginPath();
      ctx.ellipse((halfWidth - 4 + w) / 2, lowerH, (w - (halfWidth - 4)) / 2, lowerH, 0, 0, Math.PI * 2);
      doFill();
      ctx.beginPath();
      ctx.moveTo(0, lowerH);
      ctx.lineTo(w, lowerH);
      ctx.lineTo(centerX, h);
      ctx.closePath();
      doFill();

    } else if (shape === "diamond") {
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(w, centerY);
      ctx.lineTo(centerX, h);
      ctx.lineTo(0, centerY);
      ctx.closePath();
      doFill(); doStroke();

    } else {
      // 預設：橢圓
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w / 2, h / 2, 0, 0, Math.PI * 2);
      doFill(); doStroke();
    }

    ctx.restore();
  }, [w, h, shape, fill, borderColor, borderWidth, hasStroke, cornerRadius, tailHeight, tailWidth, centerX, centerY]);

  return (
    <Shape
      width={w} height={h}
      sceneFunc={sceneFunc}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}

// ── 貼圖 Konva 節點（非同步載入圖片） ─────────────────────────────────────────

function StickerNode({ sticker, templateId, isSelected, groupProps }) {
  const [image, setImage] = useState(null);
  const displayW = groupProps.width;
  const displayH = groupProps.height;

  useEffect(() => {
    const img = new window.Image();
    img.src = buildStickerUrl(templateId, sticker.filename);
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
  }, [sticker.filename, templateId]);

  return (
    <Group {...groupProps}>
      {image && (
        <KonvaImage image={image} width={displayW} height={displayH} listening={false} />
      )}
      {isSelected && (
        <Rect
          width={displayW} height={displayH}
          fill="transparent"
          stroke="#4F46E5" strokeWidth={2}
          listening={false}
        />
      )}
      {/* 透明矩形作為點擊感應區 */}
      <Rect width={displayW} height={displayH} fill="transparent" />
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function TemplateEditor() {
  const { id: templateId } = useParams();
  const navigate = useNavigate();

  const [template, setTemplate] = useState(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageLayout, setPageLayout] = useState(null);
  const [selectedElement, setSelectedElement] = useState(null);
  const [backgroundUrl, setBackgroundUrl] = useState(null);
  const [bgImage, setBgImage] = useState(null);
  const [activeTool, setActiveTool] = useState("select");
  const [isSaving, setIsSaving] = useState(false);
  const [bgCropFile, setBgCropFile] = useState(null);

  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const stickerFileInputRef = useRef(null);
  const draftLayouts = useRef({});

  // ── 背景圖載入 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!backgroundUrl) { setBgImage(null); return; }
    const img = new window.Image();
    img.src = backgroundUrl;
    img.onload = () => setBgImage(img);
    img.onerror = () => setBgImage(null);
  }, [backgroundUrl]);

  // ── Transformer 同步選取節點 ─────────────────────────────────────────────
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr || !stageRef.current) return;
    if (selectedElement) {
      const node = stageRef.current.findOne(`#${selectedElement.type}-${selectedElement.id}`);
      if (node) {
        tr.nodes([node]);
      } else {
        tr.nodes([]);
      }
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedElement, pageLayout]);

  // ── 載入與頁面切換 ────────────────────────────────────────────────────────

  const loadTemplate = useCallback(() => {
    fetchTemplate(templateId).then(response => {
      setTemplate(response.data);
      const pages = response.data.pages;
      if (pages.length > 0) {
        const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
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

  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const safePage = pages[Math.min(currentPageIndex, pages.length - 1)];
    setPageLayout(draftLayouts.current[safePage.id] ?? safePage.layout);
    setSelectedElement(null);
    setBackgroundUrl(
      safePage.background_filename
        ? `/api/templates/${templateId}/pages/${safePage.id}/background?t=${Date.now()}`
        : null
    );
  }, [currentPageIndex, template, templateId]);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  useEffect(() => {
    if (currentPage && pageLayout) {
      draftLayouts.current[currentPage.id] = pageLayout;
    }
  }, [pageLayout, currentPage]);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = async () => {
    if (!template) return;
    setIsSaving(true);
    try {
      const dirtyPageIds = Object.keys(draftLayouts.current).map(Number);
      if (dirtyPageIds.length === 0) {
        toast.success("已儲存");
        setIsSaving(false);
        return;
      }
      await Promise.all(
        template.pages
          .filter(page => dirtyPageIds.includes(page.id))
          .map(page => updatePageLayout(templateId, page.id, draftLayouts.current[page.id]))
      );
      dirtyPageIds.forEach(pageId => { delete draftLayouts.current[pageId]; });
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

  // ── 元素操作 ──────────────────────────────────────────────────────────────

  const getElement = ({ type, id }) => {
    if (!pageLayout) return null;
    if (type === "photo")   return pageLayout.photo_slots.find(slot => slot.id === id);
    if (type === "bubble")  return pageLayout.text_bubbles.find(bubble => bubble.id === id);
    if (type === "text")    return (pageLayout.text_labels || []).find(label => label.id === id);
    if (type === "sticker") return (pageLayout.stickers || []).find(sticker => sticker.id === id);
    return null;
  };

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

  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    setPageLayout(currentLayout => {
      const sorted = getAllElementsSorted(currentLayout);
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

  // Delete / Backspace 鍵盤快捷鍵
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.key !== "Delete" && keyEvent.key !== "Backspace") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      deleteSelectedElement();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelectedElement]);

  // ── Konva Stage 事件：放置元素 or 取消選取 ───────────────────────────────

  const handleStageClick = (e) => {
    if (!pageLayout) return;
    const pos = stageRef.current.getPointerPosition();
    const realX = toRealCoord(pos.x);
    const realY = toRealCoord(pos.y);

    if (activeTool === "addPhoto") {
      const newSlot = {
        id: generateElementId(),
        x: realX, y: realY,
        width: 300, height: 220, rotation: 0,
        border: true, border_width: 8,
        z_index: getNextZIndex(pageLayout),
      };
      setPageLayout(currentLayout => ({
        ...currentLayout,
        photo_slots: [...currentLayout.photo_slots, newSlot],
      }));
      setActiveTool("select");
      setSelectedElement({ type: "photo", id: newSlot.id });
      return;
    }

    if (activeTool === "addBubble") {
      const newBubble = {
        id: generateElementId(),
        x: realX, y: realY,
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

    if (activeTool === "addText") {
      const newTextLabel = {
        id: generateElementId(),
        x: realX, y: realY,
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

    // 選取模式：點擊空白處取消選取
    if (e.target === stageRef.current) {
      setSelectedElement(null);
    }
  };

  // ── 元素 Group 共用 Konva 屬性 ────────────────────────────────────────────

  const makeGroupProps = (type, data) => {
    const displayX = toDisplayCoord(data.x);
    const displayY = toDisplayCoord(data.y);
    const displayW = toDisplayCoord(data.width);
    const displayH = toDisplayCoord(data.height);
    const isSelectMode = activeTool === "select";

    return {
      id: `${type}-${data.id}`,
      x: displayX + displayW / 2,
      y: displayY + displayH / 2,
      offsetX: displayW / 2,
      offsetY: displayH / 2,
      width: displayW,
      height: displayH,
      rotation: data.rotation ?? 0,
      scaleX: 1,
      scaleY: 1,
      draggable: isSelectMode,
      listening: isSelectMode,
      onDragEnd: (e) => {
        const node = e.target;
        updateElement(type, data.id, {
          x: clampValue(toRealCoord(node.x() - node.offsetX()), 0, 794 - data.width),
          y: clampValue(toRealCoord(node.y() - node.offsetY()), 0, 1123 - data.height),
        });
      },
      onTransformEnd: (e) => {
        const node = e.target;
        const newDisplayW = Math.max(toDisplayCoord(60), node.width() * Math.abs(node.scaleX()));
        const newDisplayH = Math.max(toDisplayCoord(40), node.height() * Math.abs(node.scaleY()));
        // 正規化 scale 並更新 offset，保持中心旋轉軸正確
        node.scaleX(1); node.scaleY(1);
        node.offsetX(newDisplayW / 2); node.offsetY(newDisplayH / 2);
        node.width(newDisplayW); node.height(newDisplayH);
        updateElement(type, data.id, {
          x: toRealCoord(node.x() - node.offsetX()),
          y: toRealCoord(node.y() - node.offsetY()),
          width: Math.max(60, toRealCoord(newDisplayW)),
          height: Math.max(40, toRealCoord(newDisplayH)),
          rotation: node.rotation(),
        });
      },
      onClick: (e) => {
        e.cancelBubble = true;
        setSelectedElement({ type, id: data.id });
      },
    };
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
          <div
            style={{ cursor: activeTool === "select" ? "default" : "crosshair" }}
            className="border border-gray-300 rounded overflow-hidden bg-white select-none"
          >
            <Stage
              ref={stageRef}
              width={CANVAS_DISPLAY_WIDTH}
              height={CANVAS_DISPLAY_HEIGHT}
              onClick={handleStageClick}
            >
              <Layer>
                {/* 白色底色 */}
                <Rect
                  x={0} y={0}
                  width={CANVAS_DISPLAY_WIDTH}
                  height={CANVAS_DISPLAY_HEIGHT}
                  fill="#ffffff"
                  listening={false}
                />

                {/* 背景圖 */}
                {bgImage ? (
                  <KonvaImage
                    image={bgImage}
                    x={0} y={0}
                    width={CANVAS_DISPLAY_WIDTH}
                    height={CANVAS_DISPLAY_HEIGHT}
                    listening={false}
                  />
                ) : (
                  <KonvaText
                    x={0}
                    y={CANVAS_DISPLAY_HEIGHT / 2 - 10}
                    width={CANVAS_DISPLAY_WIDTH}
                    text="請上傳背景圖"
                    fontSize={14}
                    fill="#CCCCCC"
                    align="center"
                    listening={false}
                  />
                )}

                {/* 所有元素依 z_index 統一排序渲染 */}
                {getAllElementsSorted(pageLayout).map(({ type, data, index: elemIndex }) => {
                  const isSelected = selectedElement?.type === type && selectedElement?.id === data.id;
                  const displayW = toDisplayCoord(data.width);
                  const displayH = toDisplayCoord(data.height);
                  const groupProps = makeGroupProps(type, data);

                  // ── 照片格 ──
                  if (type === "photo") {
                    const hasBorder = data.border !== false;
                    const borderDisplayW = toDisplayCoord(data.border_width ?? 8);
                    const slotRadius = toDisplayCoord(data.border_radius ?? 0);
                    const shadowEnabled = data.shadow_enabled ?? hasBorder;
                    const shadowX = shadowEnabled ? toDisplayCoord(data.shadow_offset_x ?? 5) : 0;
                    const shadowY = shadowEnabled ? toDisplayCoord(data.shadow_offset_y ?? 8) : 0;
                    // HTML Canvas2D shadowBlur 的 sigma = shadowBlur/2，PIL GaussianBlur(radius) 的實測 sigma ≈ radius*0.87
                    // 量測換算：需要 Canvas2D shadowBlur = toDisplayCoord(pil_blur) * 1.74 使兩者視覺一致
                    const shadowBlur = shadowEnabled ? toDisplayCoord(data.shadow_blur ?? 14) * 1.74 : 0;
                    const shadowOpacity = shadowEnabled ? (data.shadow_opacity ?? 120) / 255 : 0;

                    return (
                      <Group key={`photo-${data.id}`} {...groupProps}>
                        <Rect
                          width={displayW} height={displayH}
                          fill={hasBorder ? "#ffffff" : "#EEEEEE"}
                          cornerRadius={slotRadius}
                          stroke={isSelected ? "#4F46E5" : hasBorder ? "#e2e8f0" : "#CCCCCC"}
                          strokeWidth={isSelected ? 2 : 1}
                          shadowColor="black"
                          shadowOpacity={shadowOpacity}
                          shadowOffsetX={shadowX}
                          shadowOffsetY={shadowY}
                          shadowBlur={shadowBlur}
                          listening={false}
                        />
                        {hasBorder && (
                          <Rect
                            x={borderDisplayW}
                            y={borderDisplayW}
                            width={Math.max(1, displayW - borderDisplayW * 2)}
                            height={Math.max(1, displayH - borderDisplayW * 3)}
                            fill="#EEEEEE"
                            cornerRadius={Math.max(0, slotRadius - borderDisplayW)}
                            listening={false}
                          />
                        )}
                        <KonvaText
                          x={0} y={0}
                          width={displayW} height={displayH}
                          text={`P${currentPageIndex + 1}·${elemIndex + 1}`}
                          fontSize={10}
                          fill="#AAAAAA"
                          align="center"
                          verticalAlign="middle"
                          listening={false}
                        />
                        {/* 透明點擊感應區 */}
                        <Rect width={displayW} height={displayH} fill="transparent" />
                      </Group>
                    );
                  }

                  // ── 氣泡框 ──
                  if (type === "bubble") {
                    const displayBorderRadius = data.border_radius != null
                      ? toDisplayCoord(data.border_radius)
                      : Math.round(Math.min(displayW, displayH) / 5);
                    const displayBorderWidth = (data.border_width ?? 0) > 0
                      ? toDisplayCoord(data.border_width)
                      : 0;
                    const fontSize = Math.max(8, toDisplayCoord(data.font_size ?? 20));

                    return (
                      <Group key={`bubble-${data.id}`} {...groupProps}>
                        <BubbleKonvaShape
                          width={displayW} height={displayH}
                          shape={data.shape ?? "ellipse"}
                          fill={data.fill ?? "#FDED6E"}
                          borderColor={data.border_color}
                          borderWidth={displayBorderWidth}
                          borderRadius={displayBorderRadius}
                        />
                        <KonvaText
                          x={4} y={4}
                          width={displayW - 8} height={displayH - 8}
                          text={(data.text ?? "").substring(0, 30)}
                          fontSize={fontSize}
                          fill={data.font_color ?? "#333333"}
                          fontFamily={getFontCss(data.font_family)}
                          fontStyle={isFontBold(data.font_family) ? "bold" : "normal"}
                          align="center"
                          verticalAlign="middle"
                          wrap="word"
                          listening={false}
                        />
                        {isSelected && (
                          <Rect
                            width={displayW} height={displayH}
                            fill="transparent"
                            stroke="#4F46E5" strokeWidth={2}
                            listening={false}
                          />
                        )}
                        {/* 透明點擊感應區 */}
                        <Rect width={displayW} height={displayH} fill="transparent" />
                      </Group>
                    );
                  }

                  // ── 純文字 ──
                  if (type === "text") {
                    const fontSize = Math.max(8, toDisplayCoord(data.font_size ?? 24));
                    return (
                      <Group key={`text-${data.id}`} {...groupProps}>
                        <Rect
                          width={displayW} height={displayH}
                          fill="transparent"
                          stroke={isSelected ? "#4F46E5" : "#AAAAAA"}
                          strokeWidth={isSelected ? 2 : 1}
                          dash={isSelected ? [] : [4, 3]}
                          listening={false}
                        />
                        <KonvaText
                          x={4} y={0}
                          width={displayW - 8} height={displayH}
                          text={(data.text ?? "").substring(0, 60)}
                          fontSize={fontSize}
                          fill={data.font_color ?? "#333333"}
                          fontFamily={getFontCss(data.font_family)}
                          fontStyle={isFontBold(data.font_family) ? "bold" : "normal"}
                          align={data.text_align ?? "center"}
                          verticalAlign="middle"
                          wrap="word"
                          listening={false}
                        />
                        {/* 透明點擊感應區 */}
                        <Rect width={displayW} height={displayH} fill="transparent" />
                      </Group>
                    );
                  }

                  // ── 貼圖 ──
                  if (type === "sticker") {
                    return (
                      <StickerNode
                        key={`sticker-${data.id}`}
                        sticker={data}
                        templateId={templateId}
                        isSelected={isSelected}
                        groupProps={groupProps}
                      />
                    );
                  }

                  return null;
                })}

                {/* Transformer：顯示縮放/旋轉把手 */}
                <Transformer
                  ref={transformerRef}
                  keepRatio={false}
                  rotateEnabled={true}
                  borderStroke="#4F46E5"
                  borderStrokeWidth={1}
                  anchorFill="#4F46E5"
                  anchorStroke="#ffffff"
                  anchorStrokeWidth={1}
                  anchorSize={8}
                  rotateAnchorOffset={20}
                  enabledAnchors={[
                    "top-left", "top-center", "top-right",
                    "middle-left", "middle-right",
                    "bottom-left", "bottom-center", "bottom-right",
                  ]}
                  boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < toDisplayCoord(60) || newBox.height < toDisplayCoord(40)) {
                      return oldBox;
                    }
                    return newBox;
                  }}
                />
              </Layer>
            </Stage>
          </div>

          <p className="text-xs text-gray-400 mt-1.5">
            提示：點選工具後在畫布上點擊放置；拖曳移動；四角拖曳調整大小；頂部圓點旋轉
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

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">預設文字（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

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
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">文字內容（可用 {"{name}"} 代入姓名）</span>
            <textarea
              rows={3}
              value={elementData.text ?? ""}
              onChange={event => onPropertyChange({ text: event.target.value })}
              className="border rounded px-2 py-1 text-sm"
            />
          </label>

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

const CROP_FRAME_W = 397;
const CROP_FRAME_H = Math.round(1123 * (397 / 794));

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

  const fitScale = imgNat
    ? Math.max(CROP_FRAME_W / imgNat.w, CROP_FRAME_H / imgNat.h)
    : 1;
  const effectiveScale = fitScale * scale;

  const imgDisplayW = imgNat ? imgNat.w * effectiveScale : CROP_FRAME_W;
  const imgDisplayH = imgNat ? imgNat.h * effectiveScale : CROP_FRAME_H;

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
