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
  buildRootRenderNodes,
  deleteLayoutElement,
  deleteLayoutGroup,
  flattenRenderNodes,
  getDescendantLeafRefs,
  getGroupAncestorPath,
  getGroupBounds,
  getGroupById,
  getMaterialTextLinkForNode,
  getNodeBounds,
  getNodeParent,
  getScopeNodes,
  groupElements,
  insertNodeInScope,
  linkMaterialText,
  projectNormalizedBoxToSticker,
  removeInvalidMaterialTextLinks,
  reorderNode,
  resolveHitToDirectChild,
  transformGroup,
  ungroupElements,
  validateLayoutGroups,
} from "../utils/layoutGroups";
import {
  getMarqueeSelectableRefs,
  normalizeSelectionRect,
  pointIsInsideOrientedBounds,
} from "../utils/marqueeSelection";

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

function uniqueRefs(refs) {
  const seen = new Set();
  return (refs || []).filter((ref) => {
    const key = refKey(ref);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findRenderNode(nodes, ref) {
  const stack = [...(nodes || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.type === ref?.type && String(node.id) === String(ref.id)) return node;
    if (node.kind === "group") {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]);
      }
    }
  }
  return null;
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
  const [isolationPath, setIsolationPath] = useState([]);
  const [marqueeGesture, setMarqueeGesture] = useState(null);
  const [transientTypographyScales, setTransientTypographyScales] = useState({});
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
  const editorViewRef = useRef({ isolationPath: [], selectedRefs: [] });
  const activeCanvasGestureRef = useRef(null);
  const analysisRequestRef = useRef(null);
  const activePageSessionIdRef = useRef(null);
  const suppressNextStageClickRef = useRef(false);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);
  const isolationGroupId = isolationPath.length ? isolationPath[isolationPath.length - 1] : null;
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
  }, []);
  const beginCanvasGesture = useCallback((kind) => {
    activeCanvasGestureRef.current = kind;
  }, []);
  const endCanvasGesture = useCallback(() => {
    activeCanvasGestureRef.current = null;
  }, []);
  const resetEditorView = useCallback(() => {
    activeCanvasGestureRef.current = null;
    setSelectedRefs([]);
    setIsolationPath([]);
    setMarqueeGesture(null);
  }, []);
  const reconcileRestoredEditorView = useCallback((restoredLayout) => {
    const previousView = editorViewRef.current;
    let nextPath = [];
    for (let index = previousView.isolationPath.length - 1; index >= 0; index -= 1) {
      const candidateId = previousView.isolationPath[index];
      if (getGroupById(restoredLayout, candidateId)) {
        nextPath = getGroupAncestorPath(restoredLayout, candidateId);
        break;
      }
    }
    const nextScopeId = nextPath.length ? nextPath[nextPath.length - 1] : null;
    const directKeys = new Set(getScopeNodes(restoredLayout, nextScopeId).map(refKey));
    const nextSelection = previousView.selectedRefs.filter(ref => directKeys.has(refKey(ref)));
    editorViewRef.current = { isolationPath: nextPath, selectedRefs: nextSelection };
    setIsolationPath(nextPath);
    setSelectedRefs(nextSelection);
    setMarqueeGesture(null);
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
  } = useLayoutHistory({
    currentPage,
    pageLayout,
    setPageLayout,
    onLayoutRestored: reconcileRestoredEditorView,
  });

  useEffect(() => {
    pageLayoutRef.current = pageLayout;
  }, [pageLayout]);

  useEffect(() => {
    editorViewRef.current = { isolationPath, selectedRefs };
  }, [isolationPath, selectedRefs]);

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
      .map(ref => {
        const nodeId = `${ref.type}-${ref.id}`;
        return stageRef.current.findOne(node => node.id() === nodeId);
      })
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
    resetEditorView();
  }, [currentPageIndex, template, applyPageDisplay, resetEditorView]);

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
    for (const [pageId, draftLayout] of Object.entries(draftLayouts.current)) {
      const draftValidation = validateLayoutGroups(draftLayout);
      if (draftValidation.valid) continue;
      const pageIndex = template.pages.findIndex(page => String(page.id) === String(pageId));
      const pageLabel = pageIndex >= 0 ? `第 ${pageIndex + 1} 頁` : "其他頁面";
      toast.error(draftValidation.topologyValid
        ? `${pageLabel}仍有失效素材連結，請先清除`
        : `${pageLabel}的群組資料格式不正確`);
      return false;
    }
    const currentValidation = validateLayoutGroups(pageLayoutRef.current || {});
    if (currentValidation.topologyValid && !currentValidation.linkValid) {
      toast.error("請先清除失效素材連結再儲存");
      return false;
    }
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
      setIsolationPath([]);
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

  const handleSelectDirectRef = useCallback((directRef, { additive = false } = {}) => {
    if (!pageLayout || !directRef) return;
    const directKeys = new Set(getScopeNodes(pageLayout, isolationGroupId).map(refKey));
    if (!directKeys.has(refKey(directRef))) return;
    if (!additive) {
      setSelectedRefs([directRef]);
      return;
    }
    setSelectedRefs(currentRefs => {
      const baseRefs = currentRefs.filter(ref => directKeys.has(refKey(ref)));
      return baseRefs.some(ref => sameRef(ref, directRef))
        ? baseRefs.filter(ref => !sameRef(ref, directRef))
        : [...baseRefs, directRef];
    });
  }, [isolationGroupId, pageLayout]);

  const handleSelectElement = useCallback((elementRef, options = {}) => {
    if (!pageLayout || !elementRef) return;
    const directRef = resolveHitToDirectChild(pageLayout, isolationGroupId, elementRef);
    if (directRef) handleSelectDirectRef(directRef, options);
  }, [handleSelectDirectRef, isolationGroupId, pageLayout]);

  const handleSelectGroup = useCallback((groupId, options = {}) => {
    handleSelectDirectRef({ type: "group", id: groupId }, options);
  }, [handleSelectDirectRef]);

  const enterGroup = useCallback((groupId, preferredHit = null) => {
    if (!pageLayout) return;
    const groupRef = { type: "group", id: groupId };
    const isDirect = getScopeNodes(pageLayout, isolationGroupId).some(ref => sameRef(ref, groupRef));
    const group = isDirect ? getGroupById(pageLayout, groupId) : null;
    if (!group) return;
    let nextChild = null;
    if (preferredHit?.type === "group") {
      nextChild = group.children.find(ref => sameRef(ref, preferredHit)) ?? null;
    } else if (preferredHit) {
      nextChild = resolveHitToDirectChild(pageLayout, group.id, preferredHit);
    }
    nextChild ??= group.children[0] ?? null;
    setIsolationPath(getGroupAncestorPath(pageLayout, group.id));
    setSelectedRefs(nextChild ? [nextChild] : []);
  }, [isolationGroupId, pageLayout]);

  const exitGroup = useCallback(() => {
    if (!isolationPath.length) return;
    const exitedGroupId = isolationPath[isolationPath.length - 1];
    setIsolationPath(currentPath => currentPath.slice(0, -1));
    setSelectedRefs([{ type: "group", id: exitedGroupId }]);
  }, [isolationPath]);

  const navigateIsolation = useCallback((pathIndex) => {
    if (!isolationPath.length) return;
    const nextLength = Math.max(0, Math.min(isolationPath.length, pathIndex + 1));
    if (nextLength === isolationPath.length) return;
    const exitedDirectGroupId = isolationPath[nextLength];
    setIsolationPath(isolationPath.slice(0, nextLength));
    setSelectedRefs(exitedDirectGroupId == null
      ? []
      : [{ type: "group", id: exitedDirectGroupId }]);
  }, [isolationPath]);

  const handleActivateElement = useCallback((elementRef) => {
    if (!pageLayout || !elementRef) return;
    const directRef = resolveHitToDirectChild(pageLayout, isolationGroupId, elementRef);
    if (directRef?.type === "group") enterGroup(directRef.id, elementRef);
  }, [enterGroup, isolationGroupId, pageLayout]);

  const handleCreateGroup = useCallback(() => {
    if (selectedRefs.length < 2) return;
    let createdGroupId = null;
    try {
      commitPageLayout(currentLayout => {
        createdGroupId = getUniqueGroupId(currentLayout);
        return groupElements(currentLayout, selectedRefs, {
          groupId: createdGroupId,
          parentGroupId: isolationGroupId,
        });
      });
      if (createdGroupId != null) setSelectedRefs([{ type: "group", id: createdGroupId }]);
    } catch (error) {
      toast.error(error?.message || "無法建立群組");
    }
  }, [commitPageLayout, isolationGroupId, selectedRefs]);

  const handleUngroup = useCallback((groupId) => {
    const group = getGroupById(pageLayout, groupId);
    if (!group) return;
    try {
      commitPageLayout(currentLayout => ungroupElements(currentLayout, groupId));
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
        const scopeNodes = getScopeNodes(currentLayout, isolationGroupId);
        const selectedIndex = scopeNodes.findIndex(ref => sameRef(ref, selectedElement));
        if (selectedIndex < 0) return currentLayout;
        const targetIndex = direction === "top" ? scopeNodes.length - 1
            : direction === "bottom" ? 0
              : direction === "up" ? Math.min(scopeNodes.length - 1, selectedIndex + 1)
                : Math.max(0, selectedIndex - 1);
        return targetIndex === selectedIndex
          ? currentLayout
          : reorderNode(currentLayout, selectedElement, {
            parentGroupId: isolationGroupId,
            toIndex: targetIndex,
          });
      });
    } catch (error) {
      toast.error(error?.message || "無法調整圖層");
    }
  }, [commitPageLayout, isolationGroupId, selectedElement]);

  useEffect(() => {
    if (!pageLayout) return;
    const deepestSurvivingId = [...isolationPath].reverse().find(id => getGroupById(pageLayout, id));
    const canonicalPath = deepestSurvivingId == null
      ? []
      : getGroupAncestorPath(pageLayout, deepestSurvivingId);
    if (canonicalPath.length !== isolationPath.length
      || canonicalPath.some((id, index) => String(id) !== String(isolationPath[index]))) {
      setIsolationPath(canonicalPath);
      return;
    }
    const directKeys = new Set(getScopeNodes(pageLayout, isolationGroupId).map(refKey));
    setSelectedRefs(currentRefs => {
      const survivingRefs = currentRefs.filter(ref => directKeys.has(refKey(ref)));
      return survivingRefs.length === currentRefs.length ? currentRefs : survivingRefs;
    });
  }, [isolationGroupId, isolationPath, pageLayout]);

  // Delete / Backspace / Undo / Redo / 群組導覽與方向鍵
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      const isInputTarget = isKeyboardInputTarget(document.activeElement);
      const normalizedKey = keyEvent.key.toLowerCase();
      const isModifiedEditorCommand = (keyEvent.ctrlKey || keyEvent.metaKey)
        && ["g", "y", "z"].includes(normalizedKey);
      const isUnmodifiedEditorCommand = [
        "Escape", "Enter", "Delete", "Backspace",
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      ].includes(keyEvent.key);
      if (activeCanvasGestureRef.current
        && (isModifiedEditorCommand || isUnmodifiedEditorCommand)) {
        keyEvent.preventDefault();
        return;
      }
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
      const isGroupShortcut = (keyEvent.ctrlKey || keyEvent.metaKey)
        && normalizedKey === "g";
      const canToggleGroup = selectedRefs.length >= 2
        || (selectedRefs.length === 1 && selectedRefs[0].type === "group");
      if (isGroupShortcut && canToggleGroup) {
        keyEvent.preventDefault();
        if (keyEvent.repeat) return;
        if (selectedRefs.length >= 2) handleCreateGroup();
        else if (selectedRefs.length === 1 && selectedRefs[0].type === "group") {
          handleUngroup(selectedRefs[0].id);
        }
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
            if (ref.type === "group") return transformGroup(nextLayout, ref.id, { dx, dy });
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
    handleCreateGroup,
    handleUngroup,
    isolationGroupId,
    redoLayout,
    selectedElement,
    selectedRefs,
    undoLayout,
  ]);

  const handleAnalyzeMaterial = useCallback(async (target) => {
    const layoutSnapshot = pageLayoutRef.current;
    if (!layoutSnapshot || !currentPage) return;
    const currentValidation = validateLayoutGroups(layoutSnapshot);
    if (currentValidation.topologyValid && !currentValidation.linkValid) {
      toast.error("請先清除失效素材連結");
      return;
    }
    const stickerRef = target?.type === "sticker" ? { type: "sticker", id: target.id } : null;
    const sticker = stickerRef ? getElement(stickerRef, layoutSnapshot) : null;

    if (!sticker?.path) {
      toast.error("找不到可分析的圖片素材");
      return;
    }
    const existingLink = getMaterialTextLinkForNode(layoutSnapshot, stickerRef);
    const requestedTextId = target?.textId ?? existingLink?.text_id ?? null;
    const parentGroupId = getNodeParent(layoutSnapshot, stickerRef)?.id ?? null;
    const scopeSignature = JSON.stringify(getScopeNodes(layoutSnapshot, parentGroupId));
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
      parentGroupId,
      scopeSignature,
      textId: requestedTextId,
      hadExistingLink: !!existingLink,
    };
    analysisRequestRef.current = request;
    setAnalyzingTargetKey(`sticker:${sticker.id}`);

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
      const currentParentId = currentSticker
        ? getNodeParent(currentLayout, { type: "sticker", id: currentSticker.id })?.id ?? null
        : null;
      const responseMatches = suggestion?.request_token === request.requestToken;
      const sourceMatches = request.sourceRevision == null
        || suggestion?.source_revision === request.sourceRevision;
      if (
        !currentSticker
        || String(currentParentId ?? "") !== String(request.parentGroupId ?? "")
        || JSON.stringify(getScopeNodes(currentLayout, currentParentId)) !== request.scopeSignature
        || !responseMatches
        || !sourceMatches
        || getStickerAnalysisSignature(currentSticker) !== request.geometrySignature
      ) {
        toast.error("圖片或圖層已變更，分析結果未套用，請重新分析");
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

      let resultTextId = request.textId;
      let resultIsolationPath = [];
      let didApply = false;
      commitPageLayout(baseLayout => {
        if (String(activePageSessionIdRef.current) !== String(request.pageId)) return baseLayout;
        const latestStickerRef = { type: "sticker", id: request.stickerId };
        const latestSticker = getElement(latestStickerRef, baseLayout);
        const latestParentId = latestSticker
          ? getNodeParent(baseLayout, latestStickerRef)?.id ?? null
          : null;
        if (
          !latestSticker
          || String(latestParentId ?? "") !== String(request.parentGroupId ?? "")
          || JSON.stringify(getScopeNodes(baseLayout, latestParentId)) !== request.scopeSignature
          || getStickerAnalysisSignature(latestSticker) !== request.geometrySignature
        ) return baseLayout;

        const nextGeometry = projectNormalizedBoxToSticker(latestSticker, suggestion.normalized_box);
        const latestLink = getMaterialTextLinkForNode(baseLayout, latestStickerRef);
        if (request.textId != null) {
          if (request.hadExistingLink && String(latestLink?.text_id ?? "") !== String(request.textId)) {
            return baseLayout;
          }
          if (!request.hadExistingLink && latestLink) return baseLayout;
          const linkedTextRef = { type: "text", id: request.textId };
          const linkedText = getElement(linkedTextRef, baseLayout);
          if (!linkedText) return baseLayout;
          if (!request.hadExistingLink) {
            const textParentId = getNodeParent(baseLayout, linkedTextRef)?.id ?? null;
            if (String(textParentId ?? "") !== String(latestParentId ?? "")) return baseLayout;
          }
          didApply = true;
          resultTextId = linkedText.id;
          const textParentId = getNodeParent(baseLayout, linkedTextRef)?.id ?? null;
          resultIsolationPath = textParentId == null
            ? []
            : getGroupAncestorPath(baseLayout, textParentId);
          const withGeometry = {
            ...baseLayout,
            text_labels: (baseLayout.text_labels || []).map(textLabel => (
              String(textLabel.id) === String(linkedText.id)
                ? { ...textLabel, ...nextGeometry }
                : textLabel
            )),
          };
          return linkMaterialText(withGeometry, {
            materialId: latestSticker.id,
            textId: linkedText.id,
          });
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
        nextLayout = insertNodeInScope(nextLayout, newTextRef, {
          parentGroupId: latestParentId,
          afterRef: latestStickerRef,
        });
        nextLayout = linkMaterialText(nextLayout, {
          materialId: latestSticker.id,
          textId: newTextId,
        });
        resultTextId = newTextId;
        resultIsolationPath = latestParentId == null
          ? []
          : getGroupAncestorPath(nextLayout, latestParentId);
        didApply = true;
        return nextLayout;
      });

      if (didApply) {
        setIsolationPath(resultIsolationPath);
        setSelectedRefs([{ type: "text", id: resultTextId }]);
        toast.success(request.textId != null ? "已重設文字框" : "已建立文字框");
      } else {
        toast.error("圖片或圖層已變更，分析結果未套用，請重新分析");
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

  const handleLinkSelectedMaterialText = useCallback(() => {
    const stickerRef = selectedRefs.find(ref => ref.type === "sticker");
    const textRef = selectedRefs.find(ref => ref.type === "text");
    if (selectedRefs.length !== 2 || !stickerRef || !textRef) return;
    handleAnalyzeMaterial({ ...stickerRef, textId: textRef.id });
  }, [handleAnalyzeMaterial, selectedRefs]);

  // ── Konva Stage 事件：放置元素 or 取消選取 ───────────────────────────────

  const getPointerCoordinates = useCallback(() => {
    const position = stageRef.current?.getPointerPosition();
    if (!position) return null;
    return {
      display: position,
      real: { x: toRealCoord(position.x), y: toRealCoord(position.y) },
    };
  }, []);

  const handleStagePointerDown = useCallback((event) => {
    if (activeTool !== "select" || event.target !== event.target.getStage()) return;
    if (event.evt?.button != null && event.evt.button !== 0) return;
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    setMarqueeGesture({
      startDisplay: pointer.display,
      currentDisplay: pointer.display,
      startReal: pointer.real,
      currentReal: pointer.real,
      additive: !!event.evt?.shiftKey,
      baseSelection: event.evt?.shiftKey ? [...selectedRefs] : [],
      active: false,
    });
    beginCanvasGesture("marquee");
  }, [activeTool, beginCanvasGesture, getPointerCoordinates, selectedRefs]);

  const handleStagePointerMove = useCallback(() => {
    if (!marqueeGesture || !pageLayout) return;
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const distance = Math.hypot(
      pointer.display.x - marqueeGesture.startDisplay.x,
      pointer.display.y - marqueeGesture.startDisplay.y,
    );
    const active = marqueeGesture.active || distance > 4;
    const nextGesture = {
      ...marqueeGesture,
      currentDisplay: pointer.display,
      currentReal: pointer.real,
      active,
    };
    setMarqueeGesture(nextGesture);
    if (!active) return;
    const selectionRect = normalizeSelectionRect(nextGesture.startReal, nextGesture.currentReal);
    const hits = getMarqueeSelectableRefs(pageLayout, selectionRect, {
      parentGroupId: isolationGroupId,
    });
    setSelectedRefs(nextGesture.additive
      ? uniqueRefs([...nextGesture.baseSelection, ...hits])
      : hits);
  }, [getPointerCoordinates, isolationGroupId, marqueeGesture, pageLayout]);

  const handleStagePointerUp = useCallback(() => {
    if (!marqueeGesture) return;
    if (marqueeGesture.active) suppressNextStageClickRef.current = true;
    setMarqueeGesture(null);
    endCanvasGesture();
  }, [endCanvasGesture, marqueeGesture]);

  useEffect(() => {
    if (!marqueeGesture) return undefined;
    window.addEventListener("mouseup", handleStagePointerUp);
    window.addEventListener("touchend", handleStagePointerUp);
    window.addEventListener("touchcancel", handleStagePointerUp);
    return () => {
      window.removeEventListener("mouseup", handleStagePointerUp);
      window.removeEventListener("touchend", handleStagePointerUp);
      window.removeEventListener("touchcancel", handleStagePointerUp);
    };
  }, [handleStagePointerUp, marqueeGesture]);

  const handleStageDoubleClick = useCallback((event) => {
    if (activeTool !== "select" || isolationGroupId == null) return;
    if (event.target !== event.target.getStage()) return;
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const currentBounds = getGroupBounds(pageLayoutRef.current, isolationGroupId);
    if (!pointIsInsideOrientedBounds(pointer.real, currentBounds)) {
      event.cancelBubble = true;
      exitGroup();
    }
  }, [activeTool, exitGroup, getPointerCoordinates, isolationGroupId]);

  const handleStageClick = (e) => {
    if (!pageLayout) return;
    if (suppressNextStageClickRef.current) {
      suppressNextStageClickRef.current = false;
      return;
    }
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const realX = pointer.real.x;
    const realY = pointer.real.y;

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
      setIsolationPath([]);
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
      setIsolationPath([]);
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
      setIsolationPath([]);
      setSelectedElement({ type: "text", id: newTextLabel.id });
      return;
    }

    // 選取模式：點擊空白處取消選取
    if (e.target === stageRef.current && !e.evt?.shiftKey) {
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
  const getNodeData = ref => (
    ref?.type === "group" ? getGroupById(pageLayout, ref.id) : getElement(ref)
  );
  const selectedItems = selectedRefs.map(ref => ({ ...ref, data: getNodeData(ref) })).filter(item => item.data);
  const activeScopeRefs = getScopeNodes(pageLayout, isolationGroupId);
  const activeScopeRenderNodes = activeScopeRefs
    .map(ref => findRenderNode(rootRenderNodes, ref))
    .filter(Boolean);
  const flattenedSceneLeaves = flattenRenderNodes(rootRenderNodes);
  const activeLeafKeys = new Set(
    isolationGroupId == null
      ? []
      : getDescendantLeafRefs(pageLayout, isolationGroupId).map(refKey),
  );
  const activeLeafIndices = flattenedSceneLeaves
    .map((node, index) => (activeLeafKeys.has(refKey(node)) ? index : -1))
    .filter(index => index >= 0);
  const activeSceneStart = activeLeafIndices.length ? activeLeafIndices[0] : 0;
  const activeSceneEnd = activeLeafIndices.length
    ? activeLeafIndices[activeLeafIndices.length - 1]
    : -1;
  const passiveSceneBefore = isolationGroupId == null
    ? []
    : flattenedSceneLeaves.slice(0, activeSceneStart);
  const passiveSceneAfter = isolationGroupId == null
    ? []
    : flattenedSceneLeaves.slice(activeSceneEnd + 1);
  const isolationTrail = isolationPath.map((groupId, index) => ({
    id: groupId,
    label: `群組 ${index + 1}`,
    data: getGroupById(pageLayout, groupId),
  }));
  const sortedPageElements = getAllElementsSorted(pageLayout);
  const selectedMaterialLink = selectedElement
    ? getMaterialTextLinkForNode(pageLayout, selectedElement)
    : null;
  const selectedAnalysisStickerId = selectedElement?.type === "sticker"
    ? selectedElement.id
    : selectedMaterialLink?.material_id ?? null;
  const marqueeDisplayRect = marqueeGesture?.active
    ? normalizeSelectionRect(marqueeGesture.startDisplay, marqueeGesture.currentDisplay)
    : null;
  const layoutValidation = validateLayoutGroups(pageLayout || {});
  const hasRepairableMaterialLinks = layoutValidation.topologyValid && !layoutValidation.linkValid;

  // 傳給 Konva 節點渲染函式的頁面 state（見 components/canvas/pageElementNodes）
  const canvasNodeContext = {
    isSelectMode: activeTool === "select",
    photoSlotDimensionMode,
    currentPageIndex,
    updateElement,
    setSelectedElement,
    onSelectElement: handleSelectElement,
    onActivateElement: handleActivateElement,
    onGestureStart: beginCanvasGesture,
    onGestureEnd: endCanvasGesture,
  };

  const isRefSelected = ref => selectedRefs.some(selectedRef => sameRef(selectedRef, ref));

  const renderElementNode = (node, {
    disabled = false,
    group = null,
    typographyScale = 1,
  } = {}) => {
    const { type, data, index: elemIndex } = node;
    const elementRef = { type, id: data.id };
    const isSelected = isRefSelected(elementRef);

    if (type === "photo") {
      const controlProps = makePhotoControlProps(data, canvasNodeContext);
      if (disabled) Object.assign(controlProps, { draggable: false, listening: false });
      if (group) {
        Object.assign(controlProps, {
          draggable: false,
          listening: activeTool === "select" && !disabled,
          onClick: (event) => {
            event.cancelBubble = true;
            handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
          },
          onTap: (event) => {
            event.cancelBubble = true;
            handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
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
      return renderPhotoSlotNode(data, elemIndex, isSelected, controlProps, canvasNodeContext);
    }

    const groupProps = makeGroupProps(type, data, canvasNodeContext);
    if (disabled) Object.assign(groupProps, { draggable: false, listening: false });
    if (group) {
      Object.assign(groupProps, {
        draggable: false,
        listening: activeTool === "select" && !disabled,
        onClick: (event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
        },
        onTap: (event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
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

    if (type === "bubble") return renderBubbleNode(
      data,
      isSelected,
      groupProps,
      { suppressSelectedStroke: selectedRefs.length === 1, typographyScale },
    );
    if (type === "text") return renderTextLabelNode(
      data,
      isSelected,
      groupProps,
      { suppressSelectedStroke: selectedRefs.length === 1, typographyScale },
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

  const renderDirectGroupNode = (node) => {
    const group = node.data;
    const bounds = getNodeBounds(pageLayout, { type: "group", id: group.id });
    const center = {
      x: toDisplayCoord(bounds.centerX),
      y: toDisplayCoord(bounds.centerY),
    };
    const displayWidth = toDisplayCoord(bounds.width);
    const displayHeight = toDisplayCoord(bounds.height);
    const baseRotation = bounds.rotation ?? group.selection_rotation ?? 0;
    const typographyScale = transientTypographyScales[String(group.id)] ?? 1;
    const resetTransientTransform = (konvaNode) => {
      konvaNode.position(center);
      konvaNode.rotation(baseRotation);
      konvaNode.scale({ x: 1, y: 1 });
      setTransientTypographyScales(current => {
        if (current[String(group.id)] == null) return current;
        const next = { ...current };
        delete next[String(group.id)];
        return next;
      });
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
        commitPageLayout(currentLayout => transformGroup(currentLayout, group.id, {
          dx,
          dy,
          rotationDelta,
          scale,
        }));
      } catch (error) {
        toast.error(error?.message || "無法變形群組");
      } finally {
        endCanvasGesture();
      }
    };

    return (
      <KonvaGroup
        key={`group-${group.id}`}
        id={`group-${group.id}`}
        x={center.x}
        y={center.y}
        width={displayWidth}
        height={displayHeight}
        rotation={baseRotation}
        draggable={activeTool === "select"}
        listening={activeTool === "select"}
        onClick={(event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
        }}
        onTap={(event) => {
          event.cancelBubble = true;
          handleSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
        }}
        onDblClick={(event) => {
          event.cancelBubble = true;
          enterGroup(group.id);
        }}
        onDblTap={(event) => {
          event.cancelBubble = true;
          enterGroup(group.id);
        }}
        onDragStart={() => beginCanvasGesture("group-drag")}
        onDragEnd={event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: false })}
        onTransformStart={() => beginCanvasGesture("group-transform")}
        onTransform={(event) => {
          const nodeScale = (
            Math.abs(event.currentTarget.scaleX()) + Math.abs(event.currentTarget.scaleY())
          ) / 2;
          const safeScale = Number.isFinite(nodeScale) && nodeScale > 0 ? nodeScale : 1;
          setTransientTypographyScales(current => (
            current[String(group.id)] === safeScale
              ? current
              : { ...current, [String(group.id)]: safeScale }
          ));
        }}
        onTransformEnd={event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: true })}
      >
        <Rect
          x={-displayWidth / 2}
          y={-displayHeight / 2}
          width={displayWidth}
          height={displayHeight}
          fill="rgba(255,255,255,0.001)"
        />
        <KonvaGroup rotation={-baseRotation}>
          <KonvaGroup x={-center.x} y={-center.y}>
            {flattenRenderNodes([node]).map(childNode => renderElementNode(childNode, {
              group,
              typographyScale,
            }))}
          </KonvaGroup>
        </KonvaGroup>
      </KonvaGroup>
    );
  };

  const renderActiveScopeNode = (node) => (
    node.kind === "group" ? renderDirectGroupNode(node) : renderElementNode(node)
  );

  const renderPassiveLeaf = (node) => (
    <KonvaGroup key={`passive-${node.type}-${node.id}`} opacity={0.25} listening={false}>
      {renderElementNode(node, { disabled: true })}
    </KonvaGroup>
  );

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
            disabled={isSaving || hasRepairableMaterialLinks}
            title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined}
            data-guide="save-template"
            className="px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "儲存中..." : "儲存"}
          </button>
        </div>
      </div>

      {hasRepairableMaterialLinks && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
          <span>此頁含失效或重複的素材文字連結；版面仍可檢視，但建議先清理。</span>
          <button
            type="button"
            onClick={() => commitPageLayout(currentLayout => removeInvalidMaterialTextLinks(currentLayout))}
            className="flex-shrink-0 rounded border border-amber-400 bg-white px-3 py-1.5 font-medium hover:bg-amber-100"
          >
            清除失效素材連結
          </button>
        </div>
      )}

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
              onTap={handleStageClick}
              onMouseDown={handleStagePointerDown}
              onMouseMove={handleStagePointerMove}
              onMouseUp={handleStagePointerUp}
              onTouchStart={handleStagePointerDown}
              onTouchMove={handleStagePointerMove}
              onTouchEnd={handleStagePointerUp}
              onDblClick={handleStageDoubleClick}
              onDblTap={handleStageDoubleClick}
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

                {/* 只讓目前 scope 的 direct nodes 可互動；隔離外葉節點維持原 z-slot 並淡化。 */}
                {isolationGroupId == null ? (
                  activeScopeRenderNodes.map(renderActiveScopeNode)
                ) : (
                  <>
                    {passiveSceneBefore.map(renderPassiveLeaf)}
                    {activeScopeRenderNodes.map(renderActiveScopeNode)}
                    {passiveSceneAfter.map(renderPassiveLeaf)}
                  </>
                )}

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

                {marqueeDisplayRect && (
                  <Rect
                    x={marqueeDisplayRect.x}
                    y={marqueeDisplayRect.y}
                    width={marqueeDisplayRect.width}
                    height={marqueeDisplayRect.height}
                    fill="rgba(79,70,229,0.08)"
                    stroke="#4F46E5"
                    strokeWidth={1}
                    dash={[5, 3]}
                    listening={false}
                  />
                )}
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
              onLinkMaterialText={handleLinkSelectedMaterialText}
              materialActionsDisabled={hasRepairableMaterialLinks}
            />
          ) : selectedElement && selectedPanelItem ? (
            <PropertyPanel
              selectedElement={selectedElement}
              elementData={selectedPanelItem}
              selectionScope={isolationGroupId == null ? "root" : "isolation"}
              selectedGroup={selectedGroup}
              isolationTrail={isolationTrail}
              materialTextLink={selectedMaterialLink}
              materialActionsDisabled={hasRepairableMaterialLinks}
              isAnalyzingMaterial={selectedAnalysisStickerId != null
                && analyzingTargetKey === `sticker:${selectedAnalysisStickerId}`}
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
              onNavigateIsolation={navigateIsolation}
              onUngroup={handleUngroup}
              onAnalyzeMaterial={(target) => {
                if (target?.type === "text" && selectedMaterialLink) {
                  handleAnalyzeMaterial({
                    type: "sticker",
                    id: selectedMaterialLink.material_id,
                    textId: target.id,
                  });
                  return;
                }
                handleAnalyzeMaterial(target);
              }}
            />
          ) : (
            <LayerListPanel
              pageLayout={pageLayout}
              sortedPageElements={sortedPageElements}
              rootRenderNodes={rootRenderNodes}
              scopeRenderNodes={activeScopeRenderNodes}
              isolationTrail={isolationTrail}
              selectedRefs={selectedRefs}
              currentPageIndex={currentPageIndex}
              photoSlotDimensionMode={photoSlotDimensionMode}
              backgroundUrl={backgroundUrl}
              onSelectElement={(type, id, options) => handleSelectElement({ type, id }, options)}
              onSelectGroup={handleSelectGroup}
              onEnterGroup={enterGroup}
              onExitGroup={exitGroup}
              onNavigateIsolation={navigateIsolation}
            />
          )}
        </div>
      </div>
    </div>
  );
}
