import assert from "node:assert/strict";

import { apiClient } from "../../src/api/authApi.js";
import {
  applyTermReclassificationPlan,
  assignProjectToClassroom,
  assignProjectOwner,
  autoFillClassroomMemberAlbumNames,
  autoFillRosterChildAlbumName,
  batchAddClassroomMembers,
  cancelTermReclassificationPlan,
  createCampus,
  createClassroom,
  createClassroomProject,
  createTermReclassificationPlan,
  fetchMyClassrooms,
  fetchAcademicTerms,
  fetchOrganizationOverview,
  fetchProjectClassroomMigrationPreview,
  fetchProjectAssignmentHistory,
  fetchTermReclassificationPlan,
  updateCampus,
  updateCampusSupervisors,
  updateClassroom,
  updateClassroomTeachers,
  updateClassroomMember,
  updateRosterChildAlbumName,
  updateTermReclassificationPlan,
  validateTermReclassificationPlan,
} from "../../src/api/organizationApi.js";
import { test } from "./harness.mjs";


test("organization API calls keep admin route and payload contracts stable", async () => {
  const originalGet = apiClient.get;
  const originalPost = apiClient.post;
  const originalPatch = apiClient.patch;
  const originalPut = apiClient.put;
  const calls = [];
  apiClient.get = async (...args) => { calls.push(["get", ...args]); return { data: {} }; };
  apiClient.post = async (...args) => { calls.push(["post", ...args]); return { data: {} }; };
  apiClient.patch = async (...args) => { calls.push(["patch", ...args]); return { data: {} }; };
  apiClient.put = async (...args) => { calls.push(["put", ...args]); return { data: {} }; };

  try {
    await fetchOrganizationOverview();
    await createCampus({ name: "總校", is_active: true });
    await updateCampus(3, { name: "東校" });
    await updateCampusSupervisors(3, {
      campus_supervisor_ids: [7],
      department_supervisors: [
        { department: "infant", supervisor_ids: [8] },
        { department: "academy", supervisor_ids: [] },
      ],
    });
    await createClassroom({ campus_id: 3, name: "星星班", department: "infant" });
    await updateClassroom(5, { name: "太陽班", department: "academy" });
    await updateClassroomTeachers(5, [
      { teacher_id: 12, duty: "lead" },
      { teacher_id: 14, duty: "co_teacher" },
    ]);
    await fetchMyClassrooms();
    await fetchAcademicTerms();
    await batchAddClassroomMembers(5, [{ name: "王小明" }]);
    await autoFillClassroomMemberAlbumNames(5);
    await updateClassroomMember(5, 7, { name: "王小明", album_name: "小明" });
    await updateRosterChildAlbumName(17, "  明明  ");
    await autoFillRosterChildAlbumName(17);
    await updateClassroomMember(5, 8, { status: "ended", end_reason: "departed" });
    await updateClassroomMember(5, 9, { target_classroom_id: 6 });
    await createClassroomProject(5, {
      name: "畢業相本",
      template_id: 11,
      owner_id: 12,
      work_slot_id: 19,
    });
    await fetchProjectClassroomMigrationPreview(13, 5);
    await assignProjectToClassroom(13, {
      classroom_id: 5,
      source_fingerprint: "preview-sha256",
      confirmed_all: true,
      seed_current_roster: true,
      student_identity_decisions: [
        { student_id: 21, action: "create_new" },
        { student_id: 22, action: "existing", roster_child_id: 31 },
      ],
    });
    await assignProjectOwner(13, { owner_id: 14, reason: "改由新老師負責" });
    await fetchProjectAssignmentHistory(13);
    await createTermReclassificationPlan("2026 上學期");
    await fetchTermReclassificationPlan(21);
    await updateTermReclassificationPlan(
      21,
      3,
      [{ source_member_id: 8, outcome: "classroom", target_classroom_id: 6 }],
      [{ classroom_id: 6, teachers: [{ teacher_id: 12, duty: "lead" }] }],
    );
    await validateTermReclassificationPlan(21);
    await applyTermReclassificationPlan(21, 4);
    await cancelTermReclassificationPlan(22);
  } finally {
    apiClient.get = originalGet;
    apiClient.post = originalPost;
    apiClient.patch = originalPatch;
    apiClient.put = originalPut;
  }

  assert.deepEqual(calls, [
    ["get", "/organization/overview"],
    ["post", "/organization/campuses", { name: "總校", is_active: true }],
    ["patch", "/organization/campuses/3", { name: "東校" }],
    ["put", "/organization/campuses/3/supervisors", {
      campus_supervisor_ids: [7],
      department_supervisors: [
        { department: "infant", supervisor_ids: [8] },
        { department: "academy", supervisor_ids: [] },
      ],
    }],
    ["post", "/organization/classrooms", { campus_id: 3, name: "星星班", department: "infant" }],
    ["patch", "/organization/classrooms/5", { name: "太陽班", department: "academy" }],
    ["put", "/organization/classrooms/5/teachers", { teachers: [
      { teacher_id: 12, duty: "lead" },
      { teacher_id: 14, duty: "co_teacher" },
    ] }],
    ["get", "/organization/my-classrooms"],
    ["get", "/organization/academic-terms"],
    ["post", "/organization/classrooms/5/members/batch", { members: [{ name: "王小明" }] }],
    ["post", "/organization/classrooms/5/members/album-names/auto-fill"],
    ["patch", "/organization/classrooms/5/members/7", { name: "王小明", album_name: "小明" }],
    ["patch", "/organization/roster-children/17/album-name", { album_name: "明明" }],
    ["post", "/organization/roster-children/17/album-name/auto-fill"],
    ["patch", "/organization/classrooms/5/members/8", { status: "ended", end_reason: "departed" }],
    ["patch", "/organization/classrooms/5/members/9", { target_classroom_id: 6 }],
    ["post", "/organization/classrooms/5/projects", {
      name: "畢業相本",
      template_id: 11,
      owner_id: 12,
      work_slot_id: 19,
    }],
    ["get", "/organization/projects/13/classroom-migration-preview", {
      params: { classroom_id: 5 },
    }],
    ["put", "/organization/projects/13/classroom", {
      classroom_id: 5,
      source_fingerprint: "preview-sha256",
      confirmed_all: true,
      seed_current_roster: true,
      student_identity_decisions: [
        { student_id: 21, action: "create_new" },
        { student_id: 22, action: "existing", roster_child_id: 31 },
      ],
    }],
    ["post", "/projects/13/assignment", { owner_id: 14, reason: "改由新老師負責" }],
    ["get", "/projects/13/assignment-history"],
    ["post", "/organization/term-reclassification-plans", {
      label: "2026 上學期",
      period_ids: [],
      starts_on: null,
      ends_on: null,
    }],
    ["get", "/organization/term-reclassification-plans/21"],
    ["put", "/organization/term-reclassification-plans/21", {
      expected_revision: 3,
      student_placements: [
        { source_member_id: 8, outcome: "classroom", target_classroom_id: 6 },
      ],
      classroom_teacher_targets: [
        { classroom_id: 6, teachers: [{ teacher_id: 12, duty: "lead" }] },
      ],
    }],
    ["post", "/organization/term-reclassification-plans/21/validate"],
    ["post", "/organization/term-reclassification-plans/21/apply", { expected_revision: 4 }],
    ["post", "/organization/term-reclassification-plans/22/cancel"],
  ]);
});
