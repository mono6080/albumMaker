import { apiClient } from "./authApi.js";

/** 取得分校、班級、目前名單與各期相本的管理總覽。 */
export const fetchOrganizationOverview = () =>
  apiClient.get("/organization/overview");

/** 建立分校。 */
export const createCampus = (params) =>
  apiClient.post("/organization/campuses", params);

/** 更新分校。 */
export const updateCampus = (campusId, params) =>
  apiClient.patch(`/organization/campuses/${campusId}`, params);

/** 以完整集合替換分校的全校與部門主管 scope。 */
export const updateCampusSupervisors = (campusId, params) =>
  apiClient.put(`/organization/campuses/${campusId}/supervisors`, params);

/** 建立班級。 */
export const createClassroom = (params) =>
  apiClient.post("/organization/classrooms", params);

/** 更新班級。 */
export const updateClassroom = (classroomId, params) =>
  apiClient.patch(`/organization/classrooms/${classroomId}`, params);

/** 重排一個學期內班級的顯示順序；必須送出該學期完整的班級集合。 */
export const reorderClassrooms = (semesterId, classroomIds) =>
  apiClient.put(`/organization/semesters/${semesterId}/classroom-order`, {
    classroom_ids: classroomIds,
  });

/** 移除編班草稿學期裡尚未使用的班級。 */
export const deleteClassroom = (classroomId) =>
  apiClient.delete(`/organization/classrooms/${classroomId}`);

/** 以完整清單更新班級目前老師編制；未列入者結束本次任教區間。 */
export const updateClassroomTeachers = (classroomId, teachers) =>
  apiClient.put(`/organization/classrooms/${classroomId}/teachers`, { teachers });

/** 取得目前登入老師可管理的班級。 */
export const fetchMyClassrooms = () =>
  apiClient.get("/organization/my-classrooms");

/** 批次加入班級目前名單。 */
export const batchAddClassroomMembers = (classroomId, members) =>
  apiClient.post(`/organization/classrooms/${classroomId}/members/batch`, { members });

/** 更新學生完整姓名、園所相本稱呼、在班狀態，或轉往另一班。 */
export const updateClassroomMember = (classroomId, memberId, params) =>
  apiClient.patch(`/organization/classrooms/${classroomId}/members/${memberId}`, params);

/** 移除草稿學期班級上的新生：整列刪掉，不是把在班區間結束掉。 */
export const deleteDraftClassroomMember = (classroomId, memberId) =>
  apiClient.delete(`/organization/classrooms/${classroomId}/members/${memberId}`);

/** 自動填入班級目前名單中尚未設定的園所相本稱呼。 */
export const autoFillClassroomMemberAlbumNames = (classroomId) =>
  apiClient.post(`/organization/classrooms/${classroomId}/members/album-names/auto-fill`);

/** 更新園所孩子身分的中央相本稱呼，供沒有名單區間的既有相本學生使用。 */
export const updateRosterChildAlbumName = (rosterChildId, albumName) =>
  apiClient.patch(`/organization/students/${rosterChildId}/album-name`, {
    album_name: albumName?.trim() || null,
  });

/** 只在園所孩子身分尚未設定稱呼時，自動填入可安全判斷的稱呼。 */
export const autoFillRosterChildAlbumName = (rosterChildId) =>
  apiClient.post(`/organization/students/${rosterChildId}/album-name/auto-fill`);

/** 以目前在班名單建立新一期相本快照。 */
export const createClassroomProject = (classroomId, params) =>
  apiClient.post(`/organization/classrooms/${classroomId}/projects`, params);

/** 轉交相本並留下負責人異動紀錄。 */
export const assignProjectOwner = (projectId, params) =>
  apiClient.post(`/projects/${projectId}/assignment`, params);

/** 取得相本完整負責人異動時間線。 */
export const fetchProjectAssignmentHistory = (projectId) =>
  apiClient.get(`/projects/${projectId}/assignment-history`);

/** 以目前全園狀態建立正式學期與編班草稿。 */
export const createTermReclassificationPlan = (label, options = {}) =>
  apiClient.post("/organization/term-reclassification-plans", {
    label,
    period_ids: options.periodIds ?? [],
    starts_on: options.startsOn || null,
    ends_on: options.endsOn || null,
  });

/** 取得園所正式學期主檔（管理介面使用）。 */
export const fetchSemesters = () =>
  apiClient.get("/organization/semesters");

/** 取得指定的新學期編班草稿或已套用結果。 */
export const fetchTermReclassificationPlan = (planId) =>
  apiClient.get(`/organization/term-reclassification-plans/${planId}`);

/** 以完整目標狀態取代編班草稿。 */
export const updateTermReclassificationPlan = (
  planId,
  expectedRevision,
  studentPlacements,
  classroomTeacherTargets,
) => apiClient.put(`/organization/term-reclassification-plans/${planId}`, {
  expected_revision: expectedRevision,
  student_placements: studentPlacements,
  classroom_teacher_targets: classroomTeacherTargets,
});

/** 驗證編班草稿並取得差異預覽，不改目前名單。 */
export const validateTermReclassificationPlan = (planId) =>
  apiClient.post(`/organization/term-reclassification-plans/${planId}/validate`);

/** 原子套用已驗證的編班草稿。 */
export const applyTermReclassificationPlan = (planId, expectedRevision) =>
  apiClient.post(`/organization/term-reclassification-plans/${planId}/apply`, {
    expected_revision: expectedRevision,
  });

/** 取消編班草稿，不改目前名單。 */
export const cancelTermReclassificationPlan = (planId) =>
  apiClient.post(`/organization/term-reclassification-plans/${planId}/cancel`);
