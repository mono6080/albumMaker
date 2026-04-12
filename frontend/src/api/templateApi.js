// 模板 API 模組
// 封裝所有與模板（Template）及模板頁面（TemplatePage）相關的 API 呼叫

// 使用統一含 Bearer token interceptor 的 apiClient
import { apiClient } from "./authApi";

// ── 模板 CRUD ─────────────────────────────────────────────────────────────────

/** 取得所有模板清單 */
export const fetchAllTemplates = () =>
  apiClient.get("/templates/");

/** 建立新模板 */
export const createTemplate = (templateName) =>
  apiClient.post("/templates/", new URLSearchParams({ name: templateName }));

/** 取得指定模板的完整資料（含所有頁面） */
export const fetchTemplate = (templateId) =>
  apiClient.get(`/templates/${templateId}`);

/** 修改模板名稱（行內編輯） */
export const renameTemplate = (templateId, newName) =>
  apiClient.patch(`/templates/${templateId}`, new URLSearchParams({ name: newName }));

/** 刪除指定模板 */
export const deleteTemplate = (templateId) =>
  apiClient.delete(`/templates/${templateId}`);

// ── 模板頁面 CRUD ─────────────────────────────────────────────────────────────

/** 在模板末尾新增一頁 */
export const addTemplatePage = (templateId) =>
  apiClient.post(`/templates/${templateId}/pages`);

/** 更新模板頁面的佈局 JSON */
export const updatePageLayout = (templateId, pageId, layoutData) =>
  apiClient.put(`/templates/${templateId}/pages/${pageId}/layout`, layoutData);

/** 刪除指定模板頁面 */
export const deleteTemplatePage = (templateId, pageId) =>
  apiClient.delete(`/templates/${templateId}/pages/${pageId}`);

// ── 背景圖 ────────────────────────────────────────────────────────────────────

/** 上傳模板頁面的背景圖 */
export const uploadBackground = (templateId, pageId, imageFile) => {
  const formData = new FormData();
  formData.append("file", imageFile);
  return apiClient.post(`/templates/${templateId}/pages/${pageId}/background`, formData);
};

// ── 貼圖素材 ──────────────────────────────────────────────────────────────────

/** 上傳貼圖素材至指定模板 */
export const uploadSticker = (templateId, stickerFile) => {
  const formData = new FormData();
  formData.append("file", stickerFile);
  return apiClient.post(`/templates/${templateId}/stickers`, formData);
};

export default apiClient;
