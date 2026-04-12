import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// Templates
export const getTemplates = () => api.get("/templates/");
export const createTemplate = (name) => api.post("/templates/", new URLSearchParams({ name }));
export const getTemplate = (id) => api.get(`/templates/${id}`);
export const deleteTemplate = (id) => api.delete(`/templates/${id}`);
export const renameTemplate = (id, name) => api.patch(`/templates/${id}`, new URLSearchParams({ name }));
export const addTemplatePage = (templateId) => api.post(`/templates/${templateId}/pages`);
export const updatePageLayout = (templateId, pageId, layout) =>
  api.put(`/templates/${templateId}/pages/${pageId}/layout`, layout);
export const uploadBackground = (templateId, pageId, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return api.post(`/templates/${templateId}/pages/${pageId}/background`, fd);
};
export const uploadSticker = (templateId, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return api.post(`/templates/${templateId}/stickers`, fd);
};
export const stickerUrl = (templateId, filename) =>
  `/api/templates/${templateId}/stickers/${filename}`;
export const deleteTemplatePage = (templateId, pageId) =>
  api.delete(`/templates/${templateId}/pages/${pageId}`);

// Projects
export const getProjects = () => api.get("/projects/");
export const createProject = (name, templateId) =>
  api.post("/projects/", new URLSearchParams({ name, template_id: templateId }));
export const getProject = (id) => api.get(`/projects/${id}`);
export const deleteProject = (id) => api.delete(`/projects/${id}`);
export const renameProject = (id, name) => api.patch(`/projects/${id}`, new URLSearchParams({ name }));
export const renameStudent = (projectId, studentId, name) =>
  api.put(`/projects/${projectId}/students/${studentId}`, new URLSearchParams({ name }));

// Students
export const batchAddStudents = (projectId, names) =>
  api.post(`/projects/${projectId}/students/batch`, names);
export const deleteStudent = (projectId, studentId) =>
  api.delete(`/projects/${projectId}/students/${studentId}`);

// Photos
export const uploadPhoto = (projectId, studentId, pageIndex, slotId, file) => {
  const fd = new FormData();
  fd.append("file", file);
  return api.post(`/projects/${projectId}/students/${studentId}/pages/${pageIndex}/photos/${slotId}`, fd);
};
export const updatePhotoMapping = (projectId, studentId, pages) =>
  api.put(`/projects/${projectId}/students/${studentId}/photos/mapping`, { pages });

// Project-level bubble texts
export const getProjectBubbleTexts = (projectId) =>
  api.get(`/projects/${projectId}/bubble_texts`);
export const updateProjectBubbleTexts = (projectId, payload) =>
  api.put(`/projects/${projectId}/bubble_texts`, payload);
export const projectPreviewUrl = (projectId, pageIndex) =>
  `${api.defaults.baseURL}/projects/${projectId}/preview/${pageIndex}`;

// Per-student texts
export const updateBubbleTexts = (projectId, studentId, pageIndex, texts) =>
  api.put(`/projects/${projectId}/students/${studentId}/pages/${pageIndex}/texts`, texts);
export const batchUpdateTexts = (projectId, payload) =>
  api.put(`/projects/${projectId}/batch/texts`, payload);

// Render
export const renderStudent = (projectId, studentId) =>
  api.post(`/projects/${projectId}/students/${studentId}/render`);
export const renderAll = (projectId) =>
  api.post(`/projects/${projectId}/render/all`);
export const downloadPdf = (projectId, studentId, mode = "print") =>
  `${api.defaults.baseURL}/projects/${projectId}/students/${studentId}/pdf?mode=${mode}`;
export const downloadAllZip = (projectId, mode = "print") =>
  `${api.defaults.baseURL}/projects/${projectId}/download/all?mode=${mode}`;
export const previewUrl = (projectId, studentId, pageIndex) =>
  `${api.defaults.baseURL}/projects/${projectId}/students/${studentId}/preview/${pageIndex}`;
export const templatePagePreviewUrl = (templateId, pageId) =>
  `${api.defaults.baseURL}/templates/${templateId}/pages/${pageId}/preview`;

export default api;
