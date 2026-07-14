// 模板編輯器頁面（Konva Canvas 版）
// 以 Konva.js (Canvas 2D) 取代 CSS div 渲染，提高與 PIL 後端輸出的視覺一致性
// 分工：per-page 草稿/歷史在 hooks/useLayoutHistory、Konva 節點渲染在
// components/canvas/pageElementNodes、雙頁預覽與圖層清單為獨立 component

import { Fragment, useEffect, useRef, useState, useCallback } from "react";
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
import { BookOpen, Camera, CircleHelp, Redo2, SlidersHorizontal, Undo2 } from "lucide-react";

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
import SelectionQuickActions from "../components/SelectionQuickActions";
import ConfirmModal from "../components/ConfirmModal";
import SpreadPreviewModal from "../components/SpreadPreviewModal";
import { Button } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import useEditorStylePreferences from "../hooks/useEditorStylePreferences";
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
  getPhotoFrameInsets,
  getPhotoSlotDimensionMode,
  PHOTO_SLOT_CONTENT_BOX_MODE,
  PHOTO_SLOT_DIMENSION_MODE_KEY,
  snapPhotoSlotStandardRatio,
} from "../utils/photoFrameGeometry.js";
import { DESIGN_TOKENS } from "../constants/designTokens.js";
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
  createLayoutClipboard,
  duplicateLayoutNodes,
  pasteLayoutNodes,
} from "../utils/layoutDuplication.js";
import {
  getLayoutNodeData,
  getNodeLayerState,
  getVisibleLayoutElementOrdinals,
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

function getEditorPageKey(page) {
  return page?.editorKey ?? (page?.id == null ? null : `page:${page.id}`);
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
  return (
    <div
      role="status"
      className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      data-guide="template-project-impact"
    >
      此模板已套用於 {projectCount} 個專案、{studentCount} 位學生；按下儲存後，變更會同步套用。
      {completedProjectCount > 0 && ` 其中 ${completedProjectCount} 個專案已完成，既有輸出會標記為需重新產生。`}
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
  const [totalPhotoCount, setTotalPhotoCount] = useState(0);
  const [inspectorTab, setInspectorTab] = useState("layers");

  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const stickerFileInputRef = useRef(null);
  const pageLayoutRef = useRef(null);
  const editorViewRef = useRef({ isolationPath: [], selectedRefs: [] });
  const activeCanvasGestureRef = useRef(null);
  const analysisRequestRef = useRef(null);
  const activePageSessionIdRef = useRef(null);
  const suppressNextStageClickRef = useRef(false);
  const layoutClipboardRef = useRef(null);
  const clipboardPasteCountRef = useRef(0);
  const multiTransformSnapshotRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const templateRef = useRef(null);
  const persistedPageIdsRef = useRef([]);
  const pageStructureDirtyRef = useRef(false);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(pageLayout);
  const isolationGroupId = isolationPath.length ? isolationPath[isolationPath.length - 1] : null;
  const selectedElement = selectedRefs.length === 1 ? selectedRefs[0] : null;

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
  const hasUnsavedChanges = pageStructureDirtyRef.current
    || Object.keys(draftLayouts.current).length > 0;

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
        const state = getNodeLayerState(pageLayout, ref);
        return state.isVisible && !state.isLocked;
      })
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

  const getElement = useCallback(({ type, id }, layout = pageLayout) => {
    if (!layout) return null;
    if (type === "photo")   return (layout.photo_slots || []).find(slot => String(slot.id) === String(id));
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

  const handleCanvasSelectElement = useCallback((elementRef, options = {}) => {
    setInspectorTab("properties");
    handleSelectElement(elementRef, options);
  }, [handleSelectElement]);

  const handleCanvasSelectGroup = useCallback((groupId, options = {}) => {
    setInspectorTab("properties");
    handleSelectGroup(groupId, options);
  }, [handleSelectGroup]);

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
    const canGroupSelection = selectedRefs.every(ref => {
      const state = getNodeLayerState(pageLayout, ref);
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
  }, [commitPageLayout, isolationGroupId, pageLayout, selectedRefs]);

  const handleUngroup = useCallback((groupId) => {
    const group = getGroupById(pageLayout, groupId);
    if (!group) return;
    if (getNodeLayerState(pageLayout, { type: "group", id: groupId }).isLocked) {
      toast.error("請先解除鎖定再解除群組");
      return;
    }
    try {
      commitPageLayout(currentLayout => ungroupElements(currentLayout, groupId));
      setSelectedRefs(group.children.map(child => ({ ...child })));
    } catch (error) {
      toast.error(error?.message || "無法解除群組");
    }
  }, [commitPageLayout, pageLayout]);

  const updateElement = (elementType, elementId, propertyUpdates, commitOptions) => {
    const elementRef = { type: elementType, id: elementId };
    if (getNodeLayerState(pageLayoutRef.current, elementRef).isLocked) return;
    const arrayKey = ELEMENT_ARRAY_KEY[elementType];
    commitPageLayout(currentLayout => ({
      ...currentLayout,
      [arrayKey]: (currentLayout[arrayKey] || []).map(
        element => String(element.id) === String(elementId) ? { ...element, ...propertyUpdates } : element
      ),
    }), commitOptions);
  };

  const updatePhotoElementFromEditor = (elementId, propertyUpdates, commitOptions) => {
    if (getNodeLayerState(pageLayoutRef.current, { type: "photo", id: elementId }).isLocked) return;
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
    const editableRefs = selectedRefs.filter(ref => !getNodeLayerState(pageLayout, ref).isLocked);
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
  }, [commitPageLayout, pageLayout, selectedRefs]);

  const handleLayerChange = useCallback((direction) => {
    if (!selectedElement) return;
    if (getNodeLayerState(pageLayout, selectedElement).isLocked) {
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
  }, [commitPageLayout, isolationGroupId, pageLayout, selectedElement]);

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
      const state = getNodeLayerState(pageLayout, ref);
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
  }, [commitPageLayout, isolationGroupId, pageLayout, selectedRefs]);

  const handleCopySelection = useCallback(() => {
    const clipboard = createLayoutClipboard(pageLayout, selectedRefs, {
      operation: "copy",
      sourcePageId: getEditorPageKey(currentPage),
    });
    if (!clipboard) return;
    layoutClipboardRef.current = clipboard;
    clipboardPasteCountRef.current = 0;
    toast.success(`已複製 ${selectedRefs.length} 個物件`);
  }, [currentPage, pageLayout, selectedRefs]);

  const handleCutSelection = useCallback(() => {
    const editableRefs = selectedRefs.filter(ref => {
      const state = getNodeLayerState(pageLayout, ref);
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
      setSelectedRefs(currentRefs => currentRefs.filter(
        ref => !editableRefs.some(item => sameRef(item, ref)),
      ));
      toast.success(`已剪下 ${editableRefs.length} 個物件`);
    } catch (error) {
      toast.error(error?.message || "無法剪下選取物件");
    }
  }, [commitPageLayout, currentPage, pageLayout, selectedRefs]);

  const handlePasteSelection = useCallback(() => {
    const clipboard = layoutClipboardRef.current;
    if (!clipboard) return;
    if (isolationGroupId != null) {
      const targetGroupState = getNodeLayerState(pageLayout, { type: "group", id: isolationGroupId });
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
  }, [commitPageLayout, currentPage, isolationGroupId, pageLayout]);

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
        bounds: ref.type === "group" ? getNodeBounds(pageLayoutRef.current, ref) : null,
      }];
    });
    if (entries.length < 2) return;
    multiTransformSnapshotRef.current = { entries };
    beginCanvasGesture("multi-transform");
  }, [beginCanvasGesture, selectedRefs]);

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
    const shouldHide = selectedRefs.every(ref => getNodeLayerState(pageLayout, ref).isVisible);
    commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => (
      updateLayoutNodeMetadata(nextLayout, ref, { visible: !shouldHide })
    ), currentLayout));
  }, [commitPageLayout, pageLayout, selectedRefs]);

  const handleToggleSelectedLock = useCallback(() => {
    const shouldLock = selectedRefs.every(ref => getNodeLayerState(pageLayout, ref).isLocked);
    commitPageLayout(currentLayout => selectedRefs.reduce((nextLayout, ref) => (
      updateLayoutNodeMetadata(nextLayout, ref, { locked: !shouldLock })
    ), currentLayout));
  }, [commitPageLayout, pageLayout, selectedRefs]);

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
        if (String(activePageSessionIdRef.current) !== String(request.pageKey)) return baseLayout;
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
    setInspectorTab("properties");
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

  const handleStageHoverMove = useCallback((event) => {
    if (activeTool !== "select" || activeCanvasGestureRef.current || !pageLayout) {
      setHoveredRef(null);
      return;
    }

    const hitRef = getCanvasElementRefFromTarget(event.target, event.target?.getStage?.());
    const directRef = hitRef?.type === "group"
      ? getScopeNodes(pageLayout, isolationGroupId).find(ref => sameRef(ref, hitRef)) ?? null
      : resolveHitToDirectChild(pageLayout, isolationGroupId, hitRef);
    setHoveredRef(current => (sameRef(current, directRef) ? current : directRef));
  }, [activeTool, isolationGroupId, pageLayout]);

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
      setInspectorTab("properties");
      setSelectedElement({ type: "photo", id: newSlot.id });
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
      setInspectorTab("properties");
      setSelectedElement({ type: "text", id: newTextLabel.id });
      return;
    }

    // 選取模式：點擊空白處取消選取
    if (e.target === stageRef.current && !e.evt?.shiftKey) {
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
              className="rounded border border-indigo-200 bg-white px-4 py-2 text-indigo-700 disabled:opacity-50"
            >
              {isSaving ? "儲存中..." : "儲存"}
            </button>
          )}
        </div>
      </div>
    );
  }

  const rootRenderNodes = buildRootRenderNodes(pageLayout, {
    onWarning: warning => console.warn("[TemplateEditor] invalid layout groups; using flat render", warning),
  });
  const visibleRootRenderNodes = buildRootRenderNodes(pageLayout, {
    visibleOnly: true,
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
  const activeScopeCanvasNodes = activeScopeRefs
    .map(ref => findRenderNode(visibleRootRenderNodes, ref))
    .filter(Boolean);
  const flattenedSceneLeaves = flattenRenderNodes(visibleRootRenderNodes, { visibleOnly: true });
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
    label: getGroupById(pageLayout, groupId)?.layer_name || `群組 ${index + 1}`,
    data: getGroupById(pageLayout, groupId),
  }));
  const sortedPageElements = getAllElementsSorted(pageLayout);
  const visiblePhotoOrdinals = getVisibleLayoutElementOrdinals(pageLayout, "photo");
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
  const selectedLayerStates = selectedRefs.map(ref => getNodeLayerState(pageLayout, ref));
  const isSelectionVisible = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isVisible);
  const isSelectionLocked = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isLocked);
  const canEditSelection = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isVisible && !state.isLocked);
  const selectedSingleLayerState = selectedElement
    ? getNodeLayerState(pageLayout, selectedElement)
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
    const leafRefs = ref.type === "group" ? getDescendantLeafRefs(pageLayout, ref.id) : [ref];
    const scaleX = Math.max(Number.EPSILON, Math.abs(targetNode.scaleX()));
    const scaleY = Math.max(Number.EPSILON, Math.abs(targetNode.scaleY()));
    return leafRefs.reduce((leafMinimum, leafRef) => {
      const leafData = getLayoutNodeData(pageLayout, leafRef);
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
      || (group == null && getNodeLayerState(pageLayout, elementRef).isLocked);
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
    const groupLayerState = getNodeLayerState(pageLayout, groupRef);
    const isSelected = isRefSelected(groupRef);
    const isHovered = !groupLayerState.isLocked && isRefHovered(groupRef);
    const bounds = getNodeBounds(pageLayout, { type: "group", id: group.id });
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
    <div className="mx-auto flex w-full max-w-[1042px] flex-col lg:-mx-4 lg:w-auto xl:mx-auto xl:w-full">
      {confirmDialog}
      {spreadPreviewOpen && (
        <SpreadPreviewModal
          templateId={templateId}
          pageCount={template.pages.length}
          initialPageIndex={currentPageIndex}
          onClose={() => setSpreadPreviewOpen(false)}
        />
      )}
      {/* 頂部標題列 */}
      <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-3" data-guide="editor-header">
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
          <button
            onClick={handleSaveLayout}
            disabled={isSaving || hasRepairableMaterialLinks}
            title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined}
            data-guide="save-template"
            className="inline-flex items-center gap-1.5 px-4 py-1 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "儲存中..." : (
              <>
                儲存
                {hasUnsavedChanges && (
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                )}
              </>
            )}
          </button>
        </div>
      </div>

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

      {/* 三欄主體 */}
      <div className="flex flex-wrap gap-2 lg:flex-nowrap xl:gap-4">
        {/* 左側工具欄 */}
        <div className="flex w-36 flex-shrink-0 flex-col gap-4 lg:w-40" style={{ maxHeight: CANVAS_DISPLAY_HEIGHT }}>
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
              <label
                data-guide="upload-background"
                title={currentPage?.id == null ? "請先儲存新增頁面" : undefined}
                onClick={(event) => {
                  if (currentPage?.id != null) return;
                  event.preventDefault();
                  toast.error("請先儲存新增頁面，再上傳背景");
                }}
                className={`px-3 py-1.5 rounded text-sm text-left border bg-white text-gray-700 border-gray-200 transition-colors ${
                  currentPage?.id == null
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-gray-50"
                }`}
              >
                {currentPage?.id == null ? "↑ 上傳背景（先儲存）" : "↑ 上傳背景"}
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
                  key={getEditorPageKey(templatePage)}
                  onClick={() => {
                    setInspectorTab("layers");
                    setCurrentPageIndex(pageTabIndex);
                  }}
                  className={`px-3 py-1.5 rounded text-sm text-left border transition-colors ${
                    currentPageIndex === pageTabIndex
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200"
                  }`}
                >
                  <span>第 {pageTabIndex + 1} 頁</span>
                  {templatePage.id == null && (
                    <span aria-hidden="true" className="ml-1.5 text-[10px] opacity-80">●</span>
                  )}
                </button>
              ))}
              <button
                onClick={handleAddPage}
                disabled={isSaving}
                data-guide="add-page"
                className="rounded border border-dashed border-gray-300 px-3 py-1.5 text-left text-sm text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ＋ 新增頁
              </button>
            </div>
            <button
              onClick={handleDeletePage}
              disabled={isSaving}
              className="mt-2 rounded border border-red-200 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              刪除此頁
            </button>
          </div>
        </div>

        {/* 中央畫布區 */}
        <div className="flex-shrink-0 flex flex-col">
          <div
            style={{ cursor: activeTool === "select" ? "default" : "crosshair" }}
            className="relative border border-gray-300 rounded overflow-hidden bg-white select-none"
            data-guide="canvas-frame"
          >
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
            />
            <Stage
              ref={stageRef}
              width={CANVAS_DISPLAY_WIDTH}
              height={CANVAS_DISPLAY_HEIGHT}
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
                  activeScopeCanvasNodes.map(renderActiveScopeNode)
                ) : (
                  <>
                    {passiveSceneBefore.map(renderPassiveLeaf)}
                    {activeScopeCanvasNodes.map(renderActiveScopeNode)}
                    {passiveSceneAfter.map(renderPassiveLeaf)}
                  </>
                )}

                {renderFooterNode(pageLayout?.footer)}

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
                  anchorSize={8}
                  rotateAnchorOffset={20}
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
                    if (isShrinking
                      && (Math.abs(newBox.width) < toDisplayCoord(60)
                        || Math.abs(newBox.height) < toDisplayCoord(40))) {
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

        {/* 右側：固定屬性／圖層檢查器 */}
        <EditorInspector
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
              onRenameLayer={handleRenameLayer}
              onToggleVisibility={handleToggleLayerVisibility}
              onToggleLock={handleToggleLayerLock}
              onReorderLayer={handleReorderLayer}
            />
          )}
        />
      </div>
    </div>
  );
}
