// API URL 建構工具
// 集中管理所有 API 路徑的 URL 建構函式，
// 避免各元件各自拼接字串，確保路徑格式一致

const API_BASE = "/api";
export const PREVIEW_RENDER_BUILD_VERSION =
  import.meta.env?.VITE_APP_BUILD_ID || "dev";

const appendCacheVersion = (url, version) =>
  version === undefined || version === null || version === ""
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;

const appendRenderBuildVersion = (url) =>
  `${url}${url.includes("?") ? "&" : "?"}render_build=${encodeURIComponent(PREVIEW_RENDER_BUILD_VERSION)}`;

/** 專案預覽的瀏覽器快取版本：內容時間戳 + 模板版本。 */
export const appendPreviewCacheVersion = (url, timestamp, templateRevision = null) => {
  const timestampedUrl = timestamp === undefined || timestamp === null || timestamp === ""
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(timestamp)}`;
  return templateRevision === undefined || templateRevision === null || templateRevision === ""
    ? timestampedUrl
    : `${timestampedUrl}${timestampedUrl.includes("?") ? "&" : "?"}template_revision=${encodeURIComponent(templateRevision)}`;
};

// ── 模板相關 URL ──────────────────────────────────────────────────────────────

/** 模板頁面背景圖的預覽端點 URL */
export const buildTemplatePagePreviewUrl = (templateId, pageId) =>
  appendRenderBuildVersion(`${API_BASE}/templates/${templateId}/pages/${pageId}/preview`);

/** 模板雙頁合併預覽端點 URL */
export const buildTemplateSpreadPreviewUrl = (templateId, startPageIndex) =>
  appendRenderBuildVersion(`${API_BASE}/templates/${templateId}/spread-preview/${startPageIndex}`);

/** 模板貼圖素材的存取 URL */
export const buildStickerUrl = (templateId, filename) =>
  `${API_BASE}/templates/${templateId}/stickers/${filename}`;

// ── 專案相關 URL ──────────────────────────────────────────────────────────────

/** 專案層級對應文字的頁面預覽端點 URL */
export const buildProjectPagePreviewUrl = (projectId, pageIndex) =>
  appendRenderBuildVersion(`${API_BASE}/projects/${projectId}/preview/${pageIndex}`);

/** 學生個人頁面的渲染預覽端點 URL；scale 供縮圖清單抓小尺寸（0.4-1.0） */
export const buildStudentPagePreviewUrl = (projectId, studentId, pageIndex, scale) =>
  appendRenderBuildVersion(
    `${API_BASE}/projects/${projectId}/students/${studentId}/preview/${pageIndex}${scale ? `?scale=${scale}` : ""}`,
  );

/** 學生個人照片的存取 URL */
export const buildPhotoUrl = (projectId, studentId, pageIndex, slotId, version) =>
  appendCacheVersion(
    `${API_BASE}/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}`,
    version,
  );

/** 學生個人照片縮圖的存取 URL */
export const buildPhotoThumbnailUrl = (projectId, studentId, pageIndex, slotId, version) =>
  appendCacheVersion(
    `${API_BASE}/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}/thumbnail`,
    version,
  );

/** 學生個人 PDF 下載 URL（含輸出模式）*/
export const buildDownloadPdfUrl = (projectId, studentId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/pdf?mode=${outputMode}`;

/** 學生個人單頁圖片 ZIP 下載 URL */
export const buildDownloadImagesZipUrl = (projectId, studentId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/images?mode=${outputMode}`;

/** 學生個人指定頁面的 JPG 下載 URL */
export const buildDownloadImageUrl = (projectId, studentId, pageNumber, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/images/${pageNumber}?mode=${outputMode}`;

/** 整個專案所有 PDF 打包下載 URL（含輸出模式）*/
export const buildDownloadAllZipUrl = (projectId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/download/all?mode=${outputMode}`;

/** 整個專案所有單頁圖片打包下載 URL */
export const buildDownloadAllImagesZipUrl = (projectId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/download/all/images?mode=${outputMode}`;
