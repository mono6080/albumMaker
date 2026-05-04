// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Stage, Layer, Rect, Image as KonvaImage, Text as KonvaText, Group, Transformer } from "react-konva";
import { BookOpen, Camera, ChevronLeft, ChevronRight, CircleHelp, Redo2, Undo2, X } from "lucide-react";

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
import { buildTemplateSpreadPreviewUrl } from "../api/urls";
import { startProductGuide } from "../utils/productGuide";

function clampValue(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

const ELEMENT_ARRAY_KEY = { photo: "photo_slots", bubble: "text_bubbles", text: "text_labels", sticker: "stickers" };
const MAX_LAYOUT_HISTORY = 100;

const EDITOR_GUIDE_STEPS = [
  {
    element: '[data-guide="template-photo-count"]',
    title: "照片總計",
    description: "這裡統計整份模板的照片格總數，交付前要和企劃需求一致。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="tool-add-photo"]',
    title: "連續新增照片格",
    description: "選一次照片格後，可以在畫布上連續點擊新增，不需要每新增一格就重新選工具。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="canvas-frame"]',
    title: "A4 畫布",
    description: "背景、照片格、文字和貼圖都在這裡排版。新增元素後切回選取工具再調整。",
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
    description: "在這裡切換頁面或新增頁。切到不同頁面後再編輯該頁內容。",
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
    element: '[data-guide="property-region"]',
    title: "屬性面板",
    description: "點選畫布元素後，這裡會出現位置、尺寸、文字、陰影等精準設定。",
    side: "left",
    align: "center",
  },
];

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

function layoutsEqual(leftLayout, rightLayout) {
  return JSON.stringify(leftLayout) === JSON.stringify(rightLayout);
}

function getPageHistory(historyStore, pageId) {
  if (!historyStore[pageId]) {
    historyStore[pageId] = { undo: [], redo: [] };
  }
  return historyStore[pageId];
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
  const [spreadStartIndex, setSpreadStartIndex] = useState(0);
  const [spreadPreviewTimestamp, setSpreadPreviewTimestamp] = useState(0);
  const [totalPhotoCount, setTotalPhotoCount] = useState(0);

  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const stickerFileInputRef = useRef(null);
  const draftLayouts = useRef({});
  const layoutHistories = useRef({});
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });

  const refreshHistoryAvailability = useCallback((pageId) => {
    if (!pageId) {
      setHistoryAvailability({ canUndo: false, canRedo: false });
      return;
    }
    const history = getPageHistory(layoutHistories.current, pageId);
    setHistoryAvailability({
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
    });
  }, []);

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
    getPageHistory(layoutHistories.current, page.id);
    setPageLayout(cloneLayout(draftLayouts.current[page.id] ?? page.layout));
    refreshHistoryAvailability(page.id);
    setBackgroundUrl(
      page.background_filename
        ? `/api/templates/${templateId}/pages/${page.id}/background?t=${Date.now()}`
        : null
    );
  }, [refreshHistoryAvailability, templateId]);

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
    if (!template) {
      setTotalPhotoCount(0);
      return;
    }
    setTotalPhotoCount(countTemplatePhotoSlots(template, draftLayouts.current));
  }, [pageLayout, template]);

  const commitPageLayout = useCallback((layoutUpdater) => {
    if (!currentPage || !pageLayout) return;
    const pageId = currentPage.id;
    const baseLayout = draftLayouts.current[pageId] ?? pageLayout;
    const nextLayout = typeof layoutUpdater === "function" ? layoutUpdater(baseLayout) : layoutUpdater;
    if (!nextLayout || layoutsEqual(baseLayout, nextLayout)) return;

    const history = getPageHistory(layoutHistories.current, pageId);
    history.undo.push(cloneLayout(baseLayout));
    if (history.undo.length > MAX_LAYOUT_HISTORY) history.undo.shift();
    history.redo = [];

    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[pageId] = nextSnapshot;
    setPageLayout(nextSnapshot);
    refreshHistoryAvailability(pageId);
  }, [currentPage, pageLayout, refreshHistoryAvailability]);

  const undoLayout = useCallback(() => {
    if (!currentPage || !pageLayout) return;
    const history = getPageHistory(layoutHistories.current, currentPage.id);
    if (history.undo.length === 0) return;

    const previousLayout = history.undo.pop();
    history.redo.push(cloneLayout(pageLayout));
    const previousSnapshot = cloneLayout(previousLayout);
    draftLayouts.current[currentPage.id] = previousSnapshot;
    setPageLayout(previousSnapshot);
    setSelectedElement(null);
    refreshHistoryAvailability(currentPage.id);
  }, [currentPage, pageLayout, refreshHistoryAvailability]);

  const redoLayout = useCallback(() => {
    if (!currentPage || !pageLayout) return;
    const history = getPageHistory(layoutHistories.current, currentPage.id);
    if (history.redo.length === 0) return;

    const nextLayout = history.redo.pop();
    history.undo.push(cloneLayout(pageLayout));
    const nextSnapshot = cloneLayout(nextLayout);
    draftLayouts.current[currentPage.id] = nextSnapshot;
    setPageLayout(nextSnapshot);
    setSelectedElement(null);
    refreshHistoryAvailability(currentPage.id);
  }, [currentPage, pageLayout, refreshHistoryAvailability]);

  const canUndo = historyAvailability.canUndo;
  const canRedo = historyAvailability.canRedo;

  const startEditorGuide = useCallback(() => {
    startProductGuide(EDITOR_GUIDE_STEPS);
  }, []);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = async ({ showToast = true } = {}) => {
    if (!template) return false;
    setIsSaving(true);
    try {
      const dirtyPageIds = Object.keys(draftLayouts.current).map(Number);
      if (dirtyPageIds.length === 0) {
        if (showToast) toast.success("已儲存");
        setIsSaving(false);
        return true;
      }
      const savedLayouts = Object.fromEntries(
        dirtyPageIds.map(pageId => [pageId, cloneLayout(draftLayouts.current[pageId])])
      );
      await Promise.all(
        template.pages
          .filter(page => dirtyPageIds.includes(page.id))
          .map(page => updatePageLayout(templateId, page.id, savedLayouts[page.id]))
      );
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
      dirtyPageIds.forEach(pageId => { delete draftLayouts.current[pageId]; });
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
    setSpreadStartIndex(Math.floor(currentPageIndex / 2) * 2);
    setSpreadPreviewTimestamp(Date.now());
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
        delete draftLayouts.current[currentPage.id];
        delete layoutHistories.current[currentPage.id];
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

    if (activeTool === "addPhoto") {
      const newSlot = {
        id: generateElementId(),
        x: realX, y: realY,
        width: 300, height: 220, rotation: 0,
        border: true, border_width: 8,
        z_index: getNextZIndex(pageLayout),
      };
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

  // ── Stage 元素渲染函式（閉包存取 toDisplayCoord / currentPageIndex 等） ─────

  const getTextShadowProps = (data) => {
    const shadowEnabled = !!(data.text_shadow_enabled ?? false);
    if (!shadowEnabled) return {};

    return {
      shadowEnabled: true,
      shadowColor: data.text_shadow_color ?? "#000000",
      shadowOpacity: (data.text_shadow_opacity ?? 120) / 255,
      shadowOffsetX: toDisplayCoord(data.text_shadow_offset_x ?? 3),
      shadowOffsetY: toDisplayCoord(data.text_shadow_offset_y ?? 3),
      shadowBlur: toDisplayCoord(data.text_shadow_blur ?? 4) * 1.74,
    };
  };

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
          {...getTextShadowProps(data)}
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
          {...getTextShadowProps(data)}
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

  const lastSpreadStartIndex = Math.max(0, Math.floor((template.pages.length - 1) / 2) * 2);
  const spreadEndIndex = Math.min(spreadStartIndex + 1, template.pages.length - 1);
  const spreadPreviewUrl = `${buildTemplateSpreadPreviewUrl(templateId, spreadStartIndex)}?t=${spreadPreviewTimestamp}`;

  return (
    <div className="flex flex-col">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {spreadPreviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="雙頁預覽"
            className="w-[min(96vw,1200px)] max-h-[92vh] bg-white rounded-lg shadow-xl flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200">
              <BookOpen className="w-5 h-5 text-indigo-600" />
              <h2 className="font-semibold">雙頁預覽</h2>
              <span className="text-sm text-gray-500" data-guide="spread-page-range">
                第 {spreadStartIndex + 1}{spreadEndIndex > spreadStartIndex ? `-${spreadEndIndex + 1}` : ""} 頁
              </span>
              <button
                type="button"
                onClick={() => setSpreadPreviewOpen(false)}
                aria-label="關閉雙頁預覽"
                data-guide="spread-close"
                className="ml-auto w-8 h-8 inline-flex items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-gray-100 p-3 overflow-auto">
              <img
                key={spreadPreviewUrl}
                src={spreadPreviewUrl}
                alt="雙頁合併預覽"
                data-guide="spread-preview-image"
                className="block mx-auto max-w-full max-h-[76vh] bg-white border border-gray-300"
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-200">
              <button
                type="button"
                onClick={() => {
                  setSpreadStartIndex(index => Math.max(0, index - 2));
                  setSpreadPreviewTimestamp(Date.now());
                }}
                disabled={spreadStartIndex <= 0}
                data-guide="spread-prev"
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
                上一組
              </button>
              <button
                type="button"
                onClick={() => {
                  setSpreadStartIndex(index => Math.min(lastSpreadStartIndex, index + 2));
                  setSpreadPreviewTimestamp(Date.now());
                }}
                disabled={spreadStartIndex >= lastSpreadStartIndex}
                data-guide="spread-next"
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                下一組
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
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
          <button
            type="button"
            onClick={startEditorGuide}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-sm rounded border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
          >
            <CircleHelp className="w-4 h-4" />
            製作教學
          </button>
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
          <div data-guide="tool-panel">
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
                  data-guide={`tool-${tool.key === "addPhoto" ? "add-photo" : tool.key === "addText" ? "add-text" : "select"}`}
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
                {/* eslint-disable-next-line react-hooks/refs */}
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
        <div className="flex-1 min-w-0 overflow-y-auto" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }} data-guide="property-region">
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

