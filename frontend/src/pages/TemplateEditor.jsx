// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性
// 分工：per-page 草稿/歷史在 hooks/useLayoutHistory、Konva 節點渲染在
// components/canvas/pageElementNodes、雙頁預覽與圖層清單為獨立 component

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  Stage,
  Layer,
  Group as KonvaGroup,
  Rect,
  Image as KonvaImage,
  Text as KonvaText,
  Transformer,
} from "react-konva";
import { BookOpen, Camera, CircleHelp, Redo2, Undo2 } from "lucide-react";

import {
  fetchTemplate,
  addTemplatePage,
  updatePageLayout,
  uploadBackground,
  deleteTemplatePage,
  uploadSticker,
  suggestMaterialTextBox,
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
import GroupSelectionPanel from "../components/GroupSelectionPanel";
import ConfirmModal from "../components/ConfirmModal";
import SpreadPreviewModal from "../components/SpreadPreviewModal";
import { Button } from "../components/ui";
import useLayoutHistory, { cloneLayout } from "../hooks/useLayoutHistory";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  ELEMENT_ARRAY_KEY,
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
import {
  addElementToGroup,
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  getGroupBounds,
  getGroupById,
  getGroupForElement,
  groupElements,
  linkMaterialText,
  moveGroup,
  normalizeRootZIndices,
  projectNormalizedBoxToSticker,
  reorderGroupChild,
  reorderRootNode,
  rotateGroup,
  scaleGroupUniform,
  ungroupElements,
} from "../utils/layoutGroups";

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

function refKey(ref) {
  return ref ? `${ref.type}:${String(ref.id)}` : "";
}

function sameRef(left, right) {
  return refKey(left) === refKey(right);
}

function normalizeDegrees(value) {
  const normalized = ((Number(value) || 0) + 180) % 360;
  return (normalized < 0 ? normalized + 360 : normalized) - 180;
}

function createRequestToken() {
  return `material-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStickerAnalysisSignature(sticker) {
  if (!sticker) return null;
  return JSON.stringify({
    id: sticker.id,
    path: sticker.path ?? null,
    asset_revision: sticker.asset_revision ?? null,
    x: sticker.x,
    y: sticker.y,
    width: sticker.width,
    height: sticker.height,
    rotation: sticker.rotation ?? 0,
  });
}

function getGroupAnalysisSignature(group) {
  if (!group) return null;
  return JSON.stringify({
    id: group.id,
    children: group.children || [],
    links: group.links || [],
  });
}

function getUniqueElementId(layout) {
  const usedIds = new Set(
    Object.values(ELEMENT_ARRAY_KEY)
      .flatMap(arrayKey => layout?.[arrayKey] || [])
      .map(element => String(element.id)),
  );
  let candidate = generateElementId();
  while (usedIds.has(String(candidate))) candidate = generateElementId();
  return candidate;
}

function getUniqueGroupId(layout) {
  const usedIds = new Set((layout?.groups || []).map(group => String(group.id)));
  let candidate = generateElementId();
  while (usedIds.has(String(candidate))) candidate = generateElementId();
  return candidate;
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
  const [selectedRefs, setSelectedRefs] = useState([]);
  const [isolationGroupId, setIsolationGroupId] = useState(null);
  const [analyzingTargetKey, setAnalyzingTargetKey] = useState(null);
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
  const pageLayoutRef = useRef(null);
  const analysisRequestRef = useRef(null);
  const activePageSessionIdRef = useRef(null);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);
  const selectedElement = selectedRefs.length === 1 ? selectedRefs[0] : null;

  const setSelectedElement = useCallback((nextSelection) => {
    setSelectedRefs(currentRefs => {
      const currentSelection = currentRefs.length === 1 ? currentRefs[0] : null;
      const resolvedSelection = typeof nextSelection === "function"
        ? nextSelection(currentSelection)
        : nextSelection;
      return resolvedSelection ? [resolvedSelection] : [];
    });
  }, []);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  // ── 分頁草稿與復原/重做歷史（useLayoutHistory）─────────────────────────────
  const clearSelection = useCallback(() => {
    setSelectedRefs([]);
    setIsolationGroupId(null);
  }, []);
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

  useEffect(() => {
    pageLayoutRef.current = pageLayout;
  }, [pageLayout]);

  useEffect(() => () => analysisRequestRef.current?.controller?.abort(), []);

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
    const nodes = selectedRefs
      .map(ref => stageRef.current.findOne(`#${ref.type}-${ref.id}`))
      .filter(Boolean);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedRefs, pageLayout, isolationGroupId]);

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

  const loadTemplate = useCallback(async () => {
    const response = await fetchTemplate(templateId);
    setTemplate(response.data);
    return response.data;
  }, [templateId]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const nextPage = pages[Math.min(currentPageIndex, pages.length - 1)];
    if (String(activePageSessionIdRef.current) === String(nextPage.id)) return;
    analysisRequestRef.current?.controller?.abort();
    analysisRequestRef.current = null;
    setAnalyzingTargetKey(null);
    activePageSessionIdRef.current = nextPage.id;
    applyPageDisplay(nextPage);
    clearSelection();
  }, [currentPageIndex, template, applyPageDisplay, clearSelection]);

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
        asset_revision: stickerAssetRevision,
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
        ...(stickerAssetRevision ? { asset_revision: stickerAssetRevision } : {}),
      };
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        stickers: [...(currentLayout.stickers || []), newSticker],
      }));
      setIsolationGroupId(null);
      setSelectedElement({ type: "sticker", id: newSticker.id });
      toast.success("貼圖已上傳");
    } catch {
      toast.error("上傳失敗");
    }
  };

  // ── 元素操作 ──────────────────────────────────────────────────────────────

  const getElement = useCallback(({ type, id }, layout = pageLayout) => {
    if (!layout) return null;
    if (type === "photo")   return (layout.photo_slots || []).find(slot => String(slot.id) === String(id));
    if (type === "bubble")  return (layout.text_bubbles || []).find(bubble => String(bubble.id) === String(id));
    if (type === "text")    return (layout.text_labels || []).find(label => String(label.id) === String(id));
    if (type === "sticker") return (layout.stickers || []).find(sticker => String(sticker.id) === String(id));
    return null;
  }, [pageLayout]);

  const handleSelectElement = useCallback((elementRef, { additive = false } = {}) => {
    if (!pageLayout || !elementRef) return;

    if (isolationGroupId != null) {
      const isolatedGroup = getGroupById(pageLayout, isolationGroupId);
      if (!isolatedGroup?.children?.some(childRef => sameRef(childRef, elementRef))) return;
      setSelectedRefs([elementRef]);
      return;
    }

    const containingGroup = getGroupForElement(pageLayout, elementRef);
    if (containingGroup) {
      setSelectedRefs([{ type: "group", id: containingGroup.id }]);
      return;
    }

    if (!additive || !["text", "sticker"].includes(elementRef.type)) {
      setSelectedRefs([elementRef]);
      return;
    }

    setSelectedRefs(currentRefs => {
      const currentCanJoin = currentRefs.every(ref => (
        ["text", "sticker"].includes(ref.type) && !getGroupForElement(pageLayout, ref)
      ));
      const baseRefs = currentCanJoin ? currentRefs : [];
      const alreadySelected = baseRefs.some(ref => sameRef(ref, elementRef));
      return alreadySelected
        ? baseRefs.filter(ref => !sameRef(ref, elementRef))
        : [...baseRefs, elementRef];
    });
  }, [isolationGroupId, pageLayout]);

  const handleSelectGroup = useCallback((groupId) => {
    setIsolationGroupId(null);
    setSelectedRefs([{ type: "group", id: groupId }]);
  }, []);

  const enterGroup = useCallback((groupId, preferredChild = null) => {
    const group = getGroupById(pageLayout, groupId);
    if (!group) return;
    const nextChild = preferredChild && group.children.some(ref => sameRef(ref, preferredChild))
      ? preferredChild
      : group.children[0] ?? null;
    setIsolationGroupId(group.id);
    setSelectedRefs(nextChild ? [nextChild] : []);
  }, [pageLayout]);

  const exitGroup = useCallback(() => {
    const group = getGroupById(pageLayout, isolationGroupId);
    setIsolationGroupId(null);
    setSelectedRefs(group ? [{ type: "group", id: group.id }] : []);
  }, [isolationGroupId, pageLayout]);

  const handleActivateElement = useCallback((elementRef) => {
    const group = getGroupForElement(pageLayout, elementRef);
    if (group) enterGroup(group.id, elementRef);
  }, [enterGroup, pageLayout]);

  const handleCreateGroup = useCallback(({ linkMaterialText: shouldLinkMaterialText = false } = {}) => {
    if (selectedRefs.length < 2) return;
    let createdGroupId = null;
    try {
      commitPageLayout(currentLayout => {
        createdGroupId = getUniqueGroupId(currentLayout);
        if (shouldLinkMaterialText && selectedRefs.length === 2) {
          const textRef = selectedRefs.find(ref => ref.type === "text");
          const stickerRef = selectedRefs.find(ref => ref.type === "sticker");
          if (textRef && stickerRef) {
            return linkMaterialText(currentLayout, {
              materialId: stickerRef.id,
              textId: textRef.id,
              groupId: createdGroupId,
            });
          }
        }
        return groupElements(currentLayout, selectedRefs, { groupId: createdGroupId });
      });
      if (createdGroupId != null) handleSelectGroup(createdGroupId);
    } catch (error) {
      toast.error(error?.message || "無法建立群組，請確認物件圖層相鄰");
    }
  }, [commitPageLayout, handleSelectGroup, selectedRefs]);

  const handleUngroup = useCallback((groupId) => {
    const group = getGroupById(pageLayout, groupId);
    if (!group) return;
    try {
      commitPageLayout(currentLayout => ungroupElements(currentLayout, groupId));
      setIsolationGroupId(null);
      setSelectedRefs(group.children.map(child => ({ ...child })));
    } catch (error) {
      toast.error(error?.message || "無法解除群組");
    }
  }, [commitPageLayout, pageLayout]);

  const updateElement = (elementType, elementId, propertyUpdates) => {
    const arrayKey = ELEMENT_ARRAY_KEY[elementType];
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => String(element.id) === String(elementId) ? { ...element, ...propertyUpdates } : element
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
    if (selectedRefs.length === 0) return;
    try {
      commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => (
        ref.type === "group"
          ? deleteLayoutGroup(nextLayout, ref.id)
          : deleteLayoutElement(nextLayout, ref)
      ), currentLayout));
      clearSelection();
    } catch (error) {
      toast.error(error?.message || "無法刪除選取物件");
    }
  }, [clearSelection, commitPageLayout, selectedRefs]);

  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    try {
      commitPageLayout(currentLayout => {
        if (isolationGroupId != null && selectedElement.type !== "group") {
          const group = getGroupById(currentLayout, isolationGroupId);
          const selectedIndex = group?.children?.findIndex(ref => sameRef(ref, selectedElement)) ?? -1;
          if (selectedIndex < 0) return currentLayout;
          const targetIndex = direction === "top" ? group.children.length - 1
            : direction === "bottom" ? 0
              : direction === "up" ? Math.min(group.children.length - 1, selectedIndex + 1)
                : Math.max(0, selectedIndex - 1);
          return targetIndex === selectedIndex
            ? currentLayout
            : reorderGroupChild(currentLayout, group.id, selectedElement, targetIndex);
        }

        const rootNodes = buildRootRenderNodes(currentLayout);
        const selectedIndex = rootNodes.findIndex(node => (
          node.type === selectedElement.type && String(node.id) === String(selectedElement.id)
        ));
        if (selectedIndex < 0) return currentLayout;
        const targetIndex = direction === "top" ? rootNodes.length - 1
          : direction === "bottom" ? 0
            : direction === "up" ? Math.min(rootNodes.length - 1, selectedIndex + 1)
              : Math.max(0, selectedIndex - 1);
        return targetIndex === selectedIndex
          ? currentLayout
          : reorderRootNode(currentLayout, selectedElement, targetIndex);
      });
    } catch (error) {
      toast.error(error?.message || "無法調整圖層");
    }
  }, [commitPageLayout, isolationGroupId, selectedElement]);

  useEffect(() => {
    if (!pageLayout) return;
    const isolatedGroup = isolationGroupId == null ? null : getGroupById(pageLayout, isolationGroupId);
    if (isolationGroupId != null && !isolatedGroup) {
      setIsolationGroupId(null);
      setSelectedRefs([]);
      return;
    }
    setSelectedRefs(currentRefs => {
      const survivingRefs = currentRefs.filter(ref => (
        ref.type === "group"
          ? !!getGroupById(pageLayout, ref.id)
          : isolationGroupId != null
            ? isolatedGroup.children.some(child => sameRef(child, ref)) && !!getElement(ref, pageLayout)
            : !!getElement(ref, pageLayout) && !getGroupForElement(pageLayout, ref)
      ));
      return survivingRefs.length === currentRefs.length ? currentRefs : survivingRefs;
    });
  }, [getElement, isolationGroupId, pageLayout]);

  // Delete / Backspace / Undo / Redo / 群組導覽與方向鍵
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      const isInputTarget = isKeyboardInputTarget(document.activeElement);
      if (keyEvent.key === "Escape") {
        if (isolationGroupId != null) {
          keyEvent.preventDefault();
          document.activeElement?.blur?.();
          exitGroup();
        } else if (!isInputTarget) {
          keyEvent.preventDefault();
          setSelectedRefs([]);
        }
        return;
      }
      if (isInputTarget) return;
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
      if (keyEvent.key === "Enter" && selectedElement?.type === "group") {
        keyEvent.preventDefault();
        enterGroup(selectedElement.id);
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(keyEvent.key) && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        const step = keyEvent.shiftKey ? 10 : 1;
        const dx = keyEvent.key === "ArrowLeft" ? -step : keyEvent.key === "ArrowRight" ? step : 0;
        const dy = keyEvent.key === "ArrowUp" ? -step : keyEvent.key === "ArrowDown" ? step : 0;
        try {
          commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => {
            if (ref.type === "group") return moveGroup(nextLayout, ref.id, { dx, dy });
            const arrayKey = ELEMENT_ARRAY_KEY[ref.type];
            if (!arrayKey) return nextLayout;
            return {
              ...nextLayout,
              [arrayKey]: (nextLayout[arrayKey] || []).map(element => (
                String(element.id) === String(ref.id)
                  ? { ...element, x: (element.x ?? 0) + dx, y: (element.y ?? 0) + dy }
                  : element
              )),
            };
          }, currentLayout));
        } catch (error) {
          toast.error(error?.message || "無法移動選取物件");
        }
        return;
      }
      if (keyEvent.key === "Delete" || keyEvent.key === "Backspace") {
        keyEvent.preventDefault();
        deleteSelectedElement();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    commitPageLayout,
    deleteSelectedElement,
    enterGroup,
    exitGroup,
    isolationGroupId,
    redoLayout,
    selectedElement,
    selectedRefs,
    undoLayout,
  ]);

  const handleAnalyzeMaterial = useCallback(async (target) => {
    const layoutSnapshot = pageLayoutRef.current;
    if (!layoutSnapshot || !currentPage) return;

    const explicitGroupId = target?.type === "group"
      ? target.id
      : target?.children ? target.id : null;
    const explicitStickerRef = target?.type === "sticker" ? target : null;
    const targetGroup = explicitGroupId != null
      ? getGroupById(layoutSnapshot, explicitGroupId)
      : explicitStickerRef ? getGroupForElement(layoutSnapshot, explicitStickerRef) : null;
    const materialLink = targetGroup?.links?.find(link => link.kind === "material-text-v1") ?? null;
    const stickerRef = explicitStickerRef ?? (
      materialLink
        ? { type: "sticker", id: materialLink.material_id }
        : targetGroup?.children?.find(ref => ref.type === "sticker")
    );
    const sticker = stickerRef ? getElement(stickerRef, layoutSnapshot) : null;

    if (!sticker?.path) {
      toast.error("找不到可分析的圖片素材");
      return;
    }
    analysisRequestRef.current?.controller?.abort();
    const controller = new AbortController();
    const request = {
      controller,
      pageId: currentPage.id,
      stickerId: sticker.id,
      path: sticker.path,
      sourceRevision: sticker.asset_revision ?? null,
      geometrySignature: getStickerAnalysisSignature(sticker),
      requestToken: createRequestToken(),
      groupId: targetGroup?.id ?? null,
      groupSignature: getGroupAnalysisSignature(targetGroup),
      linkedTextId: materialLink?.text_id ?? null,
    };
    analysisRequestRef.current = request;
    setAnalyzingTargetKey(targetGroup ? `group:${targetGroup.id}` : `sticker:${sticker.id}`);

    try {
      const response = await suggestMaterialTextBox(
        templateId,
        currentPage.id,
        {
          stickerId: sticker.id,
          path: sticker.path,
          sourceRevision: sticker.asset_revision ?? null,
          requestToken: request.requestToken,
        },
        { signal: controller.signal },
      );
      const suggestion = response.data;
      if (analysisRequestRef.current !== request) return;
      if (String(activePageSessionIdRef.current) !== String(request.pageId)) return;

      const currentLayout = pageLayoutRef.current;
      const currentSticker = getElement({ type: "sticker", id: request.stickerId }, currentLayout);
      const currentGroup = currentSticker
        ? getGroupForElement(currentLayout, { type: "sticker", id: currentSticker.id })
        : null;
      const groupIsCurrent = String(currentGroup?.id ?? "") === String(request.groupId ?? "");
      const groupStructureIsCurrent = getGroupAnalysisSignature(currentGroup) === request.groupSignature;
      const responseMatches = suggestion?.request_token === request.requestToken;
      const sourceMatches = request.sourceRevision == null
        || suggestion?.source_revision === request.sourceRevision;
      if (
        !currentSticker
        || !groupIsCurrent
        || !groupStructureIsCurrent
        || !responseMatches
        || !sourceMatches
        || getStickerAnalysisSignature(currentSticker) !== request.geometrySignature
      ) {
        toast.error("圖片或群組已變更，分析結果未套用，請重新分析");
        return;
      }

      if (suggestion?.status !== "suggested") {
        const unavailableCopy = {
          no_shape: "找不到可可靠放置文字的圖形區域",
          low_confidence: "圖片留白不夠明確，請手動建立文字框",
          image_too_small: "圖片尺寸太小，無法可靠分析",
        };
        toast.error(unavailableCopy[suggestion?.reason] || "目前無法分析這張圖片");
        return;
      }

      let resultGroupId = request.groupId;
      let didApply = false;
      commitPageLayout(baseLayout => {
        if (String(activePageSessionIdRef.current) !== String(request.pageId)) return baseLayout;
        const latestStickerRef = { type: "sticker", id: request.stickerId };
        const latestSticker = getElement(latestStickerRef, baseLayout);
        const latestGroup = latestSticker ? getGroupForElement(baseLayout, latestStickerRef) : null;
        if (
          !latestSticker
          || String(latestGroup?.id ?? "") !== String(request.groupId ?? "")
          || getGroupAnalysisSignature(latestGroup) !== request.groupSignature
          || getStickerAnalysisSignature(latestSticker) !== request.geometrySignature
        ) return baseLayout;

        const nextGeometry = projectNormalizedBoxToSticker(latestSticker, suggestion.normalized_box);
        const latestLink = latestGroup?.links?.find(link => (
          link.kind === "material-text-v1"
          && String(link.material_id) === String(latestSticker.id)
        ));
        if (latestLink) {
          if (request.linkedTextId != null && String(latestLink.text_id) !== String(request.linkedTextId)) {
            return baseLayout;
          }
          const linkedText = getElement({ type: "text", id: latestLink.text_id }, baseLayout);
          if (!linkedText) return baseLayout;
          didApply = true;
          resultGroupId = latestGroup.id;
          return {
            ...baseLayout,
            text_labels: (baseLayout.text_labels || []).map(textLabel => (
              String(textLabel.id) === String(linkedText.id)
                ? { ...textLabel, ...nextGeometry }
                : textLabel
            )),
          };
        }

        const newTextId = getUniqueElementId(baseLayout);
        const newTextRef = { type: "text", id: newTextId };
        const newTextLabel = {
          id: newTextId,
          ...nextGeometry,
          text: "{name}的文字",
          text_role: TEXT_LABEL_ROLES.FILLABLE,
          font_size: 28,
          font_color: "#3B6B8C",
          font_family: "msjh",
          text_align: "center",
          line_height: 1.4,
          z_index: getNextZIndex(baseLayout),
        };
        let nextLayout = {
          ...baseLayout,
          text_labels: [...(baseLayout.text_labels || []), newTextLabel],
        };

        if (latestGroup) {
          resultGroupId = latestGroup.id;
          nextLayout = addElementToGroup(nextLayout, latestGroup.id, newTextRef, {
            afterRef: latestStickerRef,
          });
        } else {
          nextLayout = normalizeRootZIndices(nextLayout);
          resultGroupId = getUniqueGroupId(nextLayout);
          const rootsWithText = buildRootRenderNodes(nextLayout);
          const stickerRootIndex = rootsWithText.findIndex(node => (
            node.type === "sticker" && String(node.id) === String(latestSticker.id)
          ));
          nextLayout = reorderRootNode(nextLayout, newTextRef, stickerRootIndex + 1);
        }

        nextLayout = linkMaterialText(nextLayout, {
          materialId: latestSticker.id,
          textId: newTextId,
          groupId: resultGroupId,
        });
        didApply = true;
        return nextLayout;
      });

      if (didApply) {
        setIsolationGroupId(null);
        setSelectedRefs([{ type: "group", id: resultGroupId }]);
        toast.success(request.linkedTextId != null ? "已重設文字框" : "已建立文字框");
      } else {
        toast.error("圖片或群組已變更，分析結果未套用，請重新分析");
      }
    } catch (error) {
      if (error?.code !== "ERR_CANCELED" && error?.name !== "AbortError") {
        const detail = error?.response?.data?.detail;
        const code = typeof detail === "object" ? detail?.code : null;
        toast.error(code === "asset_revision_stale"
          ? "圖片版本已更新，請重新載入後再分析"
          : typeof detail === "string" ? detail : "圖片分析失敗");
      }
    } finally {
      if (analysisRequestRef.current === request) {
        analysisRequestRef.current = null;
        setAnalyzingTargetKey(null);
      }
    }
  }, [commitPageLayout, currentPage, getElement, templateId]);

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
      setIsolationGroupId(null);
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
      setIsolationGroupId(null);
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
      setIsolationGroupId(null);
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

  const rootRenderNodes = buildRootRenderNodes(pageLayout, {
    onWarning: warning => console.warn("[TemplateEditor] invalid layout groups; using flat render", warning),
  });
  const isolationGroup = isolationGroupId == null ? null : getGroupById(pageLayout, isolationGroupId);
  const isolationRenderNode = isolationGroup
    ? rootRenderNodes.find(node => node.kind === "group" && String(node.id) === String(isolationGroup.id))
    : null;
  const selectedGroup = selectedElement?.type === "group"
    ? getGroupById(pageLayout, selectedElement.id)
    : isolationGroup;
  const selectedItem = selectedElement?.type === "group"
    ? selectedGroup
    : selectedElement ? getElement(selectedElement) : null;
  const selectedPanelItem = selectedElement?.type === "group"
    ? getGroupBounds(pageLayout, selectedElement.id)
    : selectedElement?.type === "photo"
      ? getPhotoEditorElementData(selectedItem, photoSlotDimensionMode)
      : selectedItem;
  const selectedGroupChildren = (selectedGroup?.children || []).map(ref => ({
    ...ref,
    data: getElement(ref),
  })).filter(item => item.data);
  const selectedItems = selectedRefs.map(ref => ({ ...ref, data: getElement(ref) })).filter(item => item.data);
  const sortedPageElements = getAllElementsSorted(pageLayout);

  // 傳給 Konva 節點渲染函式的頁面 state（見 components/canvas/pageElementNodes）
  const canvasNodeContext = {
    isSelectMode: activeTool === "select",
    photoSlotDimensionMode,
    currentPageIndex,
    updateElement,
    setSelectedElement,
    onSelectElement: handleSelectElement,
    onActivateElement: handleActivateElement,
  };

  const isRefSelected = ref => selectedRefs.some(selectedRef => sameRef(selectedRef, ref));

  const renderElementNode = (node, {
    disabled = false,
    group = null,
    groupCenter = null,
  } = {}) => {
    const { type, data, index: elemIndex } = node;
    const elementRef = { type, id: data.id };
    const isSelected = isRefSelected(elementRef);

    if (type === "photo") {
      const controlProps = makePhotoControlProps(data, canvasNodeContext);
      if (disabled) Object.assign(controlProps, { draggable: false, listening: false });
      return renderPhotoSlotNode(data, elemIndex, isSelected, controlProps, canvasNodeContext);
    }

    const groupProps = makeGroupProps(type, data, canvasNodeContext);
    if (disabled) Object.assign(groupProps, { draggable: false, listening: false });
    if (groupCenter) {
      groupProps.x -= groupCenter.x;
      groupProps.y -= groupCenter.y;
    }
    if (group) {
      Object.assign(groupProps, {
        draggable: false,
        listening: activeTool === "select" && !disabled,
        onClick: (event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id);
        },
        onDblClick: (event) => {
          event.cancelBubble = true;
          enterGroup(group.id, elementRef);
        },
        onDblTap: (event) => {
          event.cancelBubble = true;
          enterGroup(group.id, elementRef);
        },
      });
    }

    if (type === "bubble") return renderBubbleNode(data, isSelected, groupProps);
    if (type === "text") return renderTextLabelNode(
      data,
      isSelected,
      groupProps,
      { suppressSelectedStroke: selectedRefs.length === 1 },
    );
    if (type === "sticker") return (
      <StickerNode
        key={`sticker-${data.id}`}
        sticker={data}
        templateId={templateId}
        isSelected={isSelected}
        suppressSelectedStroke={selectedRefs.length === 1}
        groupProps={groupProps}
      />
    );
    return null;
  };

  const renderGroupNode = (node) => {
    const group = node.data;
    const isIsolatedGroup = isolationGroupId != null && String(group.id) === String(isolationGroupId);
    if (isolationGroupId != null) {
      return (
        <KonvaGroup
          key={`group-visual-${group.id}`}
          opacity={isIsolatedGroup ? 1 : 0.25}
          listening={isIsolatedGroup && activeTool === "select"}
        >
          {node.children.map(childNode => renderElementNode(childNode, { disabled: !isIsolatedGroup }))}
        </KonvaGroup>
      );
    }

    const bounds = getGroupBounds(pageLayout, group.id);
    const center = {
      x: toDisplayCoord(bounds.centerX),
      y: toDisplayCoord(bounds.centerY),
    };
    const baseRotation = bounds.rotation ?? group.selection_rotation ?? 0;
    const resetTransientTransform = (konvaNode) => {
      konvaNode.position(center);
      konvaNode.rotation(baseRotation);
      konvaNode.scale({ x: 1, y: 1 });
    };
    const commitGroupTransform = (konvaNode, { includeScaleAndRotation }) => {
      const dx = toRealCoord(konvaNode.x() - center.x);
      const dy = toRealCoord(konvaNode.y() - center.y);
      const scale = includeScaleAndRotation
        ? (Math.abs(konvaNode.scaleX()) + Math.abs(konvaNode.scaleY())) / 2
        : 1;
      const rotationDelta = includeScaleAndRotation
        ? normalizeDegrees(konvaNode.rotation() - baseRotation)
        : 0;
      resetTransientTransform(konvaNode);
      try {
        commitPageLayout(currentLayout => {
          let nextLayout = currentLayout;
          if (Math.abs(scale - 1) > 0.0001) nextLayout = scaleGroupUniform(nextLayout, group.id, scale);
          if (Math.abs(rotationDelta) > 0.0001) nextLayout = rotateGroup(nextLayout, group.id, rotationDelta);
          if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
            nextLayout = moveGroup(nextLayout, group.id, { dx, dy });
          }
          return nextLayout;
        });
      } catch (error) {
        toast.error(error?.message || "無法變形群組");
      }
    };

    return (
      <KonvaGroup
        key={`group-${group.id}`}
        id={`group-${group.id}`}
        x={center.x}
        y={center.y}
        rotation={baseRotation}
        draggable={activeTool === "select"}
        listening={activeTool === "select"}
        onClick={(event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id);
        }}
        onDragEnd={event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: false })}
        onTransformEnd={event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: true })}
      >
        <KonvaGroup rotation={-baseRotation}>
          {node.children.map(childNode => renderElementNode(childNode, {
            group,
            groupCenter: center,
          }))}
        </KonvaGroup>
      </KonvaGroup>
    );
  };

  const renderRootNode = (node) => {
    if (node.kind === "group") return renderGroupNode(node);
    const renderedNode = renderElementNode(node, { disabled: isolationGroupId != null });
    if (isolationGroupId == null) return renderedNode;
    return (
      <KonvaGroup key={`isolated-dim-${node.type}-${node.id}`} opacity={0.25} listening={false}>
        {renderedNode}
      </KonvaGroup>
    );
  };

  return (
    <div className="flex flex-col">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
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
          {selectedRefs.length > 0 && (
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

                {/* root 只畫 standalone 或 group；grouped child 不會重複渲染 */}
                {rootRenderNodes.map(renderRootNode)}

                {renderFooterNode(pageLayout?.footer)}

                {/* Transformer：顯示縮放/旋轉把手 */}
                <Transformer
                  ref={transformerRef}
                  resizeEnabled={selectedRefs.length === 1}
                  keepRatio={selectedElement?.type === "group"
                    || (selectedElement?.type === "photo" && isolationGroupId == null)}
                  flipEnabled={false}
                  rotateEnabled={selectedRefs.length === 1}
                  centeredScaling={selectedElement?.type === "group"}
                  borderStroke="#4F46E5"
                  borderStrokeWidth={1}
                  anchorFill="#4F46E5"
                  anchorStroke="#ffffff"
                  anchorStrokeWidth={1}
                  anchorSize={8}
                  rotateAnchorOffset={20}
                  enabledAnchors={selectedRefs.length !== 1
                    ? []
                    : selectedElement?.type === "group" || selectedElement?.type === "photo"
                    // 群組與照片格只留四角把手等比縮放；隔離中的貼圖/文字可自由改比例
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
          {selectedRefs.length > 1 ? (
            <GroupSelectionPanel
              items={selectedItems}
              onGroup={handleCreateGroup}
            />
          ) : selectedElement && selectedPanelItem ? (
            <PropertyPanel
              selectedElement={selectedElement}
              elementData={selectedPanelItem}
              selectionScope={isolationGroupId == null ? "root" : "isolation"}
              selectedGroup={selectedGroup}
              groupChildren={selectedGroupChildren}
              isAnalyzingMaterial={analyzingTargetKey === (
                selectedElement.type === "group"
                  ? `group:${selectedElement.id}`
                  : selectedElement.type === "sticker" && selectedGroup
                    ? `group:${selectedGroup.id}`
                  : `sticker:${selectedElement.id}`
              )}
              onPropertyChange={(updates) => {
                if (selectedElement.type === "group") return;
                if (selectedElement.type === "photo") {
                  updatePhotoElementFromEditor(selectedElement.id, updates);
                  return;
                }
                updateElement(selectedElement.type, selectedElement.id, updates);
              }}
              onLayerChange={handleLayerChange}
              onEnterGroup={enterGroup}
              onExitGroup={exitGroup}
              onUngroup={handleUngroup}
              onAnalyzeMaterial={handleAnalyzeMaterial}
            />
          ) : (
            <LayerListPanel
              pageLayout={pageLayout}
              sortedPageElements={sortedPageElements}
              rootRenderNodes={rootRenderNodes}
              isolationGroup={isolationRenderNode}
              selectedRefs={selectedRefs}
              currentPageIndex={currentPageIndex}
              photoSlotDimensionMode={photoSlotDimensionMode}
              backgroundUrl={backgroundUrl}
              onSelectElement={(type, id, options) => handleSelectElement({ type, id }, options)}
              onSelectGroup={handleSelectGroup}
              onEnterGroup={enterGroup}
              onExitGroup={exitGroup}
            />
          )}
        </div>
      </div>
    </div>
  );
}
