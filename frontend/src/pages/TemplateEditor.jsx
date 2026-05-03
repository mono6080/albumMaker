// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Stage, Layer, Rect, Image as KonvaImage, Text as KonvaText, Group, Transformer } from "react-konva";

import {
  fetchTemplate,
  addTemplatePage,
  updatePageLayout,
  uploadBackground,
  deleteTemplatePage,
  uploadSticker,
} from "../api/templateApi";
import { getFontCss, isFontBold } from "../constants/fonts";
import ImageCropModal from "../components/ImageCropModal";
import BubbleKonvaShape from "../components/canvas/BubbleKonvaShape";
import StickerNode from "../components/canvas/StickerNode";
import PropertyPanel from "../components/PropertyPanel";
import ConfirmModal from "../components/ConfirmModal";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  applyElementsToLayout,
  getAllElementsSorted,
  getNextZIndex,
  getFooterModel,
  toDisplayCoord,
  toRealCoord,
} from "../utils/renderLayoutModel";

function clampValue(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

const ELEMENT_ARRAY_KEY = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

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
  const [confirmModal, setConfirmModal] = useState(null);

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

  // 套用單一頁面的 layout 與背景圖，供 loadTemplate 和頁碼切換共用
  const applyPageDisplay = useCallback((page) => {
    setPageLayout(draftLayouts.current[page.id] ?? page.layout);
    setBackgroundUrl(
      page.background_filename
        ? `/api/templates/${templateId}/pages/${page.id}/background?t=${Date.now()}`
        : null
    );
  }, [templateId]);

  const loadTemplate = useCallback(() => {
    fetchTemplate(templateId).then(response => {
      setTemplate(response.data);
      const pages = response.data.pages;
      if (pages.length > 0) {
        applyPageDisplay(pages[Math.min(currentPageIndex, pages.length - 1)]);
      }
    });
  }, [templateId, currentPageIndex, applyPageDisplay]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    applyPageDisplay(pages[Math.min(currentPageIndex, pages.length - 1)]);
    setSelectedElement(null);
  }, [currentPageIndex, template, applyPageDisplay]);

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

  const handleDeletePage = () => {
    if (!currentPage) return;
    setConfirmModal({
      message: "確定刪除此頁？",
      onConfirm: async () => {
        await deleteTemplatePage(templateId, currentPage.id);
        setCurrentPageIndex(Math.max(0, currentPageIndex - 1));
        await loadTemplate();
        toast.success("已刪除頁面");
      },
    });
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
    const arrayKey = ELEMENT_ARRAY_KEY[elementType];
    setPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => element.id === elementId ? { ...element, ...propertyUpdates } : element
      ),
    }));
  };

  const deleteSelectedElement = useCallback(() => {
    if (!selectedElement) return;
    const arrayKey = ELEMENT_ARRAY_KEY[selectedElement.type];
    setPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).filter(element => element.id !== selectedElement.id),
    }));
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

  // ── Stage 元素渲染函式（閉包存取 toDisplayCoord / currentPageIndex 等） ─────

  const renderPhotoSlotNode = (data, elemIndex, isSelected, groupProps) => {
    const displayW = toDisplayCoord(data.width);
    const displayH = toDisplayCoord(data.height);
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
  };

  const renderBubbleNode = (data, isSelected, groupProps) => {
    const displayW = toDisplayCoord(data.width);
    const displayH = toDisplayCoord(data.height);
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
  };

  const renderTextLabelNode = (data, isSelected, groupProps) => {
    const displayW = toDisplayCoord(data.width);
    const displayH = toDisplayCoord(data.height);
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
          lineHeight={data.line_height ?? 1.4}
          letterSpacing={toDisplayCoord(data.letter_spacing ?? 0)}
          listening={false}
        />
        {/* 透明點擊感應區 */}
        <Rect width={displayW} height={displayH} fill="transparent" />
      </Group>
    );
  };

  const renderFooterNode = (footer) => {
    if (!footer?.text) return null;
    const footerModel = getFooterModel(footer);
    return (
      <KonvaText
        key="footer"
        x={footerModel.box.x}
        y={footerModel.box.y}
        width={footerModel.box.width}
        height={footerModel.box.height}
        text={footerModel.text}
        fontSize={footerModel.fontSize}
        fill={footerModel.fontColor}
        fontFamily={getFontCss(footer.font_family)}
        fontStyle={isFontBold(footer.font_family) ? "bold" : "normal"}
        verticalAlign="middle"
        listening={false}
      />
    );
  };

  return (
    <div className="flex flex-col">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
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
        <ImageCropModal
          file={bgCropFile}
          title="裁切背景圖"
          hint="拖曳平移 · 滾輪縮放 · 裁切範圍固定為 A4 比例"
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
                  const groupProps = makeGroupProps(type, data);
                  if (type === "photo")   return renderPhotoSlotNode(data, elemIndex, isSelected, groupProps);
                  if (type === "bubble")  return renderBubbleNode(data, isSelected, groupProps);
                  if (type === "text")    return renderTextLabelNode(data, isSelected, groupProps);
                  if (type === "sticker") return (
                    <StickerNode
                      key={`sticker-${data.id}`}
                      sticker={data}
                      templateId={templateId}
                      isSelected={isSelected}
                      groupProps={groupProps}
                    />
                  );
                  return null;
                })}

                {renderFooterNode(pageLayout?.footer)}

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

