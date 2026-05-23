// API 向後相容匯出
// 舊版各頁面從 "../api" 引入的函式名稱，
// 現統一由 api/ 子模組提供，此檔僅作為相容橋接層

export {
  // 模板 API
  fetchAllTemplates as getTemplates,
  fetchAvailableTemplates,
  fetchTemplateDepartments,
  fetchTemplatePeriods,
  createTemplatePeriod,
  updateTemplatePeriod,
  createTemplate,
  fetchTemplate as getTemplate,
  renameTemplate,
  deleteTemplate,
  addTemplatePage,
  updatePageLayout,
  uploadBackground,
  uploadSticker,
  deleteTemplatePage,
} from "./api/templateApi";

export {
  // 專案 API
  fetchAllProjects as getProjects,
  fetchArchivedProjects,
  createProject,
  fetchProject as getProject,
  renameProject,
  deleteProject,
  restoreProject,

  // 學生 API
  batchAddStudents,
  renameStudent,
  deleteStudent,

  // 照片 API
  uploadPhoto,
  updatePhotoMapping,

  // 對應文字 API
  fetchProjectLabelTexts as getProjectLabelTexts,
  updateProjectLabelTexts,
  batchUpdateStudentTexts as batchUpdateTexts,

  // 渲染 API
  renderStudent,
  renderAllStudents as renderAll,
} from "./api/projectApi";

export {
  // URL 建構函式（保留舊名稱）
  buildStickerUrl as stickerUrl,
  buildProjectPagePreviewUrl as projectPreviewUrl,
  buildStudentPagePreviewUrl as previewUrl,
  buildPhotoThumbnailUrl as photoThumbnailUrl,
  buildDownloadPdfUrl as downloadPdf,
  buildDownloadImagesZipUrl as downloadImagesZip,
  buildDownloadAllZipUrl as downloadAllZip,
  buildDownloadAllImagesZipUrl as downloadAllImagesZip,
  buildTemplatePagePreviewUrl as templatePagePreviewUrl,
  buildTemplateSpreadPreviewUrl as templateSpreadPreviewUrl,
} from "./api/urls";
