// 名冊與學期彙整匯出 API 模組（admin 專用）
// 封裝孩子名冊配對（連結/合併）與學期匯出（預覽、ZIP 下載）呼叫

import { apiClient } from "./authApi";

// FastAPI 的 list query 參數格式為重複 key（period_ids=1&period_ids=2）
const buildPeriodIdsQuery = (periodIds) =>
  periodIds.map(periodId => `period_ids=${encodeURIComponent(periodId)}`).join("&");

/** 取得學期匯出預覽（依名冊孩子分組 + 待確認學生清單） */
export const fetchSemesterExportPreview = (periodIds) =>
  apiClient.get(`/roster/semester-export?${buildPeriodIdsQuery(periodIds)}`);

/** 把學生連到既有名冊項 */
export const linkStudentToRosterChild = (studentId, rosterChildId) =>
  apiClient.put(`/roster/students/${studentId}/link`, { roster_child_id: rosterChildId });

/** 為學生建立全新名冊項（同名不同人的拆分） */
export const linkStudentToNewRosterChild = (studentId) =>
  apiClient.put(`/roster/students/${studentId}/link`, { create_new: true });

/** 把一個名冊項的所有學生併入另一個名冊項（改名/誤拆修正） */
export const mergeRosterChildren = (sourceChildId, targetChildId) =>
  apiClient.post(`/roster/children/${sourceChildId}/merge/${targetChildId}`);

/** 啟動補渲染背景 job（立即回傳 job_id）；rosterChildIds 不給代表全部 */
export const renderMissingSemesterAlbums = (periodIds, rosterChildIds = null) =>
  apiClient.post("/roster/semester-export/render-missing", {
    period_ids: periodIds,
    roster_child_ids: rosterChildIds,
  });

/** 查詢補渲染 job 進度（status / done / total / rendered / errors） */
export const fetchRenderMissingProgress = (jobId) =>
  apiClient.get(`/roster/semester-export/render-missing/${jobId}`);

/** 老師進度總覽（含尚未建專案的老師與照片/文字完成度；supervisor 限管轄老師） */
export const fetchTeacherProgress = (periodIds) =>
  apiClient.get(`/roster/teacher-progress?${buildPeriodIdsQuery(periodIds)}`);

/** 老師進度 Excel 下載 URL（摘要 + 明細；supervisor 只含管轄老師） */
export const buildTeacherOverviewExcelUrl = (periodIds) =>
  `/api/roster/teacher-overview/export?${buildPeriodIdsQuery(periodIds)}`;

/** 學期匯出 ZIP 下載 URL（班級/孩子/序號_期別-專案.pdf）；rosterChildIds 不給代表全部 */
export const buildSemesterExportDownloadUrl = (periodIds, outputMode = "print", rosterChildIds = null) => {
  const childIdsQuery = rosterChildIds
    ? rosterChildIds.map(childId => `&roster_child_ids=${encodeURIComponent(childId)}`).join("")
    : "";
  return `/api/roster/semester-export/download?${buildPeriodIdsQuery(periodIds)}&mode=${outputMode}${childIdsQuery}`;
};
