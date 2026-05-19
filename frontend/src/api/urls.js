// API URL 建構工具
// 集中管理所有 API 路徑的 URL 建構函式，
// 避免各元件各自拼接字串，確保路徑格式一致

const API_BASE = "/api";

// ── 模板相關 URL ──────────────────────────────────────────────────────────────

/** 模板頁面背景圖的預覽端點 URL */
export const buildTemplatePagePreviewUrl = (templateId, pageId) =>
  `${API_BASE}/templates/${templateId}/pages/${pageId}/preview`;

/** 模板雙頁合併預覽端點 URL */
export const buildTemplateSpreadPreviewUrl = (templateId, startPageIndex) =>
  `${API_BASE}/templates/${templateId}/spread-preview/${startPageIndex}`;

/** 模板貼圖素材的存取 URL */
export const buildStickerUrl = (templateId, filename) =>
  `${API_BASE}/templates/${templateId}/stickers/${filename}`;

// ── 專案相關 URL ──────────────────────────────────────────────────────────────

/** 專案層級對應文字的頁面預覽端點 URL */
export const buildProjectPagePreviewUrl = (projectId, pageIndex) =>
  `${API_BASE}/projects/${projectId}/preview/${pageIndex}`;

/** 學生個人頁面的渲染預覽端點 URL */
export const buildStudentPagePreviewUrl = (projectId, studentId, pageIndex) =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/preview/${pageIndex}`;

/** 學生個人照片的存取 URL */
export const buildPhotoUrl = (projectId, studentId, pageIndex, slotId) =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}`;

/** 學生個人照片縮圖的存取 URL */
export const buildPhotoThumbnailUrl = (projectId, studentId, pageIndex, slotId) =>
  `${buildPhotoUrl(projectId, studentId, pageIndex, slotId)}/thumbnail`;

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
