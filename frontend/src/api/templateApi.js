// 模板 API 模組
// 封裝所有與模板（Template）及模板頁面（TemplatePage）相關的 API 呼叫

// 使用統一的 Cookie 認證 apiClient（含 401 interceptor）
import { apiClient } from "./authApi.js";

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
const templateCache = new Map(); // templateId:revision -> { promise, expiresAt }
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;

/** fetchTemplate 的快取版：同模板、同版本 5 分鐘內共用同一次請求 */
export const fetchTemplateCached = (templateId, templateRevision = null) => {
  const cacheKey = `${templateId}:${templateRevision ?? "unversioned"}`;
  const cached = templateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetchTemplate(templateId)
    .then((response) => {
      // project GET 與 template GET 之間若剛好同步升版，不能把新版模板
      // 污染到舊 revision 的 cache key；呼叫端會重抓一致的一對資料。
      if (templateRevision != null && response.data?.revision !== templateRevision) {
        templateCache.delete(cacheKey);
      }
      return response;
    })
    .catch((error) => {
      templateCache.delete(cacheKey);
      throw error;
    });
  templateCache.set(cacheKey, { promise, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS });
  return promise;
};

const PROJECT_TEMPLATE_PAIR_MAX_ATTEMPTS = 3;

/**
 * 成對載入 project payload 與同 revision 的 live template。
 * selectProjectData 用於 student editor 的巢狀 project payload。
 */
export const fetchProjectTemplatePair = async (
  fetchProjectState,
  selectProjectData = (responseData) => responseData,
) => {
  for (let attempt = 0; attempt < PROJECT_TEMPLATE_PAIR_MAX_ATTEMPTS; attempt += 1) {
    const projectResponse = await fetchProjectState();
    const projectData = selectProjectData(projectResponse.data);
    const templateResponse = await fetchTemplateCached(
      projectData.template_id,
      projectData.template_revision,
    );
    if (templateResponse.data?.revision === projectData.template_revision) {
      return { projectResponse, projectData, templateResponse };
    }
  }
  const error = new Error("project and template revisions did not converge");
  error.code = "PROJECT_TEMPLATE_REVISION_MISMATCH";
  throw error;
};

/** 修改模板名稱（行內編輯） */
export const renameTemplate = (templateId, newName, periodId) =>
  apiClient.patch(`/templates/${templateId}`, toFormParams({ name: newName, period_id: periodId }));

/** 刪除指定模板 */
export const deleteTemplate = (templateId) =>
  apiClient.delete(`/templates/${templateId}`);

// ── 模板頁面 CRUD ─────────────────────────────────────────────────────────────

/**
 * 以單一 transaction 儲存模板的完整頁面快照。
 * 既有頁帶 id；尚未落盤的新頁帶 client_id，回應會保留 client_id 供前端換成正式 id。
 */
export const saveTemplatePages = (templateId, payload) =>
  apiClient.put(`/templates/${templateId}/pages`, payload);

// ── 背景圖 ────────────────────────────────────────────────────────────────────

/** 上傳模板頁面的背景圖 */
export const uploadBackground = (templateId, pageId, imageFile, expectedRevision) => {
  const formData = new FormData();
  formData.append("file", imageFile);
  return apiClient.post(
    `/templates/${templateId}/pages/${pageId}/background`,
    formData,
    { params: { expected_revision: expectedRevision } },
  );
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
