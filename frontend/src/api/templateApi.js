// 模板 API 模組
// 封裝所有與模板（Template）及模板頁面（TemplatePage）相關的 API 呼叫

// 使用統一的 Cookie 認證 apiClient（含 401 interceptor）
import { apiClient } from "./authApi";

// ── 模板 CRUD ─────────────────────────────────────────────────────────────────

const compactParams = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));

const toFormParams = (payload) => new URLSearchParams(compactParams(payload));

/** 取得固定部門清單 */
export const fetchTemplateDepartments = () =>
  apiClient.get("/templates/departments");

/** 取得模板期別清單 */
export const fetchTemplatePeriods = (params = {}) =>
  apiClient.get("/templates/periods", { params: compactParams(params) });

/** 建立模板期別 */
export const createTemplatePeriod = ({ name, department, status = "draft" }) =>
  apiClient.post("/templates/periods", toFormParams({ name, department, status }));

/** 更新模板期別 */
export const updateTemplatePeriod = (periodId, { name, status }) =>
  apiClient.patch(`/templates/periods/${periodId}`, toFormParams({ name, status }));

/** 取得所有模板清單 */
export const fetchAllTemplates = (params = {}) =>
  apiClient.get("/templates/", { params: compactParams(params) });

/** 取得可建立專案的模板清單（只含使用中期別） */
export const fetchAvailableTemplates = (params = {}) =>
  fetchAllTemplates({ ...params, available: true });

/** 建立新模板 */
export const createTemplate = (templateName, periodId, sourceTemplateId) =>
  apiClient.post(
    "/templates/",
    toFormParams({ name: templateName, period_id: periodId, source_template_id: sourceTemplateId })
  );

/** 取得指定模板的完整資料（含所有頁面） */
export const fetchTemplate = (templateId) =>
  apiClient.get(`/templates/${templateId}`);

/** 修改模板名稱（行內編輯） */
export const renameTemplate = (templateId, newName, periodId) =>
  apiClient.patch(`/templates/${templateId}`, toFormParams({ name: newName, period_id: periodId }));

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
