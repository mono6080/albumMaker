// 專案 API 模組
// 封裝所有與專案（Project）、學生（Student）、
// 照片、氣泡文字、渲染及下載相關的 API 呼叫

// 使用統一含 Bearer token interceptor 的 apiClient
import { apiClient } from "./authApi";

// ── 專案 CRUD ─────────────────────────────────────────────────────────────────

/** 取得所有專案清單 */
export const fetchAllProjects = () =>
  apiClient.get("/projects/");

/** 建立新專案 */
export const createProject = (projectName, templateId) =>
  apiClient.post("/projects/", new URLSearchParams({ name: projectName, template_id: templateId }));

/** 取得指定專案的完整資料（含所有學生） */
export const fetchProject = (projectId) =>
  apiClient.get(`/projects/${projectId}`);

/** 修改專案名稱（行內編輯） */
export const renameProject = (projectId, newName) =>
  apiClient.patch(`/projects/${projectId}`, new URLSearchParams({ name: newName }));

/** 刪除指定專案 */
export const deleteProject = (projectId) =>
  apiClient.delete(`/projects/${projectId}`);

// ── 學生管理 ──────────────────────────────────────────────────────────────────

/** 批次新增多位學生（自動略過空白與重複名稱） */
export const batchAddStudents = (projectId, studentNames) =>
  apiClient.post(`/projects/${projectId}/students/batch`, studentNames);

/** 更新學生姓名 */
export const renameStudent = (projectId, studentId, newName) =>
  apiClient.put(
    `/projects/${projectId}/students/${studentId}`,
    new URLSearchParams({ name: newName })
  );

/** 刪除指定學生 */
export const deleteStudent = (projectId, studentId) =>
  apiClient.delete(`/projects/${projectId}/students/${studentId}`);

// ── 照片管理 ──────────────────────────────────────────────────────────────────

/** 上傳學生照片至指定頁面欄位 */
export const uploadPhoto = (projectId, studentId, pageIndex, slotId, photoFile) => {
  const formData = new FormData();
  formData.append("file", photoFile);
  return apiClient.post(
    `/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}`,
    formData
  );
};

/**
 * 更新照片欄位對應關係（支援重新排列與清除）。
 * pagesMapping 格式：{"0": {"1": "/path", "2": null}, ...}
 */
export const updatePhotoMapping = (projectId, studentId, pagesMapping) =>
  apiClient.put(
    `/projects/${projectId}/students/${studentId}/photos/mapping`,
    { pages: pagesMapping }
  );

// ── 氣泡文字 ──────────────────────────────────────────────────────────────────

/** 取得專案層級的氣泡文字設定 */
export const fetchProjectBubbleTexts = (projectId) =>
  apiClient.get(`/projects/${projectId}/bubble_texts`);

/** 更新專案層級的氣泡文字設定 */
export const updateProjectBubbleTexts = (projectId, bubbleTextsPayload) =>
  apiClient.put(`/projects/${projectId}/bubble_texts`, bubbleTextsPayload);

/** 批次更新多位學生的氣泡文字 */
export const batchUpdateStudentTexts = (projectId, studentsPayload) =>
  apiClient.put(`/projects/${projectId}/batch/texts`, studentsPayload);

// ── 渲染 ──────────────────────────────────────────────────────────────────────

/** 渲染單一學生的相冊並儲存為 PDF */
export const renderStudent = (projectId, studentId) =>
  apiClient.post(`/projects/${projectId}/students/${studentId}/render`);

/** 批次渲染專案中所有學生的相冊 */
export const renderAllStudents = (projectId) =>
  apiClient.post(`/projects/${projectId}/render/all`);

export default apiClient;
