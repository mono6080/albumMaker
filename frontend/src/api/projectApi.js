// 專案 API 模組
// 封裝所有與專案（Project）、學生（Student）、
// 照片、對應文字、渲染及下載相關的 API 呼叫

// 使用統一的 Cookie 認證 axios clients（含 401 interceptor）
import { apiClient, renderClient } from "./authApi.js";

// ── 專案 CRUD ─────────────────────────────────────────────────────────────────

/** 取得所有專案清單 */
export const fetchAllProjects = () =>
  apiClient.get("/projects/");

/** 取得 30 天內可復原的封存專案 */
export const fetchArchivedProjects = () =>
  apiClient.get("/projects/archive");

/** 取得指定專案的完整資料（含所有學生） */
export const fetchProject = (projectId) =>
  apiClient.get(`/projects/${projectId}`);

/** 個別編輯器資料：目前學生含完整 pages_data，其餘學生只回切換器摘要。 */
export const fetchStudentEditor = (projectId, studentId) =>
  apiClient.get(`/projects/${projectId}/students/${studentId}/editor`);

/** 修改專案名稱（行內編輯） */
export const renameProject = (projectId, newName) =>
  apiClient.patch(`/projects/${projectId}`, new URLSearchParams({ name: newName }));

/** 刪除指定專案 */
export const deleteProject = (projectId) =>
  apiClient.delete(`/projects/${projectId}`);

/** 復原封存專案 */
export const restoreProject = (projectId) =>
  apiClient.post(`/projects/${projectId}/restore`);

/** 標記全班完成（內容鎖定，需主管或 admin 退回） */
export const completeProject = (projectId) =>
  apiClient.post(`/projects/${projectId}/complete`);

/** 退回全班完成標記（限管轄主管或 admin） */
export const reopenProject = (projectId) =>
  apiClient.post(`/projects/${projectId}/reopen`);

// ── 本期學生快照 ──────────────────────────────────────────────────────────────

/** 設定或取消學生某頁的跳過旗標 */
export const setStudentPageSkip = (projectId, expectedTemplateRevision, studentId, pageIndex, skip) =>
  apiClient.patch(
    `/projects/${projectId}/students/${studentId}/pages/${pageIndex}/skip`,
    { skip },
    { params: { expected_template_revision: expectedTemplateRevision } },
  );

// ── 照片管理 ──────────────────────────────────────────────────────────────────

// 上傳需涵蓋檔案傳輸 + 伺服器逐張解碼壓縮，15 秒的 apiClient 預設不夠用
const UPLOAD_TIMEOUT_MS = 120000;

/** 上傳學生照片至指定頁面欄位，onProgress(0~100) 可選 */
export const uploadPhoto = (
  projectId, expectedTemplateRevision, studentId, pageIndex, slotId, photoFile, onProgress,
) => {
  const formData = new FormData();
  formData.append("file", photoFile);
  return apiClient.post(
    `/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}`,
    formData,
    {
      timeout: UPLOAD_TIMEOUT_MS,
      params: { expected_template_revision: expectedTemplateRevision },
      ...(onProgress ? { onUploadProgress: e => onProgress(Math.round(e.loaded * 100 / (e.total || 1))) } : {}),
    }
  );
};

/** 上傳專案共用照片，套用到所有學生同一頁同一照片格 */
export const uploadSharedProjectPhoto = (
  projectId, expectedTemplateRevision, pageIndex, slotId, photoFile, onProgress,
) => {
  const formData = new FormData();
  formData.append("file", photoFile);
  return apiClient.post(
    `/projects/${projectId}/photos/shared/pages/${pageIndex}/slots/${slotId}`,
    formData,
    {
      timeout: UPLOAD_TIMEOUT_MS,
      params: { expected_template_revision: expectedTemplateRevision },
      ...(onProgress ? { onUploadProgress: e => onProgress(Math.round(e.loaded * 100 / (e.total || 1))) } : {}),
    }
  );
};

/**
 * 批次照片分配上傳。
 *   assignments: [{ studentId, file }]
 *   options: { overwriteExisting?: boolean }
 *   onProgress(percent): 整體上傳進度 0~100
 * 回傳格式：{ ok, page_index, slot_id, succeeded[], failed[], skipped[] }
 */
export const batchUploadPhotos = (
  projectId, expectedTemplateRevision, pageIndex, slotId,
  assignments,
  options = {},
  onProgress,
) => {
  const formData = new FormData();
  const mapping = {};
  assignments.forEach(({ studentId, file }) => {
    formData.append("files", file);
    mapping[String(studentId)] = file.name;
  });
  formData.append("mapping", JSON.stringify(mapping));
  formData.append("overwrite_existing", String(options.overwriteExisting ?? true));
  return apiClient.post(
    `/projects/${projectId}/photos/batch/pages/${pageIndex}/slots/${slotId}`,
    formData,
    {
      timeout: UPLOAD_TIMEOUT_MS,
      params: { expected_template_revision: expectedTemplateRevision },
      ...(onProgress
        ? { onUploadProgress: e => onProgress(Math.round(e.loaded * 100 / (e.total || 1))) }
        : {}),
    },
  );
};

/**
 * 更新照片欄位對應關係（支援重新排列與清除）。
 * pagesMapping 格式：{"0": {"1": "/path", "2": null}, ...}
 */
export const updatePhotoMapping = (projectId, expectedTemplateRevision, studentId, pagesMapping) =>
  apiClient.put(
    `/projects/${projectId}/students/${studentId}/photos/mapping`,
    { pages: pagesMapping },
    { params: { expected_template_revision: expectedTemplateRevision } },
  );

// ── 對應文字 ──────────────────────────────────────────────────────────────────

/** 更新專案層級的對應文字設定（signal 供自動儲存取消過時請求） */
export const updateProjectLabelTexts = (projectId, expectedTemplateRevision, labelTextsPayload, signal) =>
  apiClient.put(`/projects/${projectId}/label_texts`, labelTextsPayload, {
    signal,
    params: { expected_template_revision: expectedTemplateRevision },
  });

/** 批次更新多位學生的對應文字（signal 供自動儲存取消過時請求） */
export const batchUpdateStudentTexts = (projectId, expectedTemplateRevision, studentsPayload, signal) =>
  apiClient.put(`/projects/${projectId}/batch/texts`, studentsPayload, {
    signal,
    params: { expected_template_revision: expectedTemplateRevision },
  });

// ── 渲染 ──────────────────────────────────────────────────────────────────────

/** 渲染單一學生的相冊並儲存為 PDF */
export const renderStudent = (projectId, studentId) =>
  renderClient.post(`/projects/${projectId}/students/${studentId}/render`);
