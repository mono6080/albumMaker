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

// 相本編輯器切學生/切頁時模板都不變：短 TTL 快取省掉每次重抓
// （模板 JSON 含全部版面可達數百 KB）。模板編輯器要看最新內容，仍用 fetchTemplate。
const templateCache = new Map(); // templateId -> { promise, expiresAt }
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;

/** fetchTemplate 的快取版：同模板 5 分鐘內共用同一次請求 */
export const fetchTemplateCached = (templateId) => {
  const cached = templateCache.get(templateId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetchTemplate(templateId).catch((error) => {
    templateCache.delete(templateId);
    throw error;
  });
  templateCache.set(templateId, { promise, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS });
  return promise;
};

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

/**
 * 以單一 transaction 儲存模板的完整頁面快照。
 * 既有頁帶 id；尚未落盤的新頁帶 client_id，回應會保留 client_id 供前端換成正式 id。
 */
export const saveTemplatePages = (templateId, payload) =>
  apiClient.put(`/templates/${templateId}/pages`, payload);

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

/** 分析目前貼圖內容，回傳可直接建立／重設文字框的正規化建議。 */
export const suggestMaterialTextBox = (
  templateId,
  pageId,
  { stickerId, path, sourceRevision = null, requestToken },
  { signal } = {},
) => apiClient.post(
  `/templates/${templateId}/pages/${pageId}/material-text-box-suggestion`,
  {
    sticker_id: stickerId,
    path,
    source_revision: sourceRevision,
    request_token: requestToken,
  },
  { signal },
);

export default apiClient;
