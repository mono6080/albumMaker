import assert from "node:assert/strict";

import {
  ROLE_GROUPS,
  ROLE_LABELS,
  USER_ROLES,
  canUserCommentProject,
  canUserDownloadProject,
  canUserEditProject,
  canUserReadProject,
  canUserReopenProject,
  canUserViewSupervisorReports,
  getAssignableAccountLabel,
  getRolePermissions,
  isOrganizationPermissionsPending,
} from "../../src/utils/userRoles.js";
import { test } from "./harness.mjs";


test("role constants keep route access and labels stable", () => {
  assert.deepEqual(ROLE_GROUPS.TEMPLATE_MANAGERS, ["admin", "art_team"]);
  assert.deepEqual(ROLE_GROUPS.PROJECT_READERS, ["admin", "teacher", "supervisor", "art_team"]);
  assert.deepEqual(ROLE_GROUPS.PROJECT_EDITORS, ["admin", "teacher", "supervisor"]);
  assert.deepEqual(ROLE_GROUPS.ADMIN_ONLY, ["admin"]);
  assert.deepEqual(ROLE_LABELS, {
    admin: "管理員",
    art_team: "設計",
    supervisor: "主管",
    teacher: "帶班老師",
    none: "無權限",
  });
});


test("role permissions preserve the existing capability matrix", () => {
  assert.deepEqual(getRolePermissions(USER_ROLES.ADMIN), {
    isAdmin: true,
    isArtTeam: false,
    isSupervisor: false,
    isTeacher: false,
    canManageTemplates: true,
    canAccessProjects: true,
    canCreateProject: false,
    canDownloadPrint: true,
    canManageUsers: true,
    canViewReports: true,
  });
  assert.deepEqual(getRolePermissions(USER_ROLES.ART_TEAM), {
    isAdmin: false,
    isArtTeam: true,
    isSupervisor: false,
    isTeacher: false,
    canManageTemplates: true,
    canAccessProjects: true,
    canCreateProject: false,
    canDownloadPrint: false,
    canManageUsers: false,
    canViewReports: false,
  });
  assert.deepEqual(getRolePermissions(USER_ROLES.SUPERVISOR), {
    isAdmin: false,
    isArtTeam: false,
    isSupervisor: true,
    isTeacher: false,
    canManageTemplates: false,
    canAccessProjects: true,
    canCreateProject: false,
    canDownloadPrint: false,
    canManageUsers: false,
    canViewReports: false,
  });
  assert.deepEqual(getRolePermissions(USER_ROLES.TEACHER), {
    isAdmin: false,
    isArtTeam: false,
    isSupervisor: false,
    isTeacher: true,
    canManageTemplates: false,
    canAccessProjects: true,
    canCreateProject: false,
    canDownloadPrint: false,
    canManageUsers: false,
    canViewReports: false,
  });
  assert.equal(getRolePermissions("unknown"), getRolePermissions(USER_ROLES.NONE));
  assert.equal(getRolePermissions(USER_ROLES.ADMIN), getRolePermissions(USER_ROLES.ADMIN));
});


test("project edit permission only follows server object capability", () => {
  assert.equal(canUserEditProject(USER_ROLES.ADMIN, 1, {}), false);
  assert.equal(canUserEditProject(USER_ROLES.TEACHER, 7, { owner_id: 7 }), false);
  assert.equal(canUserEditProject(USER_ROLES.TEACHER, 7, {
    owner_id: 99,
    permissions: { can_edit: true },
  }), true);
});


test("server project capabilities have no role or owner fallback", () => {
  assert.equal(canUserEditProject(USER_ROLES.TEACHER, 7, {
    owner_id: 7,
    permissions: { can_edit: false },
  }), false);
  assert.equal(canUserEditProject(USER_ROLES.ART_TEAM, 7, {
    owner_id: 8,
    permissions: { can_edit: true },
  }), true);
  assert.equal(canUserReadProject(USER_ROLES.ADMIN, {
    permissions: { can_read: false },
  }), false);
  assert.equal(canUserReopenProject(USER_ROLES.TEACHER, {
    permissions: { can_reopen: true },
  }), true);
  assert.equal(canUserReopenProject(USER_ROLES.SUPERVISOR, {}), false);
  assert.equal(canUserReadProject(USER_ROLES.ART_TEAM, {}), false);
  assert.equal(canUserCommentProject(USER_ROLES.SUPERVISOR, {
    permissions: { can_comment: false },
  }), false);
  assert.equal(canUserCommentProject(USER_ROLES.TEACHER, {
    permissions: { can_comment: true },
  }), true);
});


test("project downloads follow server read capability instead of edit capability", () => {
  assert.equal(canUserDownloadProject(USER_ROLES.SUPERVISOR, {
    permissions: { can_read: true, can_edit: false },
  }), true);
  assert.equal(canUserDownloadProject(USER_ROLES.ART_TEAM, {
    permissions: { can_read: false, can_edit: true },
  }), false);
  assert.equal(canUserDownloadProject(USER_ROLES.ADMIN, {}), false);
});


test("assignable account labels make dual teacher and supervisor eligibility visible", () => {
  assert.equal(getAssignableAccountLabel({
    id: 7,
    display_name: "王老師",
    role: USER_ROLES.TEACHER,
  }), "王老師 · 帶班老師");
  assert.equal(getAssignableAccountLabel({
    id: 8,
    display_name: "林主任",
    role: USER_ROLES.SUPERVISOR,
  }), "林主任 · 主管");
});


test("supervisor report access follows active organization assignment capability", () => {
  assert.equal(canUserViewSupervisorReports({ role: USER_ROLES.ADMIN }), true);
  assert.equal(canUserViewSupervisorReports({ role: USER_ROLES.SUPERVISOR }), false);
  assert.equal(canUserViewSupervisorReports({
    role: USER_ROLES.TEACHER,
    organization_permissions: { can_view_supervisor_reports: true },
  }), true);
  assert.equal(isOrganizationPermissionsPending({ role: USER_ROLES.TEACHER }), true);
  assert.equal(isOrganizationPermissionsPending({
    role: USER_ROLES.SUPERVISOR,
    organization_permissions: { can_view_supervisor_reports: false },
  }), false);
});
