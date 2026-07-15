// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性
// 分工：per-page 草稿/歷史在 hooks/useLayoutHistory、Konva 節點渲染在
// components/canvas/pageElementNodes、雙頁預覽與圖層清單為獨立 component

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { BookOpen, Camera, ChevronLeft, CircleHelp, Redo2, SlidersHorizontal, Undo2 } from "lucide-react";

import {
  fetchTemplate,
  saveTemplatePages,
  uploadBackground,
  uploadSticker,
  suggestMaterialTextBox,
} from "../api/templateApi";
import ImageCropModal from "../components/ImageCropModal";
import StickerNode from "../components/canvas/StickerNode";
import {
  getCanvasElementRefFromTarget,
  OBJECT_HOVER_OUTLINE_NAME,
  OBJECT_HOVER_STROKE,
  OBJECT_HOVER_STROKE_WIDTH,
} from "../components/canvas/canvasHover.js";
import {
  applyPhotoEditorUpdates,
  clampPhotoContentRect,
  makeGroupProps,
  makePhotoControlProps,
  renderFooterNode,
  renderPhotoSlotNode,
  renderTextLabelNode,
} from "../components/canvas/pageElementNodes";
import LayerListPanel from "../components/LayerListPanel";
import PropertyPanel from "../components/PropertyPanel";
import GroupSelectionPanel from "../components/GroupSelectionPanel";
import EditorInspector from "../components/EditorInspector";
import EditorCommandDock from "../components/EditorCommandDock";
import EditorPagesPanel from "../components/EditorPagesPanel";
import EditorSheet from "../components/EditorSheet";
import EditorToolsPanel from "../components/EditorToolsPanel";
import SelectionQuickActions from "../components/SelectionQuickActions";
import ConfirmModal from "../components/ConfirmModal";
import SpreadPreviewModal from "../components/SpreadPreviewModal";
import { Button } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import useCanvasCamera from "../hooks/useCanvasCamera";
import useEditorStylePreferences from "../hooks/useEditorStylePreferences";
import useEditorViewportMode, {
  EDITOR_VIEWPORT_MODE,
} from "../hooks/useEditorViewportMode";
import useLayoutHistory, { cloneLayout, getEditorPageKey } from "../hooks/useLayoutHistory";
import { canvasViewportPointToPage } from "../utils/canvasCamera.js";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  CANVAS_REAL_HEIGHT,
  CANVAS_REAL_WIDTH,
  ELEMENT_ARRAY_KEY,
  getInitialStickerSize,
  getNextZIndex,
  toDisplayCoord,
  toRealCoord,
} from "../utils/renderLayoutModel";
import {
  buildPhotoSlotFromContentRect,
  getPhotoContentRect,
  getPhotoFrameInsets,
  getPhotoSlotDimensionMode,
  PHOTO_SLOT_CONTENT_BOX_MODE,
  PHOTO_SLOT_DIMENSION_MODE_KEY,
  snapPhotoSlotStandardRatio,
} from "../utils/photoFrameGeometry.js";
import { DESIGN_TOKENS } from "../constants/designTokens.js";
import { TEXT_LABEL_ROLES } from "../utils/textLabelRoles";
import { startProductGuide } from "../utils/productGuide";
import { buildEditorLayoutModel } from "../utils/editorLayoutModel.js";
import {
  deleteLayoutElement,
  deleteLayoutGroup,
  flattenRenderNodes,
  getGroupAncestorPath,
  getGroupById,
  getMaterialTextLinkForNode,
  getNodeParent,
  getScopeNodes,
  groupElements,
  insertNodeInScope,
  linkMaterialText,
  projectNormalizedBoxToSticker,
  removeInvalidMaterialTextLinks,
  reorderNode,
  transformGroup,
  ungroupElements,
  validateLayoutGroups,
} from "../utils/layoutGroups";
import {
  createLayoutClipboard,
  duplicateLayoutNodes,
  pasteLayoutNodes,
} from "../utils/layoutDuplication.js";
import {
  getLayoutNodeData,
  getNodeLayerState,
  getVisibleLayoutElements,
  updateLayoutNodeMetadata,
} from "../utils/layoutLayerState.js";
import {
  alignLayoutNodes,
  canMatchSelectionSize,
  distributeLayoutNodes,
  moveLayoutNode,
} from "../utils/layoutSelectionOperations.js";
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
    title: "屬性與圖層",
    description: "用屬性調整選取物件；切到圖層可精準選取群組、文字、照片格與貼圖。純排版文字可設為固定文字，避免老師端修改。",
    side: "left",
    align: "center",
  },
];

function generateElementId() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function createEditorPageKey() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `draft-page:${suffix}`;
}

function normalizeTemplateForEditor(templateData, previousPages = []) {
  const previousById = new Map(
    previousPages
      .filter(page => page.id != null)
      .map(page => [String(page.id), page]),
  );
  return {
    ...templateData,
    pages: (templateData.pages || []).map(page => {
      const previousPage = page.id == null ? null : previousById.get(String(page.id));
      const editorKey = page.client_id
        ?? previousPage?.editorKey
        ?? (page.id == null ? createEditorPageKey() : `page:${page.id}`);
      const persistedPage = { ...page };
      delete persistedPage.client_id;
      return { ...persistedPage, editorKey };
    }),
  };
}

function buildTemplateSyncConfirmationMessage(detail) {
  const projectCount = detail.project_count ?? 0;
  const studentCount = detail.student_count ?? 0;
  const completedProjectCount = detail.completed_project_count ?? 0;
  const reopenProjectCount = detail.reopen_project_count ?? 0;
  const deletedPageCount = detail.deleted_page_count ?? 0;
  const messages = [
    `這次儲存會調整模板頁面結構，並同步 ${projectCount} 個既有專案（${studentCount} 位學生）。`,
  ];
  if (deletedPageCount > 0) {
    messages.push(`其中會刪除 ${deletedPageCount} 頁，對應內容將不再顯示；系統會保留同步前備份。`);
  }
  const affectedPhotoCount = detail.affected_photo_count ?? 0;
  const affectedLabelCount = (detail.affected_project_label_count ?? 0)
    + (detail.affected_student_label_count ?? 0);
  const affectedSkipCount = detail.affected_skip_count ?? 0;
  if (affectedPhotoCount || affectedLabelCount || affectedSkipCount) {
    messages.push(
      `受影響內容：${affectedPhotoCount} 張照片、${affectedLabelCount} 筆文字、${affectedSkipCount} 個略過設定。`,
    );
  }
  if ((detail.legacy_orphan_entry_count ?? 0) > 0) {
    messages.push(`另有 ${detail.legacy_orphan_entry_count} 筆舊版頁面資料會保留在同步備份中。`);
  }
  if (completedProjectCount > 0) {
    messages.push(`包含 ${completedProjectCount} 個已完成專案，既有輸出將需要重新產生。`);
  }
  if (reopenProjectCount > 0) {
    messages.push(`因新增照片格，${reopenProjectCount} 個已完成專案會退回可編輯狀態。`);
  }
  messages.push("確定要同步並儲存嗎？");
  return messages.join("");
}

function buildTemplateSyncSuccessMessage(actionLabel, syncResult) {
  if (!syncResult || (syncResult.project_count ?? 0) === 0) return actionLabel;
  return `${actionLabel}，已同步 ${syncResult.project_count} 個專案、${syncResult.student_count ?? 0} 位學生`;
}

function TemplateUsageBanner({ template }) {
  const projectCount = template.project_count ?? 0;
  if (projectCount === 0) return null;
  const studentCount = template.student_count ?? 0;
  const completedProjectCount = template.completed_project_count ?? 0;
  const fullMessage = `此模板已套用於 ${projectCount} 個專案、${studentCount} 位學生；按下儲存後，變更會同步套用。${
    completedProjectCount > 0
      ? ` 其中 ${completedProjectCount} 個專案已完成，既有輸出會標記為需重新產生。`
      : ""
  }`;
  return (
    <div
      role="status"
      className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 max-md:mb-0 max-md:rounded-none max-md:border-x-0 max-md:py-1.5 max-md:text-xs"
      data-guide="template-project-impact"
      title={fullMessage}
    >
      <span className="max-md:block max-md:truncate">{fullMessage}</span>
    </div>
  );
}

function createDraftPage(pageNumber) {
  return {
    id: null,
    editorKey: createEditorPageKey(),
    page_number: pageNumber,
    background_filename: null,
    layout: {
      canvas_width: DESIGN_TOKENS.canvas.width,
      canvas_height: DESIGN_TOKENS.canvas.height,
      [PHOTO_SLOT_DIMENSION_MODE_KEY]: PHOTO_SLOT_CONTENT_BOX_MODE,
      photo_slots: [],
      text_labels: [],
      stickers: [],
      footer: null,
      logo: null,
    },
  };
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

const DESKTOP_CANVAS_CAMERA = {
  mode: "manual",
  zoom: 1,
  viewX: 0,
  viewY: 0,
};
const CANVAS_ZOOM_STEP = 1.2;
const MOBILE_PANEL = {
  ADD: "add",
  PAGES: "pages",
  LAYERS: "layers",
  PROPERTIES: "properties",
};

function isPointInsideCanvasPage(point) {
  return point != null
    && point.x >= 0
    && point.x <= CANVAS_DISPLAY_WIDTH
    && point.y >= 0
    && point.y <= CANVAS_DISPLAY_HEIGHT;
}

function countTemplatePhotoSlots(template, draftLayouts) {
  if (!template?.pages) return 0;
  return template.pages.reduce((total, page) => {
    const layout = draftLayouts[getEditorPageKey(page)] ?? page.layout;
    return total + getVisibleLayoutElements(layout, "photo").length;
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
  const {
    viewportRef,
    viewportSize,
    camera,
    cameraRef,
    isReady: isCanvasCameraReady,
    fitToViewport,
    zoomAtPoint,
    panBy,
    applyPinch,
  } = useCanvasCamera();

  const [template, setTemplate] = useState(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageLayout, setPageLayout] = useState(null);
  const [selectedRefs, setSelectedRefs] = useState([]);
  const [hoveredRef, setHoveredRef] = useState(null);
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
  const [inspectorTab, setInspectorTab] = useState("layers");
  const [activeMobilePanel, setActiveMobilePanel] = useState(null);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [hasLayoutClipboard, setHasLayoutClipboard] = useState(false);

  const stageRef = useRef(null);
  const pageCameraRef = useRef(null);
  const transformerRef = useRef(null);
  const pageLayoutRef = useRef(null);
  const editorViewRef = useRef({ isolationPath: [], selectedRefs: [] });
  const activeCanvasGestureRef = useRef(null);
  const analysisRequestRef = useRef(null);
  const activePageSessionIdRef = useRef(null);
  const suppressNextStageClickRef = useRef(false);
  const suppressStageClickSequenceRef = useRef(0);
  const layoutClipboardRef = useRef(null);
  const clipboardPasteCountRef = useRef(0);
  const multiTransformSnapshotRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const templateRef = useRef(null);
  const persistedPageIdsRef = useRef([]);
  const pageStructureDirtyRef = useRef(false);
  const cameraGestureRef = useRef(null);
  const touchCandidateTargetRef = useRef(null);
  const isSpacePanPressedRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const historyGuardRef = useRef({ installed: false, returning: false, allowNextPop: false });
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);
  const isolationGroupId = isolationPath.length ? isolationPath[isolationPath.length - 1] : null;
  const selectedElement = selectedRefs.length === 1 ? selectedRefs[0] : null;
  const activeCanvasCamera = isResponsiveCanvas && isCanvasCameraReady
    ? camera
    : DESKTOP_CANVAS_CAMERA;
  const canvasStageSize = isResponsiveCanvas
    ? {
        width: Math.max(1, viewportSize.width),
        height: Math.max(1, viewportSize.height),
      }
    : { width: CANVAS_DISPLAY_WIDTH, height: CANVAS_DISPLAY_HEIGHT };
  const isPhoneEditor = viewportMode === EDITOR_VIEWPORT_MODE.PHONE;
  const isTabletEditor = viewportMode === EDITOR_VIEWPORT_MODE.TABLET;
  const editorLayoutModel = useMemo(() => buildEditorLayoutModel(pageLayout, {
    onWarning: warning => (
      console.warn("[TemplateEditor] invalid layout groups; using flat render", warning)
    ),
  }), [pageLayout]);

  useEffect(() => {
    setActiveMobilePanel(null);
    if (isPhoneEditor) setActiveTool("select");
    else setIsMultiSelectMode(false);
  }, [isPhoneEditor, viewportMode]);

  useEffect(() => {
    if (!marqueeGesture && selectedRefs.length === 0) {
      setInspectorTab("layers");
    }
  }, [marqueeGesture, selectedRefs.length]);

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
  const beginCanvasGesture = useCallback((kind) => {
    activeCanvasGestureRef.current = kind;
    setHoveredRef(null);
  }, []);
  const endCanvasGesture = useCallback(() => {
    activeCanvasGestureRef.current = null;
  }, []);
  const resetEditorView = useCallback(() => {
    activeCanvasGestureRef.current = null;
    setSelectedRefs([]);
    setInspectorTab("layers");
    setHoveredRef(null);
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
  const totalPhotoCount = useMemo(() => {
    // draftLayouts 是計數 SSOT；pageLayout 僅在目前頁草稿更新時觸發重算。
    void pageLayout;
    if (!template) return 0;
    return countTemplatePhotoSlots(template, draftLayouts.current);
  }, [pageLayout, template, draftLayouts]);
  const hasUnsavedChanges = pageStructureDirtyRef.current
    || Object.keys(draftLayouts.current).length > 0;

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const discardMessage = "尚有未儲存的模板變更。確定要放棄變更並離開嗎？";
    const historyGuard = historyGuardRef.current;
    if (!historyGuard.installed) {
      historyGuard.installed = true;
      const currentRouteState = window.history.state?.usr;
      if (!currentRouteState?.templateEditorGuard) {
        navigate(".", {
          state: { ...(currentRouteState ?? {}), templateEditorGuard: true },
        });
      }
    }
    const handleDocumentLink = (event) => {
      if (!hasUnsavedChangesRef.current
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey) return;
      const anchor = event.target.closest?.("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin
        || destination.href === window.location.href) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveMobilePanel(null);
      setConfirmModal({
        message: discardMessage,
        confirmLabel: "放棄變更並離開",
        confirmVariant: "danger",
        onConfirm: () => navigate(`${destination.pathname}${destination.search}${destination.hash}`),
      });
    };
    const handleNavigationRequest = (event) => {
      if (!hasUnsavedChangesRef.current) return;
      event.preventDefault();
      setActiveMobilePanel(null);
      setConfirmModal({
        message: discardMessage,
        confirmLabel: "放棄變更並離開",
        confirmVariant: "danger",
        onConfirm: () => event.detail?.proceed?.(),
      });
    };
    const handleHistoryBack = () => {
      if (historyGuard.returning) {
        historyGuard.returning = false;
        return;
      }
      if (historyGuard.allowNextPop) {
        historyGuard.allowNextPop = false;
        return;
      }
      const shouldLeave = !hasUnsavedChangesRef.current || window.confirm(discardMessage);
      if (shouldLeave) {
        // 第一個 back 只移到同 URL 的 guard base；再退一次才真正離開 editor。
        historyGuard.allowNextPop = true;
        window.setTimeout(() => window.history.back(), 0);
      } else {
        // 取消時回到 sentinel，整個過程 route 不曾離開 editor，保留記憶體草稿。
        historyGuard.returning = true;
        window.setTimeout(() => window.history.forward(), 0);
      }
    };
    document.addEventListener("click", handleDocumentLink, true);
    window.addEventListener("album-maker:navigation-request", handleNavigationRequest);
    window.addEventListener("popstate", handleHistoryBack);
    return () => {
      document.removeEventListener("click", handleDocumentLink, true);
      window.removeEventListener("album-maker:navigation-request", handleNavigationRequest);
      window.removeEventListener("popstate", handleHistoryBack);
    };
  }, [navigate]);

  const handleExitEditor = useCallback(() => {
    if (!hasUnsavedChanges) {
      navigate("/templates");
      return;
    }
    setActiveMobilePanel(null);
    setConfirmModal({
      message: "尚有未儲存的模板變更。確定要放棄變更並返回模板列表嗎？",
      confirmLabel: "放棄變更並離開",
      confirmVariant: "danger",
      onConfirm: () => navigate("/templates"),
    });
  }, [hasUnsavedChanges, navigate]);

  useEffect(() => {
    pageLayoutRef.current = pageLayout;
  }, [pageLayout]);

  useEffect(() => {
    templateRef.current = template;
  }, [template]);

  useEffect(() => {
    editorViewRef.current = { isolationPath, selectedRefs };
  }, [isolationPath, selectedRefs]);

  useEffect(() => {
    if (activeTool !== "select") setHoveredRef(null);
  }, [activeTool]);

  useEffect(() => () => analysisRequestRef.current?.controller?.abort(), []);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

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
      .filter(ref => {
        const state = editorLayoutModel.getNodeLayerState(ref);
        return state.isVisible && !state.isLocked;
      })
      .map(ref => {
        const nodeId = `${ref.type}-${ref.id}`;
        return stageRef.current.findOne(node => node.id() === nodeId);
      })
      .filter(Boolean);
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedRefs, editorLayoutModel, isolationGroupId]);

  useEffect(() => {
    const redrawFrame = requestAnimationFrame(() => {
      transformerRef.current?.forceUpdate();
      transformerRef.current?.getLayer()?.batchDraw();
    });
    return () => cancelAnimationFrame(redrawFrame);
  }, [activeCanvasCamera.zoom, activeCanvasCamera.viewX, activeCanvasCamera.viewY]);

  // ── 載入與頁面切換 ────────────────────────────────────────────────────────

  // 套用單一頁面的 layout 與背景圖，供 loadTemplate 和頁碼切換共用
  const applyPageDisplay = useCallback((page) => {
    setPageLayout(beginPageSession(page));
    setBackgroundUrl(
      page.id != null && page.background_filename
        ? `/api/templates/${templateId}/pages/${page.id}/background?t=${Date.now()}`
        : null
    );
  }, [beginPageSession, templateId]);

  const loadTemplate = useCallback(async () => {
    const response = await fetchTemplate(templateId);
    const nextTemplate = normalizeTemplateForEditor(response.data);
    templateRef.current = nextTemplate;
    persistedPageIdsRef.current = nextTemplate.pages.map(page => page.id);
    pageStructureDirtyRef.current = false;
    setTemplate(nextTemplate);
    return nextTemplate;
  }, [templateId]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const nextPage = pages[Math.min(currentPageIndex, pages.length - 1)];
    const nextPageKey = getEditorPageKey(nextPage);
    if (String(activePageSessionIdRef.current) === String(nextPageKey)) return;
    analysisRequestRef.current?.controller?.abort();
    analysisRequestRef.current = null;
    setAnalyzingTargetKey(null);
    activePageSessionIdRef.current = nextPageKey;
    applyPageDisplay(nextPage);
    resetEditorView();
  }, [currentPageIndex, template, applyPageDisplay, resetEditorView]);

  const startEditorGuide = useCallback(() => {
    startProductGuide(EDITOR_GUIDE_STEPS);
  }, []);

  // ── 頁面操作 ──────────────────────────────────────────────────────────────

  const handleSaveLayout = ({
    showToast = true,
    confirmProjectSync = false,
    projectSyncChangeHash = null,
  } = {}) => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const saveOperation = (async () => {
      if (!templateRef.current) return false;
      let latestSyncResult = null;
      let shouldConfirmProjectSync = confirmProjectSync;
      let confirmedChangeHash = projectSyncChangeHash;
      setIsSaving(true);
      try {
        do {
          const workingTemplate = templateRef.current;
          const hasPendingChanges = pageStructureDirtyRef.current
            || Object.keys(draftLayouts.current).length > 0;
          if (!hasPendingChanges) break;

          const pageSnapshots = workingTemplate.pages.map((page, pageIndex) => {
            const editorKey = getEditorPageKey(page);
            const draftReference = draftLayouts.current[editorKey];
            const layout = cloneLayout(draftReference ?? page.layout);
            const validation = validateLayoutGroups(layout);
            if (!validation.valid) {
              const message = validation.topologyValid
                ? `第 ${pageIndex + 1} 頁仍有失效素材連結，請先清除`
                : `第 ${pageIndex + 1} 頁的群組資料格式不正確`;
              throw Object.assign(new Error(message), { isLayoutValidationError: true });
            }
            return { page, editorKey, draftReference, layout };
          });
          const response = await saveTemplatePages(templateId, {
            expected_page_ids: [...persistedPageIdsRef.current],
            expected_revision: workingTemplate.revision,
            confirm_project_sync: shouldConfirmProjectSync,
            ...(confirmedChangeHash ? { project_sync_change_hash: confirmedChangeHash } : {}),
            pages: pageSnapshots.map(({ page, editorKey, layout }) => ({
              ...(page.id == null ? { client_id: editorKey } : { id: page.id }),
              layout,
            })),
          });
          const savedPages = response.data?.pages;
          if (!Array.isArray(savedPages)) throw new Error("invalid page snapshot response");
          latestSyncResult = response.data?.sync ?? latestSyncResult;

          const nextTemplate = normalizeTemplateForEditor(
            {
              ...workingTemplate,
              ...(response.data?.revision == null ? {} : { revision: response.data.revision }),
              ...(response.data?.sync?.reopened_project_count
                ? {
                    completed_project_count: Math.max(
                      0,
                      (workingTemplate.completed_project_count ?? 0)
                        - response.data.sync.reopened_project_count,
                    ),
                  }
                : {}),
              pages: savedPages,
            },
            workingTemplate.pages,
          );
          const snapshotsByKey = new Map(
            pageSnapshots.map(snapshot => [String(snapshot.editorKey), snapshot]),
          );
          reconcileSavedPages(nextTemplate.pages.map(page => {
            const editorKey = getEditorPageKey(page);
            return {
              sourcePageId: editorKey,
              savedPageId: editorKey,
              savedDraftReference: snapshotsByKey.get(String(editorKey))?.draftReference,
            };
          }));
          persistedPageIdsRef.current = nextTemplate.pages.map(page => page.id);
          pageStructureDirtyRef.current = false;
          templateRef.current = nextTemplate;
          setTemplate(nextTemplate);
          shouldConfirmProjectSync = false;
          confirmedChangeHash = null;
        } while (Object.keys(draftLayouts.current).length > 0 || pageStructureDirtyRef.current);
        if (showToast) toast.success(buildTemplateSyncSuccessMessage("已儲存", latestSyncResult));
        return true;
      } catch (error) {
        const detail = error?.response?.data?.detail;
        if (error?.isLayoutValidationError) {
          toast.error(error.message);
        } else if (
          error?.response?.status === 409
          && detail?.code === "template_structure_confirmation_required"
        ) {
          setConfirmModal({
            message: buildTemplateSyncConfirmationMessage(detail),
            confirmLabel: "同步並儲存",
            confirmVariant: "danger",
            onConfirm: () => handleSaveLayout({
              showToast,
              confirmProjectSync: true,
              projectSyncChangeHash: detail.change_hash,
            }),
          });
        } else if (
          error?.response?.status === 409
          && detail?.code === "template_structure_data_conflict"
        ) {
          if (detail.change_hash) {
            setConfirmModal({
              message: `${detail.message || "專案內容已變更。"}${buildTemplateSyncConfirmationMessage(detail)}`,
              confirmLabel: "依最新內容同步",
              confirmVariant: "danger",
              onConfirm: () => handleSaveLayout({
                showToast,
                confirmProjectSync: true,
                projectSyncChangeHash: detail.change_hash,
              }),
            });
          } else {
            toast.error(detail.message || "專案內容已變更，請重新儲存後再試");
          }
        } else if (error?.response?.status === 409) {
          toast.error("模板頁面已被其他人變更，請重新整理後再試");
        } else if (
          error?.response?.status === 422
          && detail?.code === "template_project_data_invalid"
        ) {
          const recordLabel = detail.student_id
            ? `（專案 ${detail.project_id}／學生 ${detail.student_id}）`
            : `（專案 ${detail.project_id}）`;
          toast.error(`${detail.message}${recordLabel}`);
        } else {
          toast.error("儲存失敗，草稿仍保留在畫面上");
        }
        return false;
      } finally {
        setIsSaving(false);
      }
    })();
    saveInFlightRef.current = saveOperation;
    const clearSaveOperation = () => {
      if (saveInFlightRef.current === saveOperation) saveInFlightRef.current = null;
    };
    void saveOperation.then(clearSaveOperation, clearSaveOperation);
    return saveOperation;
  };

  const handleOpenSpreadPreview = () => {
    if (!template?.pages.length) return;
    if (hasUnsavedChanges) {
      toast.error("有尚未儲存的變更，請先按儲存再預覽");
      return;
    }
    setSpreadPreviewOpen(true);
  };

  const handleAddPage = () => {
    if (saveInFlightRef.current) return;
    const currentTemplate = templateRef.current;
    if (!currentTemplate) return;
    const draftPage = createDraftPage(currentTemplate.pages.length);
    const nextTemplate = {
      ...currentTemplate,
      pages: [...currentTemplate.pages, draftPage],
    };
    pageStructureDirtyRef.current = true;
    templateRef.current = nextTemplate;
    activePageSessionIdRef.current = null;
    setTemplate(nextTemplate);
    setInspectorTab("layers");
    setCurrentPageIndex(nextTemplate.pages.length - 1);
    toast.success("已新增頁面（尚未儲存）");
  };

  const handleDeletePage = () => {
    if (!currentPage) return;
    setConfirmModal({
      message: "確定刪除此頁？",
      onConfirm: () => {
        if (saveInFlightRef.current) return;
        const currentTemplate = templateRef.current;
        if (!currentTemplate) return;
        const deletedPageKey = getEditorPageKey(currentPage);
        const nextPages = currentTemplate.pages
          .filter(page => getEditorPageKey(page) !== deletedPageKey)
          .map((page, pageIndex) => ({ ...page, page_number: pageIndex }));
        const nextTemplate = { ...currentTemplate, pages: nextPages };
        dropPageHistory(deletedPageKey);
        pageStructureDirtyRef.current = true;
        templateRef.current = nextTemplate;
        activePageSessionIdRef.current = null;
        setTemplate(nextTemplate);
        setInspectorTab("layers");
        setCurrentPageIndex(Math.min(
          Math.max(0, currentPageIndex - 1),
          Math.max(0, nextPages.length - 1),
        ));
        toast.success("已刪除頁面（尚未儲存）");
      },
    });
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
      setBackgroundUrl(
        `/api/templates/${templateId}/pages/${backgroundPageId}/background?t=${Date.now()}`
      );
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
      setInspectorTab("properties");
      setSelectedElement({ type: "sticker", id: newSticker.id });
      toast.success("貼圖已上傳");
    } catch {
      toast.error("上傳失敗");
    }
  };

  // ── 元素操作 ──────────────────────────────────────────────────────────────

  const handleSelectDirectRef = useCallback((directRef, { additive = false } = {}) => {
    if (!pageLayout || !directRef) return;
    const directKeys = new Set(editorLayoutModel.getScopeNodes(isolationGroupId).map(refKey));
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
  }, [editorLayoutModel, isolationGroupId, pageLayout]);

  const handleSelectElement = useCallback((elementRef, options = {}) => {
    if (!pageLayout || !elementRef) return;
    const directRef = editorLayoutModel.resolveHitToDirectChild(isolationGroupId, elementRef);
    if (directRef) handleSelectDirectRef(directRef, options);
  }, [editorLayoutModel, handleSelectDirectRef, isolationGroupId, pageLayout]);

  const handleSelectGroup = useCallback((groupId, options = {}) => {
    handleSelectDirectRef({ type: "group", id: groupId }, options);
  }, [handleSelectDirectRef]);

  const handleCanvasSelectElement = useCallback((elementRef, options = {}) => {
    setInspectorTab("properties");
    handleSelectElement(elementRef, {
      ...options,
      additive: isMultiSelectMode || options.additive,
    });
  }, [handleSelectElement, isMultiSelectMode]);

  const handleCanvasSelectGroup = useCallback((groupId, options = {}) => {
    setInspectorTab("properties");
    handleSelectGroup(groupId, {
      ...options,
      additive: isMultiSelectMode || options.additive,
    });
  }, [handleSelectGroup, isMultiSelectMode]);

  const enterGroup = useCallback((groupId, preferredHit = null) => {
    if (!pageLayout) return;
    const groupRef = { type: "group", id: groupId };
    const isDirect = editorLayoutModel.getScopeNodes(isolationGroupId).some(ref => sameRef(ref, groupRef));
    const group = isDirect ? editorLayoutModel.getGroupById(groupId) : null;
    if (!group) return;
    let nextChild = null;
    if (preferredHit?.type === "group") {
      nextChild = group.children.find(ref => sameRef(ref, preferredHit)) ?? null;
    } else if (preferredHit) {
      nextChild = editorLayoutModel.resolveHitToDirectChild(group.id, preferredHit);
    }
    nextChild ??= group.children[0] ?? null;
    setIsolationPath(editorLayoutModel.getGroupAncestorPath(group.id));
    setSelectedRefs(nextChild ? [nextChild] : []);
  }, [editorLayoutModel, isolationGroupId, pageLayout]);

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
    const directRef = editorLayoutModel.resolveHitToDirectChild(isolationGroupId, elementRef);
    if (directRef?.type === "group") enterGroup(directRef.id, elementRef);
  }, [editorLayoutModel, enterGroup, isolationGroupId, pageLayout]);

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
  }, [commitPageLayout, editorLayoutModel, isolationGroupId, selectedRefs]);

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
  }, [commitPageLayout, editorLayoutModel]);

  const updateElement = (elementType, elementId, propertyUpdates, commitOptions) => {
    const elementRef = { type: elementType, id: elementId };
    if (editorLayoutModel.getNodeLayerState(elementRef).isLocked) return;
    const arrayKey = ELEMENT_ARRAY_KEY[elementType];
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => String(element.id) === String(elementId) ? { ...element, ...propertyUpdates } : element
      ),
    }), commitOptions);
  };

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
  }, [commitPageLayout, editorLayoutModel, selectedRefs]);

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

  const handleDuplicateSelection = useCallback(() => {
    if (!selectedRefs.length) return;
    if (selectedRefs.some(ref => {
      const state = editorLayoutModel.getNodeLayerState(ref);
      return !state.isVisible || state.isLocked;
    })) return;
    try {
      let duplicatedRefs = [];
      commitPageLayout(currentLayout => {
        const result = duplicateLayoutNodes(currentLayout, selectedRefs, {
          parentGroupId: isolationGroupId,
        });
        duplicatedRefs = result.refs;
        return result.layout;
      });
      if (duplicatedRefs.length) setSelectedRefs(duplicatedRefs);
    } catch (error) {
      toast.error(error?.message || "無法複製選取物件");
    }
  }, [commitPageLayout, editorLayoutModel, isolationGroupId, selectedRefs]);

  const handleCopySelection = useCallback(() => {
    const clipboard = createLayoutClipboard(pageLayout, selectedRefs, {
      operation: "copy",
      sourcePageId: getEditorPageKey(currentPage),
    });
    if (!clipboard) return;
    layoutClipboardRef.current = clipboard;
    clipboardPasteCountRef.current = 0;
    setHasLayoutClipboard(true);
    toast.success(`已複製 ${selectedRefs.length} 個物件`);
  }, [currentPage, pageLayout, selectedRefs]);

  const handleCutSelection = useCallback(() => {
    const editableRefs = selectedRefs.filter(ref => {
      const state = editorLayoutModel.getNodeLayerState(ref);
      return state.isVisible && !state.isLocked;
    });
    if (editableRefs.length === 0) {
      if (selectedRefs.length > 0) toast.error("請先顯示並解除鎖定再剪下");
      return;
    }
    const clipboard = createLayoutClipboard(pageLayout, editableRefs, {
      operation: "cut",
      sourcePageId: getEditorPageKey(currentPage),
    });
    if (!clipboard) return;
    try {
      commitPageLayout(currentLayout => editableRefs.reduce((nextLayout, ref) => (
        ref.type === "group"
          ? deleteLayoutGroup(nextLayout, ref.id)
          : deleteLayoutElement(nextLayout, ref)
      ), currentLayout));
      layoutClipboardRef.current = clipboard;
      clipboardPasteCountRef.current = 0;
      setHasLayoutClipboard(true);
      setSelectedRefs(currentRefs => currentRefs.filter(
        ref => !editableRefs.some(item => sameRef(item, ref)),
      ));
      toast.success(`已剪下 ${editableRefs.length} 個物件`);
    } catch (error) {
      toast.error(error?.message || "無法剪下選取物件");
    }
  }, [commitPageLayout, currentPage, editorLayoutModel, pageLayout, selectedRefs]);

  const handlePasteSelection = useCallback(() => {
    const clipboard = layoutClipboardRef.current;
    if (!clipboard) return;
    if (isolationGroupId != null) {
      const targetGroupState = editorLayoutModel.getNodeLayerState({
        type: "group",
        id: isolationGroupId,
      });
      if (!targetGroupState.isVisible || targetGroupState.isLocked) {
        toast.error("請先顯示並解除目前群組鎖定再貼上");
        return;
      }
    }
    try {
      let pastedRefs = [];
      let externalMaterialLinkCount = 0;
      const isFirstPaste = clipboardPasteCountRef.current === 0;
      const isCutClipboard = clipboard.operation === "cut";
      const isSourcePage = String(clipboard.sourcePageId) === String(getEditorPageKey(currentPage));
      const pasteOffset = 20 * (
        isCutClipboard ? clipboardPasteCountRef.current : clipboardPasteCountRef.current + 1
      );
      commitPageLayout(currentLayout => {
        const result = pasteLayoutNodes(currentLayout, clipboard, {
          parentGroupId: isolationGroupId,
          offset: pasteOffset,
          restoreExternalMaterialLinks: isCutClipboard && isFirstPaste && isSourcePage,
          asMove: isCutClipboard && isFirstPaste,
        });
        pastedRefs = result.refs;
        externalMaterialLinkCount = result.externalMaterialLinkCount ?? 0;
        return result.layout;
      });
      if (pastedRefs.length) {
        clipboardPasteCountRef.current += 1;
        setSelectedRefs(pastedRefs);
        setInspectorTab("properties");
        if (isCutClipboard && isFirstPaste && !isSourcePage && externalMaterialLinkCount > 0) {
          toast("跨頁貼上不會保留與原頁物件的素材文字連結");
        }
      }
    } catch (error) {
      toast.error(error?.message || "無法貼上物件");
    }
  }, [commitPageLayout, currentPage, editorLayoutModel, isolationGroupId]);

  const handleMultiTransformStart = useCallback(() => {
    if (selectedRefs.length < 2 || !stageRef.current) return;
    const entries = selectedRefs.flatMap(ref => {
      const node = stageRef.current.findOne(candidate => candidate.id() === `${ref.type}-${ref.id}`);
      if (!node) return [];
      return [{
        ref: { ...ref },
        node,
        initialNodeState: {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
        },
        bounds: ref.type === "group" ? editorLayoutModel.getNodeBounds(ref) : null,
      }];
    });
    if (entries.length < 2) return;
    multiTransformSnapshotRef.current = { entries };
    beginCanvasGesture("multi-transform");
  }, [beginCanvasGesture, editorLayoutModel, selectedRefs]);

  const handleMultiTransformEnd = useCallback(() => {
    const snapshot = multiTransformSnapshotRef.current;
    multiTransformSnapshotRef.current = null;
    if (!snapshot) {
      endCanvasGesture();
      return;
    }
    try {
      commitPageLayout(currentLayout => snapshot.entries.reduce((nextLayout, entry) => {
        const { ref, node, bounds } = entry;
        const layerState = getNodeLayerState(nextLayout, ref);
        if (!layerState.isVisible || layerState.isLocked) return nextLayout;
        if (ref.type === "group") {
          const scale = (Math.abs(node.scaleX()) + Math.abs(node.scaleY())) / 2;
          return transformGroup(nextLayout, ref.id, {
            dx: toRealCoord(node.x() - toDisplayCoord(bounds.centerX)),
            dy: toRealCoord(node.y() - toDisplayCoord(bounds.centerY)),
            rotationDelta: normalizeDegrees(node.rotation() - (bounds.rotation ?? 0)),
            scale,
          });
        }

        const sourceData = getLayoutNodeData(nextLayout, ref);
        const collectionKey = ELEMENT_ARRAY_KEY[ref.type];
        if (!sourceData || !collectionKey) return nextLayout;
        const scaleX = Math.abs(node.scaleX());
        const scaleY = Math.abs(node.scaleY());
        const sourceWidth = Math.max(Number.EPSILON, Number(sourceData.width) || 0);
        const sourceHeight = Math.max(Number.EPSILON, Number(sourceData.height) || 0);
        const width = Math.max(Math.min(60, sourceWidth), toRealCoord(node.width() * scaleX));
        const height = Math.max(Math.min(40, sourceHeight), toRealCoord(node.height() * scaleY));
        if (ref.type === "photo") {
          const dimensionMode = getPhotoSlotDimensionMode(nextLayout);
          let nextWidth = width;
          let nextHeight = height;
          const snapped = snapPhotoSlotStandardRatio(
            sourceData.width,
            sourceData.height,
            "width",
            nextWidth,
          );
          if (snapped) ({ width: nextWidth, height: nextHeight } = snapped);
          const insets = getPhotoFrameInsets(sourceData);
          const frameCenterX = toRealCoord(node.x());
          const frameCenterY = toRealCoord(node.y());
          const nextSlot = applyPhotoEditorUpdates(sourceData, {
            x: frameCenterX + (insets.left - insets.right) / 2 - nextWidth / 2,
            y: frameCenterY + (insets.top - insets.bottom) / 2 - nextHeight / 2,
            width: nextWidth,
            height: nextHeight,
            rotation: normalizeDegrees(node.rotation()),
          }, dimensionMode);
          return {
            ...nextLayout,
            [collectionKey]: (nextLayout[collectionKey] || []).map(item => (
              String(item.id) === String(ref.id) ? nextSlot : item
            )),
          };
        }
        const updates = {
          x: toRealCoord(node.x()) - width / 2,
          y: toRealCoord(node.y()) - height / 2,
          width,
          height,
          rotation: normalizeDegrees(node.rotation()),
        };
        return {
          ...nextLayout,
          [collectionKey]: (nextLayout[collectionKey] || []).map(item => (
            String(item.id) === String(ref.id) ? { ...item, ...updates } : item
          )),
        };
      }, currentLayout));
      snapshot.entries.forEach(({ ref, node }) => {
        node.scale({ x: 1, y: 1 });
        const visualId = ref.type === "group"
          ? `group-visual-${ref.id}`
          : ref.type === "photo" ? `photo-visual-${ref.id}` : null;
        const visualNode = visualId == null
          ? null
          : node.getLayer()?.findOne(candidate => candidate.id() === visualId);
        if (visualNode) {
          visualNode.position(node.position());
          visualNode.rotation(node.rotation());
          visualNode.scale({ x: 1, y: 1 });
        }
      });
      transformerRef.current?.forceUpdate();
    } catch (error) {
      snapshot.entries.forEach(({ ref, node, initialNodeState }) => {
        node.position({ x: initialNodeState.x, y: initialNodeState.y });
        node.rotation(initialNodeState.rotation);
        node.scale({ x: initialNodeState.scaleX, y: initialNodeState.scaleY });
        const visualId = ref.type === "group"
          ? `group-visual-${ref.id}`
          : ref.type === "photo" ? `photo-visual-${ref.id}` : null;
        const visualNode = visualId == null
          ? null
          : node.getLayer()?.findOne(candidate => candidate.id() === visualId);
        if (visualNode) {
          visualNode.position(node.position());
          visualNode.rotation(node.rotation());
          visualNode.scale(node.scale());
        }
      });
      transformerRef.current?.forceUpdate();
      toast.error(error?.message || "無法變形多選物件");
    } finally {
      setTransientTypographyScales(current => {
        const next = { ...current };
        snapshot.entries.forEach(({ ref }) => {
          if (ref.type === "group") delete next[String(ref.id)];
        });
        return next;
      });
      endCanvasGesture();
    }
  }, [commitPageLayout, endCanvasGesture]);

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

  useEffect(() => {
    if (!pageLayout) return;
    const deepestSurvivingId = [...isolationPath]
      .reverse()
      .find(id => editorLayoutModel.getGroupById(id));
    const canonicalPath = deepestSurvivingId == null
      ? []
      : editorLayoutModel.getGroupAncestorPath(deepestSurvivingId);
    if (canonicalPath.length !== isolationPath.length
      || canonicalPath.some((id, index) => String(id) !== String(isolationPath[index]))) {
      setIsolationPath(canonicalPath);
      return;
    }
    const directKeys = new Set(editorLayoutModel.getScopeNodes(isolationGroupId).map(refKey));
    setSelectedRefs(currentRefs => {
      const survivingRefs = currentRefs.filter(ref => directKeys.has(refKey(ref)));
      return survivingRefs.length === currentRefs.length ? currentRefs : survivingRefs;
    });
  }, [editorLayoutModel, isolationGroupId, isolationPath, pageLayout]);

  // Delete / Backspace / Undo / Redo / 群組導覽與方向鍵
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.defaultPrevented) return;
      const isInputTarget = isKeyboardInputTarget(document.activeElement);
      const normalizedKey = keyEvent.key.toLowerCase();
      const isModifiedEditorCommand = (keyEvent.ctrlKey || keyEvent.metaKey)
        && ["c", "d", "g", "v", "x", "y", "z"].includes(normalizedKey);
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
          setInspectorTab("layers");
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
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "c" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleCopySelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "x" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleCutSelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "v") {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handlePasteSelection();
        return;
      }
      if ((keyEvent.ctrlKey || keyEvent.metaKey) && normalizedKey === "d" && selectedRefs.length > 0) {
        keyEvent.preventDefault();
        if (!keyEvent.repeat) handleDuplicateSelection();
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
            const state = getNodeLayerState(nextLayout, ref);
            return state.isVisible && !state.isLocked
              ? moveLayoutNode(nextLayout, ref, { dx, dy })
              : nextLayout;
          }, currentLayout), { historyGroup: "keyboard-move" });
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
    const handleKeyUp = (keyEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(keyEvent.key)) {
        endHistoryGroup("keyboard-move");
      }
    };
    const handleWindowBlur = () => endHistoryGroup("keyboard-move");
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [
    commitPageLayout,
    deleteSelectedElement,
    endHistoryGroup,
    enterGroup,
    exitGroup,
    handleCreateGroup,
    handleCopySelection,
    handleCutSelection,
    handleDuplicateSelection,
    handlePasteSelection,
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
    if (currentPage.id == null) {
      toast.error("請先儲存新增頁面，再分析圖片素材");
      return;
    }
    const currentValidation = validateLayoutGroups(layoutSnapshot);
    if (currentValidation.topologyValid && !currentValidation.linkValid) {
      toast.error("請先清除失效素材連結");
      return;
    }
    const stickerRef = target?.type === "sticker" ? { type: "sticker", id: target.id } : null;
    const sticker = stickerRef ? getLayoutNodeData(layoutSnapshot, stickerRef) : null;

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
      pageKey: getEditorPageKey(currentPage),
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
      if (String(activePageSessionIdRef.current) !== String(request.pageKey)) return;

      const currentLayout = pageLayoutRef.current;
      const currentSticker = getLayoutNodeData(
        currentLayout,
        { type: "sticker", id: request.stickerId },
      );
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
        if (String(activePageSessionIdRef.current) !== String(request.pageKey)) return baseLayout;
        const latestStickerRef = { type: "sticker", id: request.stickerId };
        const latestSticker = getLayoutNodeData(baseLayout, latestStickerRef);
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
          const linkedText = getLayoutNodeData(baseLayout, linkedTextRef);
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
  }, [commitPageLayout, currentPage, templateId]);

  const handleLinkSelectedMaterialText = useCallback(() => {
    const stickerRef = selectedRefs.find(ref => ref.type === "sticker");
    const textRef = selectedRefs.find(ref => ref.type === "text");
    if (selectedRefs.length !== 2 || !stickerRef || !textRef) return;
    handleAnalyzeMaterial({ ...stickerRef, textId: textRef.id });
  }, [handleAnalyzeMaterial, selectedRefs]);

  // ── Konva Stage 事件：放置元素 or 取消選取 ───────────────────────────────

  const setCameraInteractionListening = useCallback((isListening) => {
    pageCameraRef.current?.listening(isListening);
    transformerRef.current?.listening(isListening);
    stageRef.current?.batchDraw();
  }, []);

  const suppressImmediateStageClick = useCallback(() => {
    suppressNextStageClickRef.current = true;
    suppressStageClickSequenceRef.current += 1;
    const sequence = suppressStageClickSequenceRef.current;
    requestAnimationFrame(() => {
      if (suppressStageClickSequenceRef.current === sequence) {
        suppressNextStageClickRef.current = false;
      }
    });
  }, []);

  const finishCameraGesture = useCallback(({ suppressClick = true } = {}) => {
    const gesture = cameraGestureRef.current;
    if (!gesture || gesture.kind === "touch-blocked") return;
    cameraGestureRef.current = null;
    if (suppressClick) suppressImmediateStageClick();
    setCameraInteractionListening(true);
    const stageContainer = stageRef.current?.container();
    if (stageContainer) stageContainer.style.cursor = "";
    endCanvasGesture();
  }, [endCanvasGesture, setCameraInteractionListening, suppressImmediateStageClick]);

  const beginCameraGesture = useCallback((gesture, target) => {
    target?.stopDrag?.();
    cameraGestureRef.current = gesture;
    setMarqueeGesture(null);
    setCameraInteractionListening(false);
    beginCanvasGesture("camera");
    const stageContainer = stageRef.current?.container();
    if (stageContainer) stageContainer.style.cursor = "grabbing";
  }, [beginCanvasGesture, setCameraInteractionListening]);

  const getStageTouchPoints = useCallback((nativeEvent) => {
    const stage = stageRef.current;
    if (!stage) return [];
    stage.setPointersPositions(nativeEvent);
    return stage.getPointersPositions().map(point => ({ x: point.x, y: point.y }));
  }, []);

  const getPointerCoordinates = useCallback(() => {
    const viewportPosition = stageRef.current?.getPointerPosition();
    const displayPosition = pageCameraRef.current?.getRelativePointerPosition();
    if (!viewportPosition || !displayPosition) return null;
    return {
      viewport: viewportPosition,
      display: displayPosition,
      real: {
        x: toRealCoord(displayPosition.x),
        y: toRealCoord(displayPosition.y),
      },
    };
  }, []);

  const handleStagePointerDown = useCallback((event) => {
    if (cameraGestureRef.current) return;
    const nativeEvent = event.evt;
    const touchCount = nativeEvent?.touches?.length ?? 0;
    if (isResponsiveCanvas && touchCount === 1) {
      touchCandidateTargetRef.current = event.target;
    }
    if (isResponsiveCanvas && touchCount >= 2) {
      const isLayoutGesture = activeCanvasGestureRef.current != null
        && activeCanvasGestureRef.current !== "marquee";
      if (isLayoutGesture || transformerRef.current?.isTransforming()) {
        cameraGestureRef.current = { kind: "touch-blocked" };
        return;
      }
      const touchPoints = getStageTouchPoints(nativeEvent);
      if (touchPoints.length < 2) return;
      if (activeCanvasGestureRef.current === "marquee") endCanvasGesture();
      touchCandidateTargetRef.current?.stopDrag?.();
      touchCandidateTargetRef.current = null;
      beginCameraGesture({
        kind: "pinch",
        startCamera: { ...cameraRef.current },
        startTouches: touchPoints.slice(0, 2),
      }, event.target);
      nativeEvent.preventDefault?.();
      event.cancelBubble = true;
      return;
    }

    const pointerButton = nativeEvent?.button ?? 0;
    const shouldPanCamera = isResponsiveCanvas
      && (pointerButton === 1 || (pointerButton === 0 && isSpacePanPressedRef.current));
    if (shouldPanCamera) {
      beginCameraGesture({
        kind: "pan",
        lastClientX: nativeEvent.clientX,
        lastClientY: nativeEvent.clientY,
      }, event.target);
      nativeEvent.preventDefault?.();
      event.cancelBubble = true;
      return;
    }

    if (activeTool !== "select" || event.target !== event.target.getStage()) return;
    // 手機一般模式的空白觸控只負責取消選取；明確開啟多選後才允許框選。
    if (isPhoneEditor && touchCount === 1 && !isMultiSelectMode) return;
    if (pointerButton !== 0) return;
    const pointer = getPointerCoordinates();
    if (!pointer || !isPointInsideCanvasPage(pointer.display)) return;
    setInspectorTab("properties");
    setMarqueeGesture({
      startViewport: pointer.viewport,
      currentViewport: pointer.viewport,
      startDisplay: pointer.display,
      currentDisplay: pointer.display,
      startReal: pointer.real,
      currentReal: pointer.real,
      additive: isMultiSelectMode || !!nativeEvent?.shiftKey,
      baseSelection: isMultiSelectMode || nativeEvent?.shiftKey ? [...selectedRefs] : [],
      active: false,
    });
    beginCanvasGesture("marquee");
  }, [
    activeTool,
    beginCameraGesture,
    beginCanvasGesture,
    cameraRef,
    endCanvasGesture,
    getPointerCoordinates,
    getStageTouchPoints,
    isPhoneEditor,
    isMultiSelectMode,
    isResponsiveCanvas,
    selectedRefs,
  ]);

  const handleStagePointerMove = useCallback(() => {
    if (cameraGestureRef.current) return;
    if (!marqueeGesture || !pageLayout) return;
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const distance = Math.hypot(
      pointer.viewport.x - marqueeGesture.startViewport.x,
      pointer.viewport.y - marqueeGesture.startViewport.y,
    );
    const active = marqueeGesture.active || distance > 4;
    const nextGesture = {
      ...marqueeGesture,
      currentViewport: pointer.viewport,
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

  const handleStageHoverMove = useCallback((event) => {
    if (activeTool !== "select" || activeCanvasGestureRef.current || !pageLayout) {
      setHoveredRef(null);
      return;
    }

    const hitRef = getCanvasElementRefFromTarget(event.target, event.target?.getStage?.());
    const directRef = hitRef?.type === "group"
      ? editorLayoutModel.getScopeNodes(isolationGroupId).find(ref => sameRef(ref, hitRef)) ?? null
      : editorLayoutModel.resolveHitToDirectChild(isolationGroupId, hitRef);
    setHoveredRef(current => (sameRef(current, directRef) ? current : directRef));
  }, [activeTool, editorLayoutModel, isolationGroupId, pageLayout]);

  const handleStagePointerUp = useCallback(() => {
    if (cameraGestureRef.current?.kind === "pan") {
      finishCameraGesture();
      return;
    }
    if (cameraGestureRef.current) return;
    if (!marqueeGesture) return;
    if (marqueeGesture.active) suppressImmediateStageClick();
    setMarqueeGesture(null);
    endCanvasGesture();
  }, [endCanvasGesture, finishCameraGesture, marqueeGesture, suppressImmediateStageClick]);

  const handleStageTouchMove = useCallback((event) => {
    const gesture = cameraGestureRef.current;
    if (gesture?.kind === "pinch") {
      const touchPoints = getStageTouchPoints(event.evt);
      if (touchPoints.length >= 2) {
        applyPinch(gesture.startCamera, gesture.startTouches, touchPoints.slice(0, 2));
      }
      event.evt.preventDefault?.();
      event.cancelBubble = true;
      return;
    }
    if (gesture?.kind === "touch-blocked") return;
    handleStagePointerMove();
  }, [applyPinch, getStageTouchPoints, handleStagePointerMove]);

  const handleStageTouchEnd = useCallback((event) => {
    const gesture = cameraGestureRef.current;
    if (gesture?.kind === "pinch") {
      if ((event.evt?.touches?.length ?? 0) === 0) {
        touchCandidateTargetRef.current = null;
        finishCameraGesture();
      }
      event.evt.preventDefault?.();
      event.cancelBubble = true;
      return;
    }
    if (gesture?.kind === "touch-blocked") {
      if ((event.evt?.touches?.length ?? 0) === 0) {
        cameraGestureRef.current = null;
        touchCandidateTargetRef.current = null;
      }
      return;
    }
    if ((event.evt?.touches?.length ?? 0) === 0) {
      if (event.evt?.type === "touchcancel") {
        touchCandidateTargetRef.current = null;
      } else {
        // Konva 會在 touchend 後才合成 tap；保留起點到下一幀，避免 Transformer
        // 的放大命中區把 tap 轉成 Stage 空白點擊而誤清除既有選取。
        const touchTarget = touchCandidateTargetRef.current;
        requestAnimationFrame(() => {
          if (touchCandidateTargetRef.current === touchTarget) {
            touchCandidateTargetRef.current = null;
          }
        });
      }
    }
    handleStagePointerUp();
  }, [finishCameraGesture, handleStagePointerUp]);

  useEffect(() => {
    if (!isResponsiveCanvas) return undefined;
    const handleMouseMove = (mouseEvent) => {
      const gesture = cameraGestureRef.current;
      if (gesture?.kind !== "pan") return;
      const delta = {
        x: mouseEvent.clientX - gesture.lastClientX,
        y: mouseEvent.clientY - gesture.lastClientY,
      };
      gesture.lastClientX = mouseEvent.clientX;
      gesture.lastClientY = mouseEvent.clientY;
      panBy(delta);
      mouseEvent.preventDefault();
    };
    const handleMouseUp = () => {
      if (cameraGestureRef.current?.kind === "pan") finishCameraGesture({ suppressClick: false });
    };
    const recoverCameraInteraction = () => {
      isSpacePanPressedRef.current = false;
      if (cameraGestureRef.current?.kind === "touch-blocked") {
        cameraGestureRef.current = null;
        touchCandidateTargetRef.current = null;
        return;
      }
      if (cameraGestureRef.current) finishCameraGesture({ suppressClick: false });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") recoverCameraInteraction();
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", recoverCameraInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", recoverCameraInteraction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      recoverCameraInteraction();
    };
  }, [finishCameraGesture, isResponsiveCanvas, panBy]);

  useEffect(() => {
    if (!isResponsiveCanvas) {
      isSpacePanPressedRef.current = false;
      return undefined;
    }
    const handleSpaceDown = (keyboardEvent) => {
      if (keyboardEvent.code !== "Space" || isKeyboardInputTarget(document.activeElement)) return;
      isSpacePanPressedRef.current = true;
      keyboardEvent.preventDefault();
    };
    const handleSpaceUp = (keyboardEvent) => {
      if (keyboardEvent.code === "Space") isSpacePanPressedRef.current = false;
    };
    window.addEventListener("keydown", handleSpaceDown);
    window.addEventListener("keyup", handleSpaceUp);
    return () => {
      window.removeEventListener("keydown", handleSpaceDown);
      window.removeEventListener("keyup", handleSpaceUp);
    };
  }, [isResponsiveCanvas]);

  useEffect(() => {
    if (isResponsiveCanvas || !cameraGestureRef.current) return;
    if (cameraGestureRef.current.kind === "touch-blocked") {
      cameraGestureRef.current = null;
      touchCandidateTargetRef.current = null;
      return;
    }
    finishCameraGesture({ suppressClick: false });
  }, [finishCameraGesture, isResponsiveCanvas]);

  useEffect(() => {
    if (!isResponsiveCanvas || !pageLayout) return undefined;
    const stage = stageRef.current;
    const stageContainer = stage?.container();
    if (!stage || !stageContainer) return undefined;
    const handleCameraWheel = (wheelEvent) => {
      if (!wheelEvent.ctrlKey && !wheelEvent.metaKey) return;
      wheelEvent.preventDefault();
      stage.setPointersPositions(wheelEvent);
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const zoomFactor = Math.exp(-wheelEvent.deltaY * 0.002);
      zoomAtPoint(cameraRef.current.zoom * zoomFactor, pointer);
    };
    stageContainer.addEventListener("wheel", handleCameraWheel, { passive: false });
    return () => stageContainer.removeEventListener("wheel", handleCameraWheel);
  }, [cameraRef, isResponsiveCanvas, pageLayout, zoomAtPoint]);

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
    if (!pointer || !isPointInsideCanvasPage(pointer.display)) return;
    const currentBounds = editorLayoutModel.getGroupBounds(isolationGroupId);
    if (!pointIsInsideOrientedBounds(pointer.real, currentBounds)) {
      event.cancelBubble = true;
      exitGroup();
    }
  }, [activeTool, editorLayoutModel, exitGroup, getPointerCoordinates, isolationGroupId]);

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
  }, [commitPageLayout, photoSlotDimensionMode, setSelectedElement]);

  const handleMobileAddTool = useCallback((tool) => {
    if (!["addPhotoPortrait", "addPhotoLandscape", "addText"].includes(tool)) return;
    const viewportCenter = {
      x: canvasStageSize.width / 2,
      y: canvasStageSize.height / 2,
    };
    const pageCenter = canvasViewportPointToPage(viewportCenter, activeCanvasCamera);
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
  }, [activeCanvasCamera, addElementAtRealPoint, canvasStageSize.height, canvasStageSize.width]);

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
    const isInsidePage = isPointInsideCanvasPage(pointer.display);

    if (["addPhotoPortrait", "addPhotoLandscape", "addText"].includes(activeTool)) {
      if (!isInsidePage) return;
      addElementAtRealPoint(activeTool, { x: realX, y: realY });
      return;
    }

    const touchStartedOnCanvasControl = touchCandidateTargetRef.current != null
      && touchCandidateTargetRef.current !== stageRef.current;
    // 選取模式：點擊空白處取消選取。觸控若從物件／Transformer 開始，
    // 即使 Konva 將合成 tap 的 target 回報成 Stage，也不應誤判為空白。
    if (e.target === stageRef.current
      && !touchStartedOnCanvasControl
      && !e.evt?.shiftKey
      && !isMultiSelectMode) {
      setInspectorTab("layers");
      setSelectedElement(null);
    }
  };

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

  if (template.pages.length === 0 && isResponsiveCanvas) {
    return (
      <div className={`mx-auto flex w-full max-w-[1042px] flex-col bg-slate-50 ${
        isPhoneEditor
          ? "fixed inset-0 z-30 h-dvh max-w-none overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom))]"
          : "h-[calc(100dvh-5.25rem)] min-h-0 overflow-hidden"
      }`}>
        {confirmDialog}
        <div
          className="flex min-h-14 flex-shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-1.5 shadow-sm"
          data-guide={isPhoneEditor ? "mobile-editor-topbar" : "editor-compact-topbar"}
        >
          <button
            type="button"
            onClick={handleExitEditor}
            aria-label="返回模板列表"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-sm font-semibold text-gray-900" title={template.name}>{template.name}</h1>
            <p className="truncate text-[11px] text-gray-500">尚未建立頁面 · 0 張照片</p>
          </div>
          <span className="inline-flex flex-shrink-0 items-center" data-guide="history-actions">
            <button type="button" onClick={undoLayout} disabled={!canUndo} aria-label="復原" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35">
              <Undo2 className="h-4 w-4" />
            </button>
            <button type="button" onClick={redoLayout} disabled={!canRedo} aria-label="重做" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35">
              <Redo2 className="h-4 w-4" />
            </button>
          </span>
          <button
            type="button"
            onClick={handleSaveLayout}
            disabled={isSaving || !hasUnsavedChanges}
            data-guide="save-template"
            data-dirty={hasUnsavedChanges ? "true" : "false"}
            className="inline-flex min-h-11 min-w-14 flex-shrink-0 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {isSaving ? "儲存中" : "儲存"}
            {hasUnsavedChanges && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
          </button>
        </div>
        <TemplateUsageBanner template={template} />
        <div className="flex min-h-0 flex-1 items-center justify-center p-5">
          <section className="w-full max-w-sm rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center shadow-sm" aria-labelledby="empty-template-title">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
              <Camera className="h-6 w-6" />
            </span>
            <h2 id="empty-template-title" className="mt-4 text-lg font-semibold text-gray-900">先建立第一頁</h2>
            <p className="mt-1 text-sm leading-6 text-gray-500">建立頁面後即可加入照片格、文字、背景與貼圖。</p>
            {!isPhoneEditor && (
              <button type="button" onClick={handleAddPage} disabled={isSaving} className="mt-5 min-h-11 w-full rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                新增第一頁
              </button>
            )}
          </section>
        </div>
        {isPhoneEditor && (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 p-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.08)]" data-guide="mobile-editor-dock">
            <button type="button" onClick={handleAddPage} disabled={isSaving} aria-label="新增第一頁" className="inline-flex min-h-14 w-full items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              ＋ 新增第一頁
            </button>
          </div>
        )}
      </div>
    );
  }

  if (template.pages.length === 0) {
    return (
      <div>
        {confirmDialog}
        <h1 className="text-2xl font-bold mb-4">編輯模板：{template.name}</h1>
        <div className="inline-flex items-center gap-1 text-sm text-gray-500 mb-4">
          <Camera className="w-4 h-4" />
          照片總計 0 張
        </div>
        <TemplateUsageBanner template={template} />
        <div className="flex items-center gap-2">
          <button
            onClick={handleAddPage}
            disabled={isSaving}
            className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50"
          >
            新增第一頁
          </button>
          {hasUnsavedChanges && (
            <button
              onClick={handleSaveLayout}
              disabled={isSaving}
              data-guide="save-template"
              data-dirty={hasUnsavedChanges ? "true" : "false"}
              className="rounded border border-indigo-200 bg-white px-4 py-2 text-indigo-700 disabled:opacity-50"
            >
              {isSaving ? "儲存中..." : "儲存"}
            </button>
          )}
        </div>
      </div>
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
  const activeScopeCanvasNodes = activeScopeRefs
    .map(ref => editorLayoutModel.getRenderNode(ref, { visibleOnly: true }))
    .filter(Boolean);
  const flattenedSceneLeaves = editorLayoutModel.visibleFlattenedLeaves;
  const activeLeafKeys = new Set(
    isolationGroupId == null
      ? []
      : editorLayoutModel.getDescendantLeafRefs(isolationGroupId).map(refKey),
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
    label: editorLayoutModel.getGroupById(groupId)?.layer_name || `群組 ${index + 1}`,
    data: editorLayoutModel.getGroupById(groupId),
  }));
  const visiblePhotoOrdinals = editorLayoutModel.getVisibleElementOrdinals("photo");
  const selectedMaterialLink = selectedElement
    ? editorLayoutModel.getMaterialTextLinkForNode(selectedElement)
    : null;
  const selectedAnalysisStickerId = selectedElement?.type === "sticker"
    ? selectedElement.id
    : selectedMaterialLink?.material_id ?? null;
  const marqueeDisplayRect = marqueeGesture?.active
    ? normalizeSelectionRect(marqueeGesture.startDisplay, marqueeGesture.currentDisplay)
    : null;
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
  const getMinimumMultiResizeFactor = () => selectedRefs.reduce((minimumFactor, ref) => {
    const targetNode = stageRef.current?.findOne(candidate => candidate.id() === `${ref.type}-${ref.id}`);
    if (!targetNode) return minimumFactor;
    const leafRefs = ref.type === "group" ? editorLayoutModel.getDescendantLeafRefs(ref.id) : [ref];
    const scaleX = Math.max(Number.EPSILON, Math.abs(targetNode.scaleX()));
    const scaleY = Math.max(Number.EPSILON, Math.abs(targetNode.scaleY()));
    return leafRefs.reduce((leafMinimum, leafRef) => {
      const leafData = editorLayoutModel.getNodeData(leafRef);
      if (!leafData) return leafMinimum;
      const dimensions = leafRef.type === "photo"
        ? getPhotoContentRect(leafData, { dimensionMode: photoSlotDimensionMode })
        : leafData;
      const width = Math.max(Number.EPSILON, Number(dimensions.width) || 0);
      const height = Math.max(Number.EPSILON, Number(dimensions.height) || 0);
      return Math.max(
        leafMinimum,
        60 / (width * scaleX),
        40 / (height * scaleY),
      );
    }, minimumFactor);
  }, 0);

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

  // 傳給 Konva 節點渲染函式的頁面 state（見 components/canvas/pageElementNodes）
  const canvasNodeContext = {
    isSelectMode: activeTool === "select",
    photoSlotDimensionMode,
    currentPageIndex,
    updateElement,
    setSelectedElement,
    onSelectElement: handleCanvasSelectElement,
    onActivateElement: handleActivateElement,
    onGestureStart: beginCanvasGesture,
    onGestureEnd: endCanvasGesture,
  };

  const isRefSelected = ref => selectedRefs.some(selectedRef => sameRef(selectedRef, ref));
  const isRefHovered = ref => hoveredRef != null && sameRef(hoveredRef, ref);

  const renderElementNode = (node, {
    disabled = false,
    group = null,
    typographyScale = 1,
  } = {}) => {
    const { type, data, index: elemIndex } = node;
    const elementRef = { type, id: data.id };
    const isInteractionDisabled = disabled
      || (group == null && editorLayoutModel.getNodeLayerState(elementRef).isLocked);
    const isSelected = isRefSelected(elementRef);
    const isMultiTransformTarget = selectedRefs.length > 1 && isSelected && group == null;
    const isHovered = !isInteractionDisabled && group == null && isRefHovered(elementRef);

    if (type === "photo") {
      const visiblePhotoIndex = (visiblePhotoOrdinals.get(String(data.id)) ?? (elemIndex + 1)) - 1;
      const controlProps = makePhotoControlProps(data, canvasNodeContext);
      if (isInteractionDisabled) Object.assign(controlProps, { draggable: false, listening: false });
      if (isMultiTransformTarget) {
        Object.assign(controlProps, { onTransformStart: undefined, onTransformEnd: undefined });
      }
      if (group) {
        Object.assign(controlProps, {
          draggable: false,
          listening: activeTool === "select" && !disabled,
          onClick: (event) => {
            event.cancelBubble = true;
            handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
          },
          onTap: (event) => {
            event.cancelBubble = true;
            handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
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
      return renderPhotoSlotNode(
        data,
        visiblePhotoIndex,
        isSelected,
        isHovered,
        controlProps,
        canvasNodeContext,
      );
    }

    const groupProps = makeGroupProps(type, data, canvasNodeContext);
    if (isInteractionDisabled) Object.assign(groupProps, { draggable: false, listening: false });
    if (isMultiTransformTarget) {
      Object.assign(groupProps, { onTransformStart: undefined, onTransformEnd: undefined });
    }
    if (group) {
      Object.assign(groupProps, {
        draggable: false,
        listening: activeTool === "select" && !disabled,
        onClick: (event) => {
          event.cancelBubble = true;
          handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
        },
        onTap: (event) => {
          event.cancelBubble = true;
          handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
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

    if (type === "text") return renderTextLabelNode(
      data,
      isSelected,
      groupProps,
      { isHovered, suppressSelectedStroke: selectedRefs.length === 1, typographyScale },
    );
    if (type === "sticker") return (
      <StickerNode
        key={`sticker-${data.id}`}
        sticker={data}
        templateId={templateId}
        isHovered={isHovered}
        isSelected={isSelected}
        suppressSelectedStroke={selectedRefs.length === 1}
        groupProps={groupProps}
      />
    );
    return null;
  };

  const renderDirectGroupNode = (node) => {
    const group = node.data;
    const groupRef = { type: "group", id: group.id };
    const groupLayerState = editorLayoutModel.getNodeLayerState(groupRef);
    const isSelected = isRefSelected(groupRef);
    const isHovered = !groupLayerState.isLocked && isRefHovered(groupRef);
    const bounds = editorLayoutModel.getNodeBounds(groupRef);
    const center = {
      x: toDisplayCoord(bounds.centerX),
      y: toDisplayCoord(bounds.centerY),
    };
    const displayWidth = toDisplayCoord(bounds.width);
    const displayHeight = toDisplayCoord(bounds.height);
    const baseRotation = bounds.rotation ?? group.selection_rotation ?? 0;
    const typographyScale = transientTypographyScales[String(group.id)] ?? 1;
    const syncGroupVisualNode = (controlNode) => {
      const visualNode = controlNode.getLayer()?.findOne(
        candidate => candidate.id() === `group-visual-${group.id}`,
      );
      if (!visualNode) return;
      visualNode.position(controlNode.position());
      visualNode.rotation(controlNode.rotation());
      visualNode.scale({ x: controlNode.scaleX(), y: controlNode.scaleY() });
      visualNode.getLayer()?.batchDraw();
    };
    const resetTransientTransform = (konvaNode) => {
      konvaNode.position(center);
      konvaNode.rotation(baseRotation);
      konvaNode.scale({ x: 1, y: 1 });
      syncGroupVisualNode(konvaNode);
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
      <Fragment key={`group-pair-${group.id}`}>
        <KonvaGroup
          id={`group-visual-${group.id}`}
          x={center.x}
          y={center.y}
          rotation={baseRotation}
          listening={false}
        >
          <KonvaGroup rotation={-baseRotation}>
            <KonvaGroup x={-center.x} y={-center.y}>
              {flattenRenderNodes([node], { visibleOnly: true }).map(childNode => renderElementNode(childNode, {
                group,
                typographyScale,
              }))}
            </KonvaGroup>
          </KonvaGroup>
        </KonvaGroup>
        <KonvaGroup
          key={`group-${group.id}`}
          id={`group-${group.id}`}
          x={center.x}
          y={center.y}
          width={displayWidth}
          height={displayHeight}
          rotation={baseRotation}
          scaleX={1}
          scaleY={1}
          draggable={activeTool === "select" && !groupLayerState.isLocked}
          listening={activeTool === "select" && !groupLayerState.isLocked}
          onClick={(event) => {
            event.cancelBubble = true;
            handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
          }}
          onTap={(event) => {
            event.cancelBubble = true;
            handleCanvasSelectGroup(group.id, { additive: !!event.evt?.shiftKey });
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
          onDragMove={event => syncGroupVisualNode(event.currentTarget)}
          onDragEnd={event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: false })}
          onTransformStart={selectedRefs.length > 1
            ? undefined
            : () => beginCanvasGesture("group-transform")}
          onTransform={(event) => {
            syncGroupVisualNode(event.currentTarget);
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
          onTransformEnd={selectedRefs.length > 1
            ? undefined
            : event => commitGroupTransform(event.currentTarget, { includeScaleAndRotation: true })}
        >
          <Rect
            x={-displayWidth / 2}
            y={-displayHeight / 2}
            width={displayWidth}
            height={displayHeight}
            fill="rgba(255,255,255,0.001)"
          />
          {isHovered && !isSelected && (
            <Rect
              name={OBJECT_HOVER_OUTLINE_NAME}
              x={-displayWidth / 2}
              y={-displayHeight / 2}
              width={displayWidth}
              height={displayHeight}
              fill="transparent"
              stroke={OBJECT_HOVER_STROKE}
              strokeWidth={OBJECT_HOVER_STROKE_WIDTH}
              listening={false}
            />
          )}
        </KonvaGroup>
      </Fragment>
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
      {/* 手機／平板把最常用命令固定在單列，避免儲存被擠出首屏。 */}
      {isResponsiveCanvas ? (
        <div
          className="flex min-h-14 flex-shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-1.5 shadow-sm"
          data-guide={isPhoneEditor ? "mobile-editor-topbar" : "editor-compact-topbar"}
        >
          <button
            type="button"
            onClick={handleExitEditor}
            aria-label="返回模板列表"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-sm font-semibold text-gray-900" title={template.name}>{template.name}</h1>
            <p className="truncate text-[11px] text-gray-500">
              第 {currentPageIndex + 1}/{template.pages.length} 頁 · {totalPhotoCount} 張照片
            </p>
          </div>
          <span className="inline-flex flex-shrink-0 items-center" data-guide="history-actions">
            <button
              type="button"
              onClick={undoLayout}
              disabled={!canUndo}
              aria-label="復原"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={redoLayout}
              disabled={!canRedo}
              aria-label="重做"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35"
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </span>
          <button
            type="button"
            onClick={handleSaveLayout}
            disabled={isSaving || hasRepairableMaterialLinks}
            title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined}
            data-guide="save-template"
            data-dirty={hasUnsavedChanges ? "true" : "false"}
            className="inline-flex min-h-11 min-w-14 flex-shrink-0 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "儲存中" : "儲存"}
            {hasUnsavedChanges && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
          </button>
          <span className="sr-only" aria-live="polite">
            {isSaving ? "儲存中" : hasUnsavedChanges ? "有未儲存變更" : "已儲存"}
          </span>
        </div>
      ) : (
        <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-3" data-guide="editor-header">
          <button onClick={handleExitEditor} className="text-sm text-gray-500 hover:text-gray-700">
            ← 返回
          </button>
          <h1 className="text-lg font-bold">{template.name}</h1>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">模板編輯器</span>
          <span data-guide="template-photo-count" className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            <Camera className="h-3 w-3" />
            照片總計 {totalPhotoCount} 張
          </span>
          <div className="ml-auto flex items-center gap-2" data-guide="top-actions">
            <Button type="button" onClick={startEditorGuide} variant="secondary" size="sm">
              <CircleHelp className="h-4 w-4" />
              製作教學
            </Button>
            <span className="inline-flex items-center gap-2" data-guide="history-actions">
              <button type="button" onClick={undoLayout} disabled={!canUndo} aria-label="復原" title="復原 (Ctrl+Z)" className="inline-flex h-8 w-8 items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35">
                <Undo2 className="h-4 w-4" />
              </button>
              <button type="button" onClick={redoLayout} disabled={!canRedo} aria-label="重做" title="重做 (Ctrl+Y / Ctrl+Shift+Z)" className="inline-flex h-8 w-8 items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35">
                <Redo2 className="h-4 w-4" />
              </button>
            </span>
            <button type="button" onClick={handleOpenSpreadPreview} disabled={isSaving || template.pages.length === 0} data-guide="spread-preview" className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              <BookOpen className="h-4 w-4" />
              雙頁預覽
            </button>
            <button onClick={handleSaveLayout} disabled={isSaving || hasRepairableMaterialLinks} title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined} data-guide="save-template" data-dirty={hasUnsavedChanges ? "true" : "false"} className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
              {isSaving ? "儲存中..." : "儲存"}
              {hasUnsavedChanges && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
            </button>
          </div>
        </div>
      )}

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
          <div
            ref={viewportRef}
            style={{
              cursor: activeTool === "select" ? "default" : "crosshair",
              touchAction: isResponsiveCanvas ? "none" : undefined,
            }}
            className={`relative min-h-0 overflow-hidden border border-gray-300 bg-gray-100 select-none ${
              isResponsiveCanvas
                ? isPhoneEditor
                  ? "h-full w-full rounded-none border-x-0"
                  : "h-full w-full rounded"
                : "h-[752px] w-[532px] bg-white"
            }`}
            data-guide="editor-canvas-viewport"
            data-canvas-viewport={isResponsiveCanvas ? "responsive" : "desktop"}
          >
            <div className="absolute inset-0" data-guide="canvas-frame">
            {!isPhoneEditor && (
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
            )}
            {isResponsiveCanvas && (
              <div
                className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur"
                role="toolbar"
                aria-label="畫布縮放"
              >
                <button
                  type="button"
                  data-guide="zoom-out"
                  aria-label="縮小畫布"
                  disabled={!isCanvasCameraReady}
                  onClick={() => zoomAtPoint(cameraRef.current.zoom / CANVAS_ZOOM_STEP)}
                  className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                >
                  −
                </button>
                <span className="min-w-12 text-center text-xs font-medium text-gray-600" aria-live="polite">
                  {Math.round(activeCanvasCamera.zoom * 100)}%
                </span>
                <button
                  type="button"
                  data-guide="zoom-fit"
                  disabled={!isCanvasCameraReady}
                  onClick={fitToViewport}
                  className="inline-flex min-h-11 min-w-20 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
                >
                  適合畫面
                </button>
                <button
                  type="button"
                  data-guide="zoom-in"
                  aria-label="放大畫布"
                  disabled={!isCanvasCameraReady}
                  onClick={() => zoomAtPoint(cameraRef.current.zoom * CANVAS_ZOOM_STEP)}
                  className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                >
                  ＋
                </button>
              </div>
            )}
            <Stage
              ref={stageRef}
              width={canvasStageSize.width}
              height={canvasStageSize.height}
              onClick={handleStageClick}
              onTap={handleStageClick}
              onMouseDown={handleStagePointerDown}
              onMouseMove={(event) => {
                handleStagePointerMove(event);
                handleStageHoverMove(event);
              }}
              onMouseUp={handleStagePointerUp}
              onMouseLeave={() => setHoveredRef(null)}
              onTouchStart={handleStagePointerDown}
              onTouchMove={handleStageTouchMove}
              onTouchEnd={handleStageTouchEnd}
              onTouchCancel={handleStageTouchEnd}
              onDblClick={handleStageDoubleClick}
              onDblTap={handleStageDoubleClick}
            >
              <Layer>
                <KonvaGroup
                  ref={pageCameraRef}
                  id="page-camera"
                  x={activeCanvasCamera.viewX}
                  y={activeCanvasCamera.viewY}
                  scaleX={activeCanvasCamera.zoom}
                  scaleY={activeCanvasCamera.zoom}
                >
                  <KonvaGroup
                    clipX={0}
                    clipY={0}
                    clipWidth={CANVAS_DISPLAY_WIDTH}
                    clipHeight={CANVAS_DISPLAY_HEIGHT}
                  >
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
                  activeScopeCanvasNodes.map(renderActiveScopeNode)
                ) : (
                  <>
                    {passiveSceneBefore.map(renderPassiveLeaf)}
                    {activeScopeCanvasNodes.map(renderActiveScopeNode)}
                    {passiveSceneAfter.map(renderPassiveLeaf)}
                  </>
                )}

                {renderFooterNode(pageLayout?.footer)}

                {marqueeDisplayRect && (
                  <Rect
                    x={marqueeDisplayRect.x}
                    y={marqueeDisplayRect.y}
                    width={marqueeDisplayRect.width}
                    height={marqueeDisplayRect.height}
                    fill="rgba(79,70,229,0.08)"
                    stroke="#4F46E5"
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    dash={[5, 3]}
                    listening={false}
                  />
                )}
                  </KonvaGroup>
                </KonvaGroup>

                {/* Transformer：顯示縮放/旋轉把手 */}
                <Transformer
                  ref={transformerRef}
                  resizeEnabled={selectedRefs.length > 0 && canEditSelection}
                  keepRatio={selectedRefs.length > 1 || selectedElement?.type === "group"
                    || (selectedElement?.type === "photo" && isolationGroupId == null)}
                  flipEnabled={false}
                  rotateEnabled={selectedRefs.length > 0 && canEditSelection}
                  centeredScaling={selectedElement?.type === "group"}
                  onTransformStart={selectedRefs.length > 1 ? handleMultiTransformStart : undefined}
                  onTransformEnd={selectedRefs.length > 1 ? handleMultiTransformEnd : undefined}
                  borderStroke="#4F46E5"
                  borderStrokeWidth={1}
                  anchorFill="#4F46E5"
                  anchorStroke="#ffffff"
                  anchorStrokeWidth={1}
                  anchorSize={isResponsiveCanvas ? 14 : 8}
                  anchorStyleFunc={(anchor) => {
                    anchor.hitStrokeWidth(isResponsiveCanvas ? 44 : 10);
                  }}
                  rotateAnchorOffset={isResponsiveCanvas ? 28 : 20}
                  enabledAnchors={selectedRefs.length === 0 || !canEditSelection
                    ? []
                    : selectedRefs.length > 1 || selectedElement?.type === "group" || selectedElement?.type === "photo"
                    // 群組與照片格只留四角把手等比縮放；隔離中的貼圖/文字可自由改比例
                    ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                    : [
                      "top-left", "top-center", "top-right",
                      "middle-left", "middle-right",
                      "bottom-left", "bottom-center", "bottom-right",
                    ]}
                  boundBoxFunc={(oldBox, newBox) => {
                    const isShrinking = Math.abs(newBox.width) < Math.abs(oldBox.width)
                      || Math.abs(newBox.height) < Math.abs(oldBox.height);
                    const minimumScale = activeCanvasCamera.zoom;
                    if (isShrinking
                      && (Math.abs(newBox.width) < toDisplayCoord(60) * minimumScale
                        || Math.abs(newBox.height) < toDisplayCoord(40) * minimumScale)) {
                      return oldBox;
                    }
                    if (selectedRefs.length > 1
                      && Math.abs((newBox.rotation ?? 0) - (oldBox.rotation ?? 0)) < 1e-6) {
                      const resizeFactor = Math.min(
                        Math.abs(newBox.width / oldBox.width),
                        Math.abs(newBox.height / oldBox.height),
                      );
                      if (resizeFactor < 1 && resizeFactor < getMinimumMultiResizeFactor()) return oldBox;
                    }
                    return newBox;
                  }}
                />
              </Layer>
            </Stage>
            </div>
          </div>

          <p className="mt-1.5 hidden text-xs text-gray-400 md:block">
            提示：點選工具後在畫布上點擊放置；拖曳移動；四角拖曳調整大小；頂部圓點旋轉
          </p>
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
