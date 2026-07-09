// 名冊與學期彙整匯出 API 模組（admin 專用）
// 封裝孩子名冊配對（連結/合併）與學期匯出（預覽、ZIP 下載）呼叫

import { apiClient, renderClient } from "./authApi";

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

/** 批次補渲染缺列印 PDF 的相冊；rosterChildIds 不給代表全部。渲染耗時，timeout 放寬到 10 分鐘 */
export const renderMissingSemesterAlbums = (periodIds, rosterChildIds = null) =>
  renderClient.post(
    "/roster/semester-export/render-missing",
    { period_ids: periodIds, roster_child_ids: rosterChildIds },
    { timeout: 600000 },
  );

/** 學期匯出 ZIP 下載 URL（班級/孩子/序號_期別-專案.pdf）；rosterChildIds 不給代表全部 */
export const buildSemesterExportDownloadUrl = (periodIds, outputMode = "print", rosterChildIds = null) => {
  const childIdsQuery = rosterChildIds
    ? rosterChildIds.map(childId => `&roster_child_ids=${encodeURIComponent(childId)}`).join("")
    : "";
  return `/api/roster/semester-export/download?${buildPeriodIdsQuery(periodIds)}&mode=${outputMode}${childIdsQuery}`;
};
