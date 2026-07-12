// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性
// 分工：per-page 草稿/歷史在 hooks/useLayoutHistory、Konva 節點渲染在
// components/canvas/pageElementNodes、雙頁預覽與圖層清單為獨立 component

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Stage, Layer, Rect, Image as KonvaImage, Text as KonvaText, Transformer } from "react-konva";
import { BookOpen, Camera, CircleHelp, Redo2, Undo2 } from "lucide-react";

import {
  fetchTemplate,
  addTemplatePage,
  updatePageLayout,
  uploadBackground,
  deleteTemplatePage,
  uploadSticker,
} from "../api/templateApi";
import ImageCropModal from "../components/ImageCropModal";
import StickerNode from "../components/canvas/StickerNode";
import {
  applyPhotoEditorUpdates,
  clampPhotoContentRect,
  makeGroupProps,
  makePhotoControlProps,
  renderBubbleNode,
  renderFooterNode,
  renderPhotoSlotNode,
  renderTextLabelNode,
} from "../components/canvas/pageElementNodes";
import LayerListPanel from "../components/LayerListPanel";
import PropertyPanel from "../components/PropertyPanel";
import ConfirmModal from "../components/ConfirmModal";
import SpreadPreviewModal from "../components/SpreadPreviewModal";
import { Button } from "../components/ui";
import useLayoutHistory, { cloneLayout } from "../hooks/useLayoutHistory";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  ELEMENT_ARRAY_KEY,
  applyElementsToLayout,
  getAllElementsSorted,
  getInitialStickerSize,
  getNextZIndex,
  toDisplayCoord,
  toRealCoord,
} from "../utils/renderLayoutModel";
import {
  buildPhotoSlotFromContentRect,
  getPhotoContentRect,
  getPhotoSlotDimensionMode,
} from "../utils/photoFrameGeometry.js";
import { TEXT_LABEL_ROLES } from "../utils/textLabelRoles";
import { startProductGuide } from "../utils/productGuide";

const EDITOR_GUIDE_STEPS = [
  {
    element: '[data-guide="template-photo-count"]',
    title: "照片總計",
    description: "這裡統計整份模板的照片格總數，交付前要和企劃需求或班級照片規劃一致。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="tool-add-photo"]',
    title: "連續新增照片格",
    description: "照片格分 3:4 直式與 4:3 橫式兩種固定比例。選一次工具後，可以在畫布上連續點擊新增，不需要每新增一格就重新選工具。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="canvas-frame"]',
    title: "A4 畫布",
    description: "背景、照片格、文字和貼圖都在這裡排版。新增元素後切回選取工具再調整位置與尺寸。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="upload-background"]',
    title: "上傳背景",
    description: "每一頁都要各自上傳背景圖，建議使用 A4 直式比例。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="page-list"]',
    title: "頁面管理",
    description: "在這裡切換頁面、新增頁或刪除頁。切到不同頁面後再編輯該頁內容。",
    side: "right",
    align: "start",
  },
  {
    element: '[data-guide="history-actions"]',
    title: "復原與重做",
    description: "大幅調整前後可用復原、重做回到上一個版面狀態。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="spread-preview"]',
    title: "雙頁預覽",
    description: "用左右頁合併預覽檢查整本節奏、留白、照片數與主色是否平衡。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="save-template"]',
    title: "儲存模板",
    description: "調整版面後記得儲存。未儲存時離開頁面，後端預覽與專案會看不到最新修改。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="property-region"]',
    title: "屬性面板",
    description: "點選畫布元素後，這裡會出現位置、尺寸、照片框樣式、文字角色、陰影等精準設定。純排版文字可設為固定文字，避免老師端修改。",
    side: "left",
    align: "center",
  },
];

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function isKeyboardInputTarget(target) {
  const tagName = target?.tagName;
  return target?.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function countTemplatePhotoSlots(template, draftLayouts) {
  if (!template?.pages) return 0;
  return template.pages.reduce((total, page) => {
    const layout = draftLayouts[page.id] ?? page.layout;
    return total + (layout?.photo_slots?.length ?? 0);
  }, 0);
}

function getPhotoEditorElementData(slot, dimensionMode) {
  if (!slot) return null;
  const contentRect = getPhotoContentRect(slot, { dimensionMode });
  return {
    ...slot,
    x: contentRect.x,
    y: contentRect.y,
    width: contentRect.width,
    height: contentRect.height,
  };
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
  const [spreadPreviewOpen, setSpreadPreviewOpen] = useState(false);
  const [totalPhotoCount, setTotalPhotoCount] = useState(0);

  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const stickerFileInputRef = useRef(null);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  // ── 分頁草稿與復原/重做歷史（useLayoutHistory）─────────────────────────────
  const clearSelection = useCallback(() => setSelectedElement(null), []);
  const {
    draftLayouts,
    canUndo,
    canRedo,
    beginPageSession,
    dropPageHistory,
    commitPageLayout,
    undoLayout,
    redoLayout,
    saveDirtyLayouts,
  } = useLayoutHistory({ currentPage, pageLayout, setPageLayout, onLayoutRestored: clearSelection });

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
    setPageLayout(beginPageSession(page));
    setBackgroundUrl(
      page.background_filename
        ? `/api/templates/${templateId}/pages/${page.id}/background?t=${Date.now()}`
        : null
    );
  }, [beginPageSession, templateId]);

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

  useEffect(() => {
    if (!template) {
      setTotalPhotoCount(0);
      return;
    }
    setTotalPhotoCount(countTemplatePhotoSlots(template, draftLayouts.current));
  }, [pageLayout, template, draftLayouts]);

  const startEditorGuide = useCallback(() => {
    startProductGuide(EDITOR_GUIDE_STEPS);
  }, []);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = async ({ showToast = true } = {}) => {
    if (!template) return false;
    setIsSaving(true);
    try {
      const savedLayouts = await saveDirtyLayouts(
        template.pages,
        (pageId, layout) => updatePageLayout(templateId, pageId, layout),
      );
      if (savedLayouts) {
        setTemplate(currentTemplate => currentTemplate
          ? {
              ...currentTemplate,
              pages: currentTemplate.pages.map(page => (
                savedLayouts[page.id]
                  ? { ...page, layout: cloneLayout(savedLayouts[page.id]) }
                  : page
              )),
            }
          : currentTemplate
        );
      }
      if (showToast) toast.success("已儲存");
      setIsSaving(false);
      return true;
    } catch {
      toast.error("儲存失敗");
      setIsSaving(false);
      return false;
    }
  };

  const handleOpenSpreadPreview = async () => {
    if (!template?.pages.length) return;
    const saved = await handleSaveLayout({ showToast: false });
    if (!saved) return;
    setSpreadPreviewOpen(true);
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
        dropPageHistory(currentPage.id);
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
      const {
        path: stickerPath,
        filename: stickerFilename,
        width: stickerImageWidth,
        height: stickerImageHeight,
      } = response.data;
      const stickerSize = getInitialStickerSize(stickerImageWidth, stickerImageHeight);
      const newSticker = {
        id: generateElementId(),
        path: stickerPath,
        filename: stickerFilename,
        x: 50, y: 50,
        width: stickerSize.width,
        height: stickerSize.height,
        rotation: 0,
      };
      commitPageLayout(currentLayout => ({
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
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => element.id === elementId ? { ...element, ...propertyUpdates } : element
      ),
    }));
  };

  const updatePhotoElementFromEditor = (elementId, propertyUpdates) => {
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      photo_slots: (currentLayout.photo_slots || []).map(
        slot => slot.id === elementId
          ? applyPhotoEditorUpdates(slot, propertyUpdates, getPhotoSlotDimensionMode(currentLayout))
          : slot
      ),
    }));
  };

  const deleteSelectedElement = useCallback(() => {
    if (!selectedElement) return;
    const arrayKey = ELEMENT_ARRAY_KEY[selectedElement.type];
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).filter(element => element.id !== selectedElement.id),
    }));
    setSelectedElement(null);
  }, [commitPageLayout, selectedElement]);

  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    commitPageLayout(currentLayout => {
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
  }, [commitPageLayout, selectedElement]);

  // Delete / Backspace / Undo / Redo 鍵盤快捷鍵
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (isKeyboardInputTarget(document.activeElement)) return;
      const isUndo = (keyEvent.ctrlKey || keyEvent.metaKey) && !keyEvent.shiftKey && keyEvent.key.toLowerCase() === "z";
      const isRedo =
        ((keyEvent.ctrlKey || keyEvent.metaKey) && keyEvent.key.toLowerCase() === "y") ||
        ((keyEvent.ctrlKey || keyEvent.metaKey) && keyEvent.shiftKey && keyEvent.key.toLowerCase() === "z");
      if (isUndo) {
        keyEvent.preventDefault();
        undoLayout();
        return;
      }
      if (isRedo) {
        keyEvent.preventDefault();
        redoLayout();
        return;
      }
      if (keyEvent.key !== "Delete" && keyEvent.key !== "Backspace") return;
      deleteSelectedElement();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelectedElement, redoLayout, undoLayout]);

  // ── Konva Stage 事件：放置元素 or 取消選取 ───────────────────────────────

  const handleStageClick = (e) => {
    if (!pageLayout) return;
    const pos = stageRef.current.getPointerPosition();
    const realX = toRealCoord(pos.x);
    const realY = toRealCoord(pos.y);

    if (activeTool === "addPhotoPortrait" || activeTool === "addPhotoLandscape") {
      // 新照片格一律固定比例：3:4 直式或 4:3 橫式
      const contentSize = activeTool === "addPhotoPortrait"
        ? { width: 240, height: 320 }
        : { width: 320, height: 240 };
      const newSlotStyle = {
        id: generateElementId(),
        rotation: 0,
        border: true, border_width: 8,
        z_index: getNextZIndex(pageLayout),
      };
      const newSlot = buildPhotoSlotFromContentRect(
        newSlotStyle,
        clampPhotoContentRect({
          x: realX,
          y: realY,
          width: contentSize.width,
          height: contentSize.height,
        }),
        { dimensionMode: photoSlotDimensionMode },
      );
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        photo_slots: [...currentLayout.photo_slots, { ...newSlot, z_index: getNextZIndex(currentLayout) }],
      }));
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
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        text_bubbles: [...currentLayout.text_bubbles, { ...newBubble, z_index: getNextZIndex(currentLayout) }],
      }));
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
        text_role: TEXT_LABEL_ROLES.FILLABLE,
        font_size: 28,
        font_color: "#3B6B8C",
        font_family: "msjh",
        text_align: "center",
        line_height: 1.4,
        z_index: getNextZIndex(pageLayout),
      };
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        text_labels: [...(currentLayout.text_labels || []), { ...newTextLabel, z_index: getNextZIndex(currentLayout) }],
      }));
      setSelectedElement({ type: "text", id: newTextLabel.id });
      return;
    }

    // 選取模式：點擊空白處取消選取
    if (e.target === stageRef.current) {
      setSelectedElement(null);
    }
  };

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  if (!template) return <div className="text-gray-400">載入中...</div>;

  if (template.pages.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">編輯模板：{template.name}</h1>
        <div className="inline-flex items-center gap-1 text-sm text-gray-500 mb-4">
          <Camera className="w-4 h-4" />
          照片總計 0 張
        </div>
        <button onClick={handleAddPage} className="bg-indigo-600 text-white px-4 py-2 rounded">
          新增第一頁
        </button>
      </div>
    );
  }

  const selectedItem = selectedElement ? getElement(selectedElement) : null;
  const selectedPanelItem = selectedElement?.type === "photo"
    ? getPhotoEditorElementData(selectedItem, photoSlotDimensionMode)
    : selectedItem;
  const sortedPageElements = getAllElementsSorted(pageLayout);

  // 傳給 Konva 節點渲染函式的頁面 state（見 components/canvas/pageElementNodes）
  const canvasNodeContext = {
    isSelectMode: activeTool === "select",
    photoSlotDimensionMode,
    currentPageIndex,
    updateElement,
    setSelectedElement,
  };

  return (
    <div className="flex flex-col">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {spreadPreviewOpen && (
        <SpreadPreviewModal
          templateId={templateId}
          pageCount={template.pages.length}
          initialPageIndex={currentPageIndex}
          onClose={() => setSpreadPreviewOpen(false)}
        />
      )}
      {/* 頂部標題列 */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0" data-guide="editor-header">
        <button onClick={() => navigate("/templates")} className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回
        </button>
        <h1 className="text-lg font-bold">{template.name}</h1>
        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">模板編輯器</span>
        <span data-guide="template-photo-count" className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
          <Camera className="w-3 h-3" />
          照片總計 {totalPhotoCount} 張
        </span>
        <div className="ml-auto flex items-center gap-2" data-guide="top-actions">
          {/* 與全站教學鈕同一顆 token（secondary） */}
          <Button
            type="button"
            onClick={startEditorGuide}
            variant="secondary"
            size="sm"
          >
            <CircleHelp className="w-4 h-4" />
            製作教學
          </Button>
          <span className="inline-flex items-center gap-2" data-guide="history-actions">
          <button
            type="button"
            onClick={undoLayout}
            disabled={!canUndo}
            aria-label="復原"
            title="復原 (Ctrl+Z)"
            className="w-8 h-8 inline-flex items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35 disabled:hover:bg-white"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={redoLayout}
            disabled={!canRedo}
            aria-label="重做"
            title="重做 (Ctrl+Y / Ctrl+Shift+Z)"
            className="w-8 h-8 inline-flex items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35 disabled:hover:bg-white"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          </span>
          <button
            type="button"
            onClick={handleOpenSpreadPreview}
            disabled={isSaving || template.pages.length === 0}
            data-guide="spread-preview"
            className="inline-flex items-center gap-1.5 px-3 py-1 text-sm rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <BookOpen className="w-4 h-4" />
            雙頁預覽
          </button>
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
            data-guide="save-template"
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
          hint="拖曳移動 · 滾輪縮放 · 裁切範圍固定為 A4 比例"
          onConfirm={handleBgCropConfirm}
          onCancel={() => setBgCropFile(null)}
        />
      )}

      {/* 三欄主體 */}
      <div className="flex gap-4">
        {/* 左側工具欄 */}
        <div className="flex-shrink-0 w-40 flex flex-col gap-4" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }}>
          {/* 工具 */}
          <div data-guide="tool-panel">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">工具</p>
            <div className="flex flex-col gap-1">
              {[
                { key: "select",            label: "↖ 選取" },
                { key: "addPhotoPortrait",  label: "＋ 照片格 3:4 直式" },
                { key: "addPhotoLandscape", label: "＋ 照片格 4:3 橫式" },
                { key: "addText",           label: "＋ 純文字" },
              ].map(tool => (
                <button
                  key={tool.key}
                  onClick={() => setActiveTool(tool.key)}
                  data-guide={`tool-${tool.key === "addPhotoPortrait" ? "add-photo" : tool.key === "addPhotoLandscape" ? "add-photo-landscape" : tool.key === "addText" ? "add-text" : "select"}`}
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
              <label data-guide="upload-background" className="px-3 py-1.5 rounded text-sm text-left border bg-white hover:bg-gray-50 cursor-pointer text-gray-700 border-gray-200 transition-colors">
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
          <div className="flex flex-col flex-1 min-h-0" data-guide="page-list">
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
                data-guide="add-page"
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
            data-guide="canvas-frame"
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
                {sortedPageElements.map(({ type, data, index: elemIndex }) => {
                  const isSelected = selectedElement?.type === type && selectedElement?.id === data.id;
                  if (type === "photo") return renderPhotoSlotNode(data, elemIndex, isSelected, makePhotoControlProps(data, canvasNodeContext), canvasNodeContext);
                  const groupProps = makeGroupProps(type, data, canvasNodeContext);
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
                  keepRatio={selectedElement?.type === "photo"}
                  flipEnabled={false}
                  rotateEnabled={true}
                  borderStroke="#4F46E5"
                  borderStrokeWidth={1}
                  anchorFill="#4F46E5"
                  anchorStroke="#ffffff"
                  anchorStrokeWidth={1}
                  anchorSize={8}
                  rotateAnchorOffset={20}
                  enabledAnchors={selectedElement?.type === "photo"
                    // 照片格鎖定長寬比例：只留四角把手等比縮放
                    ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                    : [
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
        <div className="flex-1 min-w-0 overflow-y-auto" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }} data-guide="property-region">
          {selectedElement && selectedPanelItem ? (
            <PropertyPanel
              selectedElement={selectedElement}
              elementData={selectedPanelItem}
              onPropertyChange={(updates) => {
                if (selectedElement.type === "photo") {
                  updatePhotoElementFromEditor(selectedElement.id, updates);
                  return;
                }
                updateElement(selectedElement.type, selectedElement.id, updates);
              }}
              onLayerChange={handleLayerChange}
            />
          ) : (
            <LayerListPanel
              pageLayout={pageLayout}
              sortedPageElements={sortedPageElements}
              currentPageIndex={currentPageIndex}
              photoSlotDimensionMode={photoSlotDimensionMode}
              backgroundUrl={backgroundUrl}
              onSelectElement={(type, id) => setSelectedElement({ type, id })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
