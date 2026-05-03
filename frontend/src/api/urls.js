// API URL 建構工具
// 集中管理所有 API 路徑的 URL 建構函式，
// 避免各元件各自拼接字串，確保路徑格式一致

const API_BASE = "/api";

// ── 模板相關 URL ──────────────────────────────────────────────────────────────

/** 模板頁面背景圖的預覽端點 URL */
export const buildTemplatePagePreviewUrl = (templateId, pageId) =>
  `${API_BASE}/templates/${templateId}/pages/${pageId}/preview`;

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

/** 學生個人 PDF 下載 URL（含輸出模式）*/
export const buildDownloadPdfUrl = (projectId, studentId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/students/${studentId}/pdf?mode=${outputMode}`;

/** 整個專案所有 PDF 打包下載 URL（含輸出模式）*/
export const buildDownloadAllZipUrl = (projectId, outputMode = "print") =>
  `${API_BASE}/projects/${projectId}/download/all?mode=${outputMode}`;
