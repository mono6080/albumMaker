// 正式學期彙整匯出與班級期別進度 API
// 學生、班級與期別狀態皆由後端正式學期契約提供，前端不自行推測。

import { apiClient } from "./authApi";

function appendReportScopeQuery(searchParams, filters) {
  searchParams.set("academic_term_id", String(filters.academicTermId));
  if (filters.department) searchParams.set("department", filters.department);
  if (filters.campusId) searchParams.set("campus_id", String(filters.campusId));
  if (filters.classroomId) searchParams.set("classroom_id", String(filters.classroomId));
  for (const periodId of filters.periodIds ?? []) {
    searchParams.append("period_ids", String(periodId));
  }
}

function buildReportQuery(filters) {
  const searchParams = new URLSearchParams();
  appendReportScopeQuery(searchParams, filters);
  return searchParams.toString();
}

/** 取得可用正式學期與其 ordered periods。 */
export const fetchAcademicTerms = ({ signal } = {}) =>
  apiClient.get("/roster/academic-terms", { signal });

/** 取得正式學期匯出預覽；孩子每一期狀態完全採後端 cells。 */
export const fetchSemesterExportPreview = (filters, { signal } = {}) =>
  apiClient.get(`/roster/semester-export?${buildReportQuery(filters)}`, { signal });

/** 啟動補渲染背景 job；rosterChildIds 不給代表目前預覽範圍全部。 */
export const renderMissingSemesterAlbums = ({
  academicTermId,
  periodIds,
  rosterChildIds = null,
}) => apiClient.post("/roster/semester-export/render-missing", {
  academic_term_id: academicTermId,
  period_ids: periodIds,
  roster_child_ids: rosterChildIds,
});

/** 查詢補渲染 job 進度。 */
export const fetchRenderMissingProgress = (jobId, { signal } = {}) =>
  apiClient.get(`/roster/semester-export/render-missing/${jobId}`, { signal });

/** 班級 × 期別老師進度；不接受舊版 owner 分組 payload。 */
export const fetchTeacherProgress = (academicTermId, { signal } = {}) =>
  apiClient.get(`/roster/teacher-progress?academic_term_id=${encodeURIComponent(academicTermId)}`, { signal });

/** 老師進度 Excel；校／部門／班級需與畫面篩選一致。 */
export const buildTeacherOverviewExcelUrl = (filters) => {
  const searchParams = new URLSearchParams();
  appendReportScopeQuery(searchParams, filters);
  searchParams.delete("period_ids");
  return `/api/roster/teacher-overview/export?${searchParams.toString()}`;
};

/** 學期 ZIP；孩子依校別／班級 snapshot 分類。 */
export const buildSemesterExportDownloadUrl = (
  filters,
  outputMode = "print",
  rosterChildIds = null,
) => {
  const searchParams = new URLSearchParams();
  appendReportScopeQuery(searchParams, filters);
  searchParams.set("mode", outputMode);
  for (const rosterChildId of rosterChildIds ?? []) {
    searchParams.append("roster_child_ids", String(rosterChildId));
  }
  return `/api/roster/semester-export/download?${searchParams.toString()}`;
};
