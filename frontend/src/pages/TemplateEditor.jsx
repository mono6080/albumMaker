// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性
// 分工：per-page 草稿/歷史在 hooks/useLayoutHistory、Stage 與節點生命週期在
// components/canvas、雙頁預覽與圖層清單為獨立 component

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { BookOpen, CircleHelp, SlidersHorizontal } from "lucide-react";

import { uploadBackground, uploadSticker } from "../api/templateApi";
import ImageCropModal from "../components/ImageCropModal";
import {
  applyPhotoEditorUpdates,
  clampPhotoContentRect,
} from "../components/canvas/pageElementNodes";
import TemplateCanvas from "../components/canvas/TemplateCanvas";
import LayerListPanel from "../components/LayerListPanel";
import PropertyPanel from "../components/PropertyPanel";
import GroupSelectionPanel from "../components/GroupSelectionPanel";
import EditorInspector from "../components/EditorInspector";
import EditorCommandDock from "../components/EditorCommandDock";
import EditorPagesPanel from "../components/EditorPagesPanel";
import EditorSheet from "../components/EditorSheet";
import EditorToolsPanel from "../components/EditorToolsPanel";
import SelectionQuickActions from "../components/SelectionQuickActions";
import TemplateUsageBanner from "../components/editor/TemplateUsageBanner";
import TemplateEditorHeader from "../components/editor/TemplateEditorHeader";
import TemplateEditorEmptyState from "../components/editor/TemplateEditorEmptyState";
import ConfirmModal from "../components/ConfirmModal";
import SpreadPreviewModal from "../components/SpreadPreviewModal";
import { useAuth } from "../context/AuthContext";
import useEditorStylePreferences from "../hooks/useEditorStylePreferences";
import useEditorViewportMode, {
  EDITOR_VIEWPORT_MODE,
} from "../hooks/useEditorViewportMode";
import useLayoutHistory, { getEditorPageKey } from "../hooks/useLayoutHistory";
import useEditorSelection, { refKey, sameRef } from "../hooks/useEditorSelection";
import useLayoutClipboard from "../hooks/useLayoutClipboard";
import useEditorShortcuts from "../hooks/useEditorShortcuts";
import useMaterialTextSuggestion from "../hooks/useMaterialTextSuggestion";
import useTemplateEditorNavigationGuard from "../hooks/useTemplateEditorNavigationGuard";
import useTemplateEditorDocument, {
  buildTemplateSyncSuccessMessage,
} from "../hooks/useTemplateEditorDocument";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  CANVAS_REAL_HEIGHT,
  CANVAS_REAL_WIDTH,
  ELEMENT_ARRAY_KEY,
  getInitialStickerSize,
  getNextZIndex,
  toRealCoord,
} from "../utils/renderLayoutModel";
import {
  buildPhotoSlotFromContentRect,
  getPhotoContentRect,
  getPhotoSlotDimensionMode,
} from "../utils/photoFrameGeometry.js";
import { TEXT_LABEL_ROLES } from "../utils/textLabelRoles";
import { startProductGuide } from "../utils/productGuide";
import { buildEditorLayoutModel } from "../utils/editorLayoutModel.js";
import {
  deleteLayoutElement,
  deleteLayoutGroup,
  getNodeParent,
  getScopeNodes,
  groupElements,
  removeInvalidMaterialTextLinks,
  reorderNode,
  ungroupElements,
} from "../utils/layoutGroups";
import {
  getLayoutNodeData,
  getNodeLayerState,
  updateLayoutNodeMetadata,
} from "../utils/layoutLayerState.js";
import {
  alignLayoutNodes,
  canMatchSelectionSize,
  distributeLayoutNodes,
} from "../utils/layoutSelectionOperations.js";

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
    title: "屬性與圖層",
    description: "用屬性調整選取物件；切到圖層可精準選取群組、文字、照片格與貼圖。純排版文字可設為固定文字，避免老師端修改。",
    side: "left",
    align: "center",
  },
];

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function getUniqueGroupId(layout) {
  const usedIds = new Set((layout?.groups || []).map(group => String(group.id)));
  let candidate = generateElementId();
  while (usedIds.has(String(candidate))) candidate = generateElementId();
  return candidate;
}

const MOBILE_PANEL = {
  ADD: "add",
  PAGES: "pages",
  LAYERS: "layers",
  PROPERTIES: "properties",
};

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
  if (import.meta.env.DEV) globalThis.__ALBUM_EDITOR_RENDER_PROBE__?.("TemplateEditor");
  const { id: templateId } = useParams();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const {
    favoriteStyles,
    recentColors,
    recentFonts,
    rememberStyleUpdates,
    saveFavoriteStyle,
    removeFavoriteStyle,
  } = useEditorStylePreferences(currentUser?.id);
  const viewportMode = useEditorViewportMode();
  const isResponsiveCanvas = viewportMode !== EDITOR_VIEWPORT_MODE.DESKTOP;

  const [template, setTemplate] = useState(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageLayout, setPageLayout] = useState(null);
  const [backgroundUrl, setBackgroundUrl] = useState(null);
  const [activeTool, setActiveTool] = useState("select");
  const [bgCropFile, setBgCropFile] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [spreadPreviewOpen, setSpreadPreviewOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState("layers");
  const [activeMobilePanel, setActiveMobilePanel] = useState(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  const templateCanvasRef = useRef(null);
  const pageLayoutRef = useRef(null);
  const activeCanvasGestureRef = useRef(null);
  const activePageSessionIdRef = useRef(null);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);
  const isPhoneEditor = viewportMode === EDITOR_VIEWPORT_MODE.PHONE;
  const isTabletEditor = viewportMode === EDITOR_VIEWPORT_MODE.TABLET;
  const editorLayoutModel = useMemo(() => buildEditorLayoutModel(pageLayout, {
    onWarning: warning => (
      console.warn("[TemplateEditor] invalid layout groups; using flat render", warning)
    ),
  }), [pageLayout]);
  const {
    selectedRefs,
    setSelectedRefs,
    selectedElement,
    setSelectedElement,
    isolationPath,
    setIsolationPath,
    isolationGroupId,
    resetEditorView: resetSelectionView,
    reconcileRestoredEditorView,
    handleSelectElement,
    handleSelectGroup,
    handleCanvasSelectRef,
    handleCanvasClearSelection,
    handleActivateElement,
    enterGroup,
    exitGroup,
    navigateIsolation,
  } = useEditorSelection({
    pageLayout,
    editorLayoutModel,
    isMultiSelectMode,
    setInspectorTab,
  });

  useEffect(() => {
    setActiveMobilePanel(null);
    if (isPhoneEditor) setActiveTool("select");
    else setIsMultiSelectMode(false);
  }, [isPhoneEditor, viewportMode]);

  const currentPage = template?.pages[Math.min(currentPageIndex, (template?.pages.length ?? 1) - 1)];

  // ── 分頁草稿與復原/重做歷史（useLayoutHistory）─────────────────────────────
  const handleCanvasGestureStateChange = useCallback((kind) => {
    activeCanvasGestureRef.current = kind;
  }, []);
  const resetEditorView = useCallback(() => {
    activeCanvasGestureRef.current = null;
    resetSelectionView();
  }, [resetSelectionView]);
  const {
    draftLayouts,
    canUndo,
    canRedo,
    beginPageSession,
    dropPageHistory,
    commitPageLayout,
    commitPageLayoutForPage,
    endHistoryGroup,
    undoLayout,
    redoLayout,
    reconcileSavedPages,
  } = useLayoutHistory({
    currentPage,
    pageLayout,
    setPageLayout,
    onLayoutRestored: reconcileRestoredEditorView,
  });
  const {
    hasLayoutClipboard,
    handleDuplicateSelection,
    handleCopySelection,
    handleCutSelection,
    handlePasteSelection,
  } = useLayoutClipboard({
    pageLayout,
    currentPage,
    selectedRefs,
    setSelectedRefs,
    editorLayoutModel,
    isolationGroupId,
    commitPageLayout,
    setInspectorTab,
  });
  const {
    analyzingTargetKey,
    cancelMaterialAnalysis,
    handleAnalyzeMaterial,
    handleLinkSelectedMaterialText,
  } = useMaterialTextSuggestion({
    templateId,
    currentPage,
    pageLayoutRef,
    activePageSessionIdRef,
    commitPageLayout,
    selectedRefs,
    setSelectedRefs,
    setIsolationPath,
  });
  const {
    templateRef,
    isSaving,
    totalPhotoCount,
    hasUnsavedChanges,
    handleSaveLayout,
    handleAddPage,
    handleDeletePage,
  } = useTemplateEditorDocument({
    templateId,
    template,
    setTemplate,
    currentPage,
    currentPageIndex,
    setCurrentPageIndex,
    pageLayout,
    setPageLayout,
    setBackgroundUrl,
    setInspectorTab,
    setConfirmModal,
    activePageSessionIdRef,
    draftLayouts,
    beginPageSession,
    dropPageHistory,
    reconcileSavedPages,
    resetEditorView,
    cancelMaterialAnalysis,
  });
  const handleExitEditor = useTemplateEditorNavigationGuard({
    hasUnsavedChanges,
    navigate,
    setConfirmModal,
    setActiveMobilePanel,
  });

  useEffect(() => {
    pageLayoutRef.current = pageLayout;
  }, [pageLayout]);

  const startEditorGuide = useCallback(() => {
    startProductGuide(EDITOR_GUIDE_STEPS);
  }, []);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleOpenSpreadPreview = () => {
    if (!template?.pages.length) return;
    if (hasUnsavedChanges) {
      toast.error("有尚未儲存的變更，請先按儲存再預覽");
      return;
    }
    setSpreadPreviewOpen(true);
  };

  const handleBackgroundSelect = (event) => {
    const imageFile = event.target.files[0];
    if (!imageFile || !currentPage) return;
    if (currentPage.id == null) {
      event.target.value = "";
      toast.error("請先儲存新增頁面，再上傳背景");
      return;
    }
    setBgCropFile(imageFile);
    event.target.value = "";
  };

  const handleBgCropConfirm = async (croppedFile) => {
    setBgCropFile(null);
    if (currentPage?.id == null) {
      toast.error("請先儲存新增頁面，再上傳背景");
      return;
    }
    const backgroundPageId = currentPage.id;
    const backgroundPageKey = getEditorPageKey(currentPage);
    const expectedRevision = templateRef.current?.revision;
    if (expectedRevision == null) {
      toast.error("找不到模板版本，請重新整理後再試");
      return;
    }
    try {
      const response = await uploadBackground(
        templateId,
        backgroundPageId,
        croppedFile,
        expectedRevision,
      );
      // 較新的請求已更新本地模板時，不讓晚到的舊回應倒退 revision 或背景。
      if (templateRef.current?.revision !== expectedRevision) return;
      const nextTemplate = {
        ...templateRef.current,
        revision: response.data.revision,
        pages: templateRef.current.pages.map(page => (
          page.id === backgroundPageId
            ? { ...page, background_filename: response.data.filename }
            : page
        )),
      };
      templateRef.current = nextTemplate;
      setTemplate(nextTemplate);
      if (String(activePageSessionIdRef.current) === String(backgroundPageKey)) {
        setBackgroundUrl(
          `/api/templates/${templateId}/pages/${backgroundPageId}/background?t=${Date.now()}`
        );
      }
      toast.success(buildTemplateSyncSuccessMessage("背景已上傳", response.data?.sync));
    } catch (error) {
      const detail = error?.response?.data?.detail;
      if (error?.response?.status === 409 && detail?.code === "template_revision_changed") {
        toast.error(detail.message || "模板已被其他操作更新，請重新整理後再試");
        return;
      }
      toast.error("背景上傳失敗");
    }
  };

  const handleStickerUpload = async (stickerFile) => {
    if (!stickerFile || !currentPage) return;
    const stickerPage = currentPage;
    const stickerPageKey = getEditorPageKey(currentPage);
    try {
      const response = await uploadSticker(templateId, stickerFile);
      const pageStillExists = templateRef.current?.pages.some(
        page => String(getEditorPageKey(page)) === String(stickerPageKey),
      );
      if (!pageStillExists) {
        toast.error("貼圖上傳完成，但原頁面已被刪除");
        return;
      }
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
      const commitResult = commitPageLayoutForPage(
        stickerPage,
        currentLayout => ({
          ...currentLayout,
          stickers: [...(currentLayout.stickers || []), newSticker],
        }),
        { activePageKey: activePageSessionIdRef.current },
      );
      if (commitResult.isActive) {
        setIsolationPath([]);
        setInspectorTab("properties");
        setSelectedElement({ type: "sticker", id: newSticker.id });
        toast.success("貼圖已上傳");
      } else {
        const pageNumber = Number(stickerPage.page_number) + 1;
        toast.success(`貼圖已加入第 ${pageNumber} 頁`);
      }
    } catch {
      toast.error("上傳失敗");
    }
  };

  // ── 元素操作 ──────────────────────────────────────────────────────────────

  const handleCreateGroup = useCallback(() => {
    if (selectedRefs.length < 2) return;
    const canGroupSelection = selectedRefs.every(ref => {
      const state = editorLayoutModel.getNodeLayerState(ref);
      return state.isVisible && !state.isLocked;
    });
    if (!canGroupSelection) {
      toast.error("隱藏或鎖定的物件不能建立群組");
      return;
    }
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
  }, [commitPageLayout, editorLayoutModel, isolationGroupId, selectedRefs, setSelectedRefs]);

  const handleUngroup = useCallback((groupId) => {
    const group = editorLayoutModel.getGroupById(groupId);
    if (!group) return;
    if (editorLayoutModel.getNodeLayerState({ type: "group", id: groupId }).isLocked) {
      toast.error("請先解除鎖定再解除群組");
      return;
    }
    try {
      commitPageLayout(currentLayout => ungroupElements(currentLayout, groupId));
      setSelectedRefs(group.children.map(child => ({ ...child })));
    } catch (error) {
      toast.error(error?.message || "無法解除群組");
    }
  }, [commitPageLayout, editorLayoutModel, setSelectedRefs]);

  const updateElement = useCallback((elementType, elementId, propertyUpdates, commitOptions) => {
    const elementRef = { type: elementType, id: elementId };
    if (editorLayoutModel.getNodeLayerState(elementRef).isLocked) return;
    const arrayKey = ELEMENT_ARRAY_KEY[elementType];
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => String(element.id) === String(elementId) ? { ...element, ...propertyUpdates } : element
      ),
    }), commitOptions);
  }, [commitPageLayout, editorLayoutModel]);

  const updatePhotoElementFromEditor = (elementId, propertyUpdates, commitOptions) => {
    if (editorLayoutModel.getNodeLayerState({ type: "photo", id: elementId }).isLocked) return;
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      photo_slots: (currentLayout.photo_slots || []).map(
        slot => slot.id === elementId
          ? applyPhotoEditorUpdates(slot, propertyUpdates, getPhotoSlotDimensionMode(currentLayout))
          : slot
      ),
    }), commitOptions);
  };

  const deleteSelectedElement = useCallback(() => {
    if (selectedRefs.length === 0) return;
    const editableRefs = selectedRefs.filter(ref => !editorLayoutModel.getNodeLayerState(ref).isLocked);
    if (editableRefs.length === 0) {
      toast.error("請先解除鎖定再刪除");
      return;
    }
    try {
      commitPageLayout(currentLayout => editableRefs.reduce((nextLayout, ref) => (
        ref.type === "group"
          ? deleteLayoutGroup(nextLayout, ref.id)
          : deleteLayoutElement(nextLayout, ref)
      ), currentLayout));
      setSelectedRefs(currentRefs => currentRefs.filter(ref => !editableRefs.some(item => sameRef(item, ref))));
    } catch (error) {
      toast.error(error?.message || "無法刪除選取物件");
    }
  }, [commitPageLayout, editorLayoutModel, selectedRefs, setSelectedRefs]);

  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    if (editorLayoutModel.getNodeLayerState(selectedElement).isLocked) {
      toast.error("請先解除鎖定再調整圖層順序");
      return;
    }
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
  }, [commitPageLayout, editorLayoutModel, isolationGroupId, selectedElement]);

  const handleRenameLayer = useCallback((ref, layerName) => {
    commitPageLayout(currentLayout => updateLayoutNodeMetadata(currentLayout, ref, {
      layer_name: String(layerName || "").trim() || undefined,
    }));
  }, [commitPageLayout]);

  const handleToggleLayerVisibility = useCallback((ref) => {
    commitPageLayout(currentLayout => {
      const data = getLayoutNodeData(currentLayout, ref);
      if (!data) return currentLayout;
      return updateLayoutNodeMetadata(currentLayout, ref, {
        visible: data.visible === false ? true : false,
      });
    });
  }, [commitPageLayout]);

  const handleToggleLayerLock = useCallback((ref) => {
    commitPageLayout(currentLayout => {
      const data = getLayoutNodeData(currentLayout, ref);
      if (!data) return currentLayout;
      return updateLayoutNodeMetadata(currentLayout, ref, {
        locked: data.locked === true ? false : true,
      });
    });
  }, [commitPageLayout]);

  const handleReorderLayer = useCallback((activeRef, overRef) => {
    try {
      commitPageLayout(currentLayout => {
        if (getNodeLayerState(currentLayout, activeRef).isLocked) return currentLayout;
        const activeParentId = getNodeParent(currentLayout, activeRef)?.id ?? null;
        const overParentId = getNodeParent(currentLayout, overRef)?.id ?? null;
        if (String(activeParentId ?? "") !== String(overParentId ?? "")) return currentLayout;
        const scope = getScopeNodes(currentLayout, activeParentId);
        const targetIndex = scope.findIndex(ref => sameRef(ref, overRef));
        return targetIndex < 0
          ? currentLayout
          : reorderNode(currentLayout, activeRef, {
            parentGroupId: activeParentId,
            toIndex: targetIndex,
          });
      });
    } catch (error) {
      toast.error(error?.message || "無法調整圖層順序");
    }
  }, [commitPageLayout]);

  const handleAlignSelection = useCallback((alignment) => {
    commitPageLayout(currentLayout => alignLayoutNodes(currentLayout, selectedRefs, alignment));
  }, [commitPageLayout, selectedRefs]);

  const handleDistributeSelection = useCallback((axis) => {
    commitPageLayout(currentLayout => distributeLayoutNodes(currentLayout, selectedRefs, axis));
  }, [commitPageLayout, selectedRefs]);

  const handleMatchSelectionSize = useCallback(() => {
    if (!canMatchSelectionSize(pageLayout, selectedRefs)) return;
    commitPageLayout(currentLayout => {
      const reference = getLayoutNodeData(currentLayout, selectedRefs[0]);
      if (!reference) return currentLayout;
      if (selectedRefs[0].type === "photo") {
        const dimensionMode = getPhotoSlotDimensionMode(currentLayout);
        const referenceContent = getPhotoContentRect(reference, { dimensionMode });
        return {
          ...currentLayout,
          photo_slots: (currentLayout.photo_slots || []).map(slot => (
            selectedRefs.slice(1).some(ref => ref.type === "photo" && String(ref.id) === String(slot.id))
              ? applyPhotoEditorUpdates(slot, {
                width: referenceContent.width,
                height: referenceContent.height,
              }, dimensionMode)
              : slot
          )),
        };
      }
      const collectionKey = ELEMENT_ARRAY_KEY[selectedRefs[0].type];
      const targetIds = new Set(selectedRefs.slice(1).map(ref => String(ref.id)));
      return {
        ...currentLayout,
        [collectionKey]: (currentLayout[collectionKey] || []).map(item => (
          targetIds.has(String(item.id))
            ? { ...item, width: reference.width, height: reference.height }
            : item
        )),
      };
    });
  }, [commitPageLayout, pageLayout, selectedRefs]);

  const handleBatchPropertyChange = useCallback((updates) => {
    if (!selectedRefs.length) return;
    const selectedType = selectedRefs[0].type;
    if (!selectedRefs.every(ref => ref.type === selectedType) || selectedType === "group") return;
    const historyGroup = `batch-property:${selectedType}:${Object.keys(updates).sort().join("+")}`;
    commitPageLayout(currentLayout => {
      const editableIds = new Set(selectedRefs.flatMap(ref => {
        const state = getNodeLayerState(currentLayout, ref);
        return state.isVisible && !state.isLocked ? [String(ref.id)] : [];
      }));
      if (editableIds.size === 0) return currentLayout;
      const collectionKey = ELEMENT_ARRAY_KEY[selectedType];
      if (selectedType === "photo") {
        const dimensionMode = getPhotoSlotDimensionMode(currentLayout);
        return {
          ...currentLayout,
          [collectionKey]: (currentLayout[collectionKey] || []).map(item => (
            editableIds.has(String(item.id))
              ? applyPhotoEditorUpdates(item, updates, dimensionMode)
              : item
          )),
        };
      }
      return {
        ...currentLayout,
        [collectionKey]: (currentLayout[collectionKey] || []).map(item => (
          editableIds.has(String(item.id)) ? { ...item, ...updates } : item
        )),
      };
    }, { historyGroup });
    rememberStyleUpdates(selectedType, updates);
  }, [commitPageLayout, rememberStyleUpdates, selectedRefs]);

  const handleToggleSelectedVisibility = useCallback(() => {
    const shouldHide = selectedRefs.every(ref => editorLayoutModel.getNodeLayerState(ref).isVisible);
    commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => (
      updateLayoutNodeMetadata(nextLayout, ref, { visible: !shouldHide })
    ), currentLayout));
  }, [commitPageLayout, editorLayoutModel, selectedRefs]);

  const handleToggleSelectedLock = useCallback(() => {
    const shouldLock = selectedRefs.every(ref => editorLayoutModel.getNodeLayerState(ref).isLocked);
    commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => (
      updateLayoutNodeMetadata(nextLayout, ref, { locked: !shouldLock })
    ), currentLayout));
  }, [commitPageLayout, editorLayoutModel, selectedRefs]);

  useEditorShortcuts({
    activeCanvasGestureRef,
    isolationGroupId,
    selectedElement,
    selectedRefs,
    setSelectedRefs,
    setInspectorTab,
    commitPageLayout,
    endHistoryGroup,
    undoLayout,
    redoLayout,
    enterGroup,
    exitGroup,
    handleCreateGroup,
    handleUngroup,
    handleCopySelection,
    handleCutSelection,
    handlePasteSelection,
    handleDuplicateSelection,
    deleteSelectedElement,
  });

  const addElementAtRealPoint = useCallback((tool, point, { centered = false } = {}) => {
    const sourceLayout = pageLayoutRef.current;
    if (!sourceLayout || !point) return null;

    if (tool === "addPhotoPortrait" || tool === "addPhotoLandscape") {
      const contentSize = tool === "addPhotoPortrait"
        ? { width: 240, height: 320 }
        : { width: 320, height: 240 };
      const newSlotStyle = {
        id: generateElementId(),
        rotation: 0,
        border: true,
        border_width: 8,
        z_index: getNextZIndex(sourceLayout),
      };
      const newSlot = buildPhotoSlotFromContentRect(
        newSlotStyle,
        clampPhotoContentRect({
          x: centered ? point.x - contentSize.width / 2 : point.x,
          y: centered ? point.y - contentSize.height / 2 : point.y,
          width: contentSize.width,
          height: contentSize.height,
        }),
        { dimensionMode: photoSlotDimensionMode },
      );
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        photo_slots: [
          ...(currentLayout.photo_slots || []),
          { ...newSlot, z_index: getNextZIndex(currentLayout) },
        ],
      }));
      setIsolationPath([]);
      setInspectorTab("properties");
      setSelectedElement({ type: "photo", id: newSlot.id });
      return { type: "photo", id: newSlot.id };
    }

    if (tool === "addText") {
      const width = 240;
      const height = 80;
      const requestedX = centered ? point.x - width / 2 : point.x;
      const requestedY = centered ? point.y - height / 2 : point.y;
      const newTextLabel = {
        id: generateElementId(),
        x: centered ? Math.max(0, Math.min(CANVAS_REAL_WIDTH - width, requestedX)) : requestedX,
        y: centered ? Math.max(0, Math.min(CANVAS_REAL_HEIGHT - height, requestedY)) : requestedY,
        width,
        height,
        rotation: 0,
        text: "{name}的文字標題",
        text_role: TEXT_LABEL_ROLES.FILLABLE,
        font_size: 28,
        font_color: "#3B6B8C",
        font_family: "msjh",
        text_align: "center",
        line_height: 1.4,
        z_index: getNextZIndex(sourceLayout),
      };
      commitPageLayout(currentLayout => ({
        ...currentLayout,
        text_labels: [
          ...(currentLayout.text_labels || []),
          { ...newTextLabel, z_index: getNextZIndex(currentLayout) },
        ],
      }));
      setIsolationPath([]);
      setInspectorTab("properties");
      setSelectedElement({ type: "text", id: newTextLabel.id });
      return { type: "text", id: newTextLabel.id };
    }

    return null;
  }, [commitPageLayout, photoSlotDimensionMode, setIsolationPath, setSelectedElement]);

  const handleMobileAddTool = useCallback((tool) => {
    if (!["addPhotoPortrait", "addPhotoLandscape", "addText"].includes(tool)) return;
    const pageCenter = templateCanvasRef.current?.getViewportCenterPagePoint();
    if (!pageCenter) return;
    const clampedPageCenter = {
      x: Math.max(0, Math.min(CANVAS_DISPLAY_WIDTH, pageCenter.x)),
      y: Math.max(0, Math.min(CANVAS_DISPLAY_HEIGHT, pageCenter.y)),
    };
    addElementAtRealPoint(tool, {
      x: toRealCoord(clampedPageCenter.x),
      y: toRealCoord(clampedPageCenter.y),
    }, { centered: true });
    setActiveTool("select");
    setIsMultiSelectMode(false);
    setActiveMobilePanel(null);
  }, [addElementAtRealPoint]);

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  if (!template) return <div className="text-gray-400">載入中...</div>;
  const confirmDialog = (
    <ConfirmModal
      isOpen={!!confirmModal}
      message={confirmModal?.message}
      onConfirm={async () => {
        const confirmedModal = confirmModal;
        await confirmedModal?.onConfirm();
        setConfirmModal(current => (current === confirmedModal ? null : current));
      }}
      onCancel={() => setConfirmModal(null)}
      confirmLabel={confirmModal?.confirmLabel}
      confirmVariant={confirmModal?.confirmVariant}
    />
  );

  if (template.pages.length === 0) {
    return (
      <TemplateEditorEmptyState
        template={template}
        isResponsiveCanvas={isResponsiveCanvas}
        isPhoneEditor={isPhoneEditor}
        confirmDialog={confirmDialog}
        canUndo={canUndo}
        canRedo={canRedo}
        isSaving={isSaving}
        hasUnsavedChanges={hasUnsavedChanges}
        onExit={handleExitEditor}
        onUndo={undoLayout}
        onRedo={redoLayout}
        onSave={handleSaveLayout}
        onAddPage={handleAddPage}
      />
    );
  }

  const rootRenderNodes = editorLayoutModel.rootRenderNodes;
  const isolationGroup = isolationGroupId == null
    ? null
    : editorLayoutModel.getGroupById(isolationGroupId);
  const selectedGroup = selectedElement?.type === "group"
    ? editorLayoutModel.getGroupById(selectedElement.id)
    : isolationGroup;
  const selectedItem = selectedElement?.type === "group"
    ? selectedGroup
    : selectedElement ? editorLayoutModel.getNodeData(selectedElement) : null;
  const selectedPanelItem = selectedElement?.type === "group"
    ? editorLayoutModel.getGroupBounds(selectedElement.id)
    : selectedElement?.type === "photo"
      ? getPhotoEditorElementData(selectedItem, photoSlotDimensionMode)
      : selectedItem;
  const selectedItems = selectedRefs
    .map(ref => ({ ...ref, data: editorLayoutModel.getNodeData(ref) }))
    .filter(item => item.data);
  const activeScopeRefs = editorLayoutModel.getScopeNodes(isolationGroupId);
  const activeScopeRenderNodes = activeScopeRefs
    .map(ref => editorLayoutModel.getRenderNode(ref))
    .filter(Boolean);
  const isolationTrail = isolationPath.map((groupId, index) => ({
    id: groupId,
    label: editorLayoutModel.getGroupById(groupId)?.layer_name || `群組 ${index + 1}`,
    data: editorLayoutModel.getGroupById(groupId),
  }));
  const selectedMaterialLink = selectedElement
    ? editorLayoutModel.getMaterialTextLinkForNode(selectedElement)
    : null;
  const selectedAnalysisStickerId = selectedElement?.type === "sticker"
    ? selectedElement.id
    : selectedMaterialLink?.material_id ?? null;
  const layoutValidation = editorLayoutModel.validation;
  const hasRepairableMaterialLinks = layoutValidation.topologyValid && !layoutValidation.linkValid;
  const selectedLayerStates = selectedRefs.map(ref => editorLayoutModel.getNodeLayerState(ref));
  const isSelectionVisible = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isVisible);
  const isSelectionLocked = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isLocked);
  const canEditSelection = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isVisible && !state.isLocked);
  const selectedSingleLayerState = selectedElement
    ? editorLayoutModel.getNodeLayerState(selectedElement)
    : null;
  const selectedFavoriteType = selectedRefs.length > 0
    && selectedRefs.every(ref => ref.type === selectedRefs[0].type)
    && ["text", "photo"].includes(selectedRefs[0].type)
    ? selectedRefs[0].type
    : null;
  const applicableFavoriteStyles = selectedFavoriteType
    ? favoriteStyles.filter(item => item.type === selectedFavoriteType)
    : [];
  const handleSelectedPropertyChange = (updates, options = {}) => {
    if (!selectedElement || selectedElement.type === "group" || selectedSingleLayerState?.isLocked) return;
    const historyKey = options.historyGroup
      ?? `property:${refKey(selectedElement)}:${Object.keys(updates).sort().join("+")}`;
    const commitOptions = options.discrete ? undefined : { historyGroup: historyKey };
    if (selectedElement.type === "photo") {
      updatePhotoElementFromEditor(selectedElement.id, updates, commitOptions);
    } else {
      updateElement(selectedElement.type, selectedElement.id, updates, commitOptions);
    }
    rememberStyleUpdates(selectedElement.type, updates);
    if (options.endHistoryGroup) endHistoryGroup(historyKey);
  };

  return (
    <div className={`mx-auto flex w-full max-w-[1042px] flex-col lg:-mx-4 lg:w-auto xl:mx-auto xl:w-full ${
      isPhoneEditor
        ? "fixed inset-0 z-30 h-dvh max-w-none overflow-hidden bg-slate-50 pb-[calc(4rem+env(safe-area-inset-bottom))]"
        : isTabletEditor ? "h-[calc(100dvh-5.25rem)] min-h-0 overflow-hidden" : ""
    }`}>
      {confirmDialog}
      {spreadPreviewOpen && (
        <SpreadPreviewModal
          templateId={templateId}
          pageCount={template.pages.length}
          initialPageIndex={currentPageIndex}
          onClose={() => setSpreadPreviewOpen(false)}
        />
      )}
      <TemplateEditorHeader
        isResponsiveCanvas={isResponsiveCanvas}
        isPhoneEditor={isPhoneEditor}
        templateName={template.name}
        pageIndex={currentPageIndex}
        pageCount={template.pages.length}
        totalPhotoCount={totalPhotoCount}
        canUndo={canUndo}
        canRedo={canRedo}
        isSaving={isSaving}
        hasUnsavedChanges={hasUnsavedChanges}
        hasRepairableMaterialLinks={hasRepairableMaterialLinks}
        onExit={handleExitEditor}
        onUndo={undoLayout}
        onRedo={redoLayout}
        onSave={handleSaveLayout}
        onStartGuide={startEditorGuide}
        onOpenSpreadPreview={handleOpenSpreadPreview}
      />

      <TemplateUsageBanner template={template} />

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

      {/* 三欄主體；手機只留下可用空間內的畫布。 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-nowrap gap-2 overflow-hidden xl:gap-4">
        {/* 左側工具欄；平板按鈕維持 44px，低高度時整欄自行捲動。 */}
        {!isPhoneEditor && (
        <div className="hidden w-36 flex-shrink-0 flex-col overflow-hidden md:flex lg:w-40" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-1">
            <EditorToolsPanel
              activeTool={activeTool}
              onToolChange={setActiveTool}
              canUploadBackground={currentPage?.id != null}
              onBackgroundBlocked={() => toast.error("請先儲存新增頁面，再上傳背景")}
              onBackgroundSelect={handleBackgroundSelect}
              onStickerSelect={handleStickerUpload}
            />
            <EditorPagesPanel
              pages={template.pages}
              currentPageIndex={currentPageIndex}
              isDisabled={isSaving}
              onSelectPage={(pageTabIndex) => {
                setInspectorTab("layers");
                setCurrentPageIndex(pageTabIndex);
              }}
              onAddPage={handleAddPage}
              onDeletePage={handleDeletePage}
              className="min-h-[14rem]"
            />
          </div>
        </div>
        )}

        {/* 中央畫布區 */}
        <div className={isResponsiveCanvas
          ? "flex min-h-0 min-w-0 flex-1 flex-col max-md:w-full"
          : "flex flex-shrink-0 flex-col"}
        >
          <TemplateCanvas
            ref={templateCanvasRef}
            layoutModel={editorLayoutModel}
            pageSessionKey={getEditorPageKey(currentPage)}
            templateId={templateId}
            pageIndex={currentPageIndex}
            backgroundUrl={backgroundUrl}
            viewportMode={viewportMode}
            activeTool={activeTool}
            isMultiSelectMode={isMultiSelectMode}
            selectedRefs={selectedRefs}
            isolationGroupId={isolationGroupId}
            selectionOverlay={!isPhoneEditor ? (
              <SelectionQuickActions
                selectedCount={selectedRefs.length}
                isVisible={isSelectionVisible}
                isLocked={isSelectionLocked}
                canEdit={canEditSelection}
                canGroup={selectedRefs.length >= 2}
                canUngroup={selectedRefs.length === 1 && selectedElement?.type === "group"}
                canDuplicate={selectedRefs.length > 0}
                onToggleVisibility={handleToggleSelectedVisibility}
                onToggleLock={handleToggleSelectedLock}
                onDuplicate={handleDuplicateSelection}
                onGroup={handleCreateGroup}
                onUngroup={() => handleUngroup(selectedElement?.id)}
                onDelete={deleteSelectedElement}
                touchFriendly={isResponsiveCanvas}
              />
            ) : null}
            onSelectRef={handleCanvasSelectRef}
            onReplaceSelection={setSelectedRefs}
            onClearSelection={handleCanvasClearSelection}
            onActivateRef={handleActivateElement}
            onEnterGroup={enterGroup}
            onExitGroup={exitGroup}
            onRequestInspectorTab={setInspectorTab}
            onAddAtRealPoint={addElementAtRealPoint}
            onUpdateElement={updateElement}
            onCommitLayout={commitPageLayout}
            onGestureStateChange={handleCanvasGestureStateChange}
          />
        </div>

        {/* 右側：固定屬性／圖層檢查器 */}
        <EditorInspector
          presentation={isPhoneEditor
            ? "bottom-sheet"
            : isTabletEditor ? "side-drawer" : "static"}
          isOpen={isPhoneEditor
            ? activeMobilePanel === MOBILE_PANEL.LAYERS
              || activeMobilePanel === MOBILE_PANEL.PROPERTIES
            : undefined}
          onOpenChange={isPhoneEditor
            ? (isOpen) => {
                if (!isOpen) setActiveMobilePanel(null);
              }
            : undefined}
          showTrigger={!isPhoneEditor}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          selectedRefs={selectedRefs}
          currentPageIndex={currentPageIndex}
          maxHeight={CANVAS_DISPLAY_HEIGHT}
          onDeleteSelection={deleteSelectedElement}
          propertyPanel={selectedRefs.length > 1 ? (
            <GroupSelectionPanel
              items={selectedItems}
              onGroup={handleCreateGroup}
              onLinkMaterialText={handleLinkSelectedMaterialText}
              materialActionsDisabled={hasRepairableMaterialLinks}
              onAlign={handleAlignSelection}
              onDistribute={handleDistributeSelection}
              onMatchSize={handleMatchSelectionSize}
              canMatchSize={canMatchSelectionSize(pageLayout, selectedRefs)}
              onBatchPropertyChange={handleBatchPropertyChange}
              onPropertyCommit={endHistoryGroup}
              onSaveFavoriteStyle={() => {
                if (selectedFavoriteType && selectedItems[0]?.data) {
                  saveFavoriteStyle(selectedFavoriteType, selectedItems[0].data);
                }
              }}
              favoriteStyles={applicableFavoriteStyles}
              onApplyFavoriteStyle={favorite => handleBatchPropertyChange(favorite.style)}
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
              isLocked={selectedSingleLayerState?.isLocked === true}
              onPropertyCommit={endHistoryGroup}
              recentColors={recentColors}
              recentFonts={recentFonts}
              favoriteStyles={applicableFavoriteStyles}
              onSaveFavoriteStyle={() => saveFavoriteStyle(selectedElement.type, selectedItem)}
              onApplyFavoriteStyle={favorite => handleSelectedPropertyChange(favorite.style, { discrete: true })}
              onRemoveFavoriteStyle={removeFavoriteStyle}
              isAnalyzingMaterial={selectedAnalysisStickerId != null
                && analyzingTargetKey === `sticker:${selectedAnalysisStickerId}`}
              onPropertyChange={handleSelectedPropertyChange}
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
            <div className="rounded-lg border border-dashed border-gray-200 bg-white px-5 py-8 text-center">
              <SlidersHorizontal className="mx-auto h-6 w-6 text-gray-300" />
              <h2 className="mt-3 text-sm font-semibold text-gray-700">尚未選取物件</h2>
              <p className="mt-1 text-xs leading-5 text-gray-400">
                從畫布點選物件以編輯屬性，或前往圖層清單精準選取。
              </p>
              <button
                type="button"
                onClick={() => setInspectorTab("layers")}
                className="mt-4 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
              >
                查看圖層
              </button>
            </div>
          )}
          layerPanel={(
            <LayerListPanel
              editorLayoutModel={editorLayoutModel}
              rootRenderNodes={rootRenderNodes}
              scopeRenderNodes={activeScopeRenderNodes}
              isolationTrail={isolationTrail}
              selectedRefs={selectedRefs}
              currentPageIndex={currentPageIndex}
              photoSlotDimensionMode={photoSlotDimensionMode}
              backgroundUrl={backgroundUrl}
              onSelectElement={(type, id, options = {}) => handleSelectElement(
                { type, id },
                { ...options, additive: isMultiSelectMode || options.additive },
              )}
              onSelectGroup={(groupId, options = {}) => handleSelectGroup(
                groupId,
                { ...options, additive: isMultiSelectMode || options.additive },
              )}
              onEnterGroup={enterGroup}
              onExitGroup={exitGroup}
              onNavigateIsolation={navigateIsolation}
              onRenameLayer={handleRenameLayer}
              onToggleVisibility={handleToggleLayerVisibility}
              onToggleLock={handleToggleLayerLock}
              onReorderLayer={handleReorderLayer}
            />
          )}
        />
      </div>

      {isPhoneEditor && (
        <div className="flex h-12 flex-shrink-0 items-center border-y border-gray-200 bg-white/95">
          {selectedRefs.length === 0 && !hasLayoutClipboard ? (
            <p className="w-full px-3 text-center text-xs text-gray-400">點選物件後，可在這裡快速編輯</p>
          ) : (
            <SelectionQuickActions
              presentation="context-rail"
              selectedCount={selectedRefs.length}
              isVisible={isSelectionVisible}
              isLocked={isSelectionLocked}
              canEdit={canEditSelection}
              canGroup={selectedRefs.length >= 2}
              canUngroup={selectedRefs.length === 1 && selectedElement?.type === "group"}
              canDuplicate={selectedRefs.length > 0}
              canCopy={selectedRefs.length > 0}
              canCut={selectedRefs.length > 0 && canEditSelection}
              canPaste={hasLayoutClipboard}
              onToggleVisibility={handleToggleSelectedVisibility}
              onToggleLock={handleToggleSelectedLock}
              onDuplicate={handleDuplicateSelection}
              onCopy={handleCopySelection}
              onCut={handleCutSelection}
              onPaste={handlePasteSelection}
              onGroup={handleCreateGroup}
              onUngroup={() => handleUngroup(selectedElement?.id)}
              onDelete={deleteSelectedElement}
              className="h-full border-y-0"
            />
          )}
        </div>
      )}

      {isPhoneEditor && (
        <EditorCommandDock
          activePanel={activeMobilePanel}
          isMultiSelectActive={isMultiSelectMode}
          selectedCount={selectedRefs.length}
          panelIds={{
            add: "editor-add-sheet",
            pages: "editor-pages-sheet",
            layers: "editor-inspector",
            properties: "editor-inspector",
          }}
          onToggleMultiSelect={() => {
            setActiveTool("select");
            setActiveMobilePanel(null);
            setIsMultiSelectMode(current => !current);
          }}
          onPanelChange={(panel) => {
            if (panel === MOBILE_PANEL.LAYERS) setInspectorTab("layers");
            if (panel === MOBILE_PANEL.PROPERTIES) setInspectorTab("properties");
            setActiveMobilePanel(panel);
          }}
        />
      )}

      {isPhoneEditor && (
        <EditorSheet
          id="editor-add-sheet"
          isOpen={activeMobilePanel === MOBILE_PANEL.ADD}
          onClose={() => setActiveMobilePanel(null)}
          title="新增與素材"
          description="選擇後會放在目前畫布中央"
          bodyClassName="p-4"
        >
          <EditorToolsPanel
            activeTool={activeTool}
            showSelectTool={false}
            onToolChange={handleMobileAddTool}
            canUploadBackground={currentPage?.id != null}
            onBackgroundBlocked={() => toast.error("請先儲存新增頁面，再上傳背景")}
            onBackgroundSelect={(event) => {
              handleBackgroundSelect(event);
              setActiveMobilePanel(null);
            }}
            onStickerSelect={(file) => {
              setActiveMobilePanel(null);
              handleStickerUpload(file);
            }}
          />
          <section className="mt-5 border-t border-gray-200 pt-4" aria-label="其他工具">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">其他</p>
            <div className="grid gap-2">
              <button type="button" onClick={() => { setActiveMobilePanel(null); startEditorGuide(); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <CircleHelp className="h-4 w-4" />製作教學
              </button>
              <button type="button" onClick={() => { setActiveMobilePanel(null); handleOpenSpreadPreview(); }} disabled={isSaving || template.pages.length === 0} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                <BookOpen className="h-4 w-4" />雙頁預覽
              </button>
            </div>
          </section>
        </EditorSheet>
      )}

      {isPhoneEditor && (
        <EditorSheet
          id="editor-pages-sheet"
          isOpen={activeMobilePanel === MOBILE_PANEL.PAGES}
          onClose={() => setActiveMobilePanel(null)}
          title={`頁面 · ${currentPageIndex + 1}/${template.pages.length}`}
          bodyClassName="flex min-h-0 flex-col p-4"
        >
          <EditorPagesPanel
            pages={template.pages}
            currentPageIndex={currentPageIndex}
            isDisabled={isSaving}
            onSelectPage={(pageIndex) => {
              setInspectorTab("layers");
              setCurrentPageIndex(pageIndex);
            }}
            onPageSelected={() => setActiveMobilePanel(null)}
            onAddPage={handleAddPage}
            onDeletePage={() => {
              setActiveMobilePanel(null);
              handleDeletePage();
            }}
            className="min-h-0 flex-1"
          />
        </EditorSheet>
      )}
    </div>
  );
}
