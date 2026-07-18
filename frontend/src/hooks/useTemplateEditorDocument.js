// 模板文件生命週期：載入、分頁草稿、明確儲存與 revision/CAS 同步。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

import { fetchTemplate, saveTemplatePages } from "../api/templateApi.js";
import { DESIGN_TOKENS } from "../constants/designTokens.js";
import {
  PHOTO_SLOT_CONTENT_BOX_MODE,
  PHOTO_SLOT_DIMENSION_MODE_KEY,
} from "../utils/photoFrameGeometry.js";
import { getVisibleLayoutElements } from "../utils/layoutLayerState.js";
import { validateLayoutGroups } from "../utils/layoutGroupContractGraph.js";
import { cloneLayout, getEditorPageKey } from "./useLayoutHistory.js";

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

export function buildTemplateSyncSuccessMessage(actionLabel, syncResult) {
  if (!syncResult || (syncResult.project_count ?? 0) === 0) return actionLabel;
  return `${actionLabel}，已同步 ${syncResult.project_count} 個專案、${syncResult.student_count ?? 0} 位學生`;
}

function countTemplatePhotoSlots(template, draftLayouts) {
  if (!template?.pages) return 0;
  return template.pages.reduce((total, page) => {
    const layout = draftLayouts[getEditorPageKey(page)] ?? page.layout;
    return total + getVisibleLayoutElements(layout, "photo").length;
  }, 0);
}

export default function useTemplateEditorDocument({
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
}) {
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(null);
  const templateRef = useRef(null);
  const persistedPageIdsRef = useRef([]);
  const pageStructureDirtyRef = useRef(false);

  useEffect(() => {
    templateRef.current = template;
  }, [template]);

  const applyPageDisplay = useCallback((page) => {
    setPageLayout(beginPageSession(page));
    setBackgroundUrl(
      page.id != null && page.background_filename
        ? `/api/templates/${templateId}/pages/${page.id}/background?t=${Date.now()}`
        : null,
    );
  }, [beginPageSession, setBackgroundUrl, setPageLayout, templateId]);

  const loadTemplate = useCallback(async () => {
    const response = await fetchTemplate(templateId);
    const nextTemplate = normalizeTemplateForEditor(response.data);
    templateRef.current = nextTemplate;
    persistedPageIdsRef.current = nextTemplate.pages.map(page => page.id);
    pageStructureDirtyRef.current = false;
    setTemplate(nextTemplate);
    return nextTemplate;
  }, [setTemplate, templateId]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  useEffect(() => {
    if (!template) return;
    const pages = template.pages;
    if (pages.length === 0) return;
    const nextPage = pages[Math.min(currentPageIndex, pages.length - 1)];
    const nextPageKey = getEditorPageKey(nextPage);
    if (String(activePageSessionIdRef.current) === String(nextPageKey)) return;
    cancelMaterialAnalysis();
    activePageSessionIdRef.current = nextPageKey;
    applyPageDisplay(nextPage);
    resetEditorView();
  }, [
    activePageSessionIdRef,
    applyPageDisplay,
    cancelMaterialAnalysis,
    currentPageIndex,
    resetEditorView,
    template,
  ]);

  const totalPhotoCount = useMemo(() => {
    // draftLayouts 是計數 SSOT；pageLayout 僅在目前頁草稿更新時觸發重算。
    void pageLayout;
    if (!template) return 0;
    return countTemplatePhotoSlots(template, draftLayouts.current);
  }, [draftLayouts, pageLayout, template]);
  const hasUnsavedChanges = pageStructureDirtyRef.current
    || Object.keys(draftLayouts.current).length > 0;

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
              savedLayout: page.layout,
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

  return {
    templateRef,
    isSaving,
    totalPhotoCount,
    hasUnsavedChanges,
    handleSaveLayout,
    handleAddPage,
    handleDeletePage,
  };
}
