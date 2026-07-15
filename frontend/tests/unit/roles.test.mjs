import assert from "node:assert/strict";

import {
  ROLE_GROUPS,
  ROLE_LABELS,
  USER_ROLES,
  canUserEditProject,
  getRolePermissions,
} from "../../src/utils/userRoles.js";
import { test } from "./harness.mjs";


test("role constants keep route access and labels stable", () => {
  assert.deepEqual(ROLE_GROUPS.TEMPLATE_MANAGERS, ["admin", "art_team"]);
  assert.deepEqual(ROLE_GROUPS.PROJECT_READERS, ["admin", "teacher", "supervisor", "art_team"]);
  assert.deepEqual(ROLE_GROUPS.PROJECT_EDITORS, ["admin", "teacher", "supervisor"]);
  assert.deepEqual(ROLE_GROUPS.REPORT_VIEWERS, ["admin", "supervisor"]);
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
    canCreateProject: true,
    canDownloadPrint: true,
    canComment: true,
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
    canComment: true,
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
    canCreateProject: true,
    canDownloadPrint: false,
    canComment: true,
    canManageUsers: false,
    canViewReports: true,
  });
  assert.deepEqual(getRolePermissions(USER_ROLES.TEACHER), {
    isAdmin: false,
    isArtTeam: false,
    isSupervisor: false,
    isTeacher: true,
    canManageTemplates: false,
    canAccessProjects: true,
    canCreateProject: true,
    canDownloadPrint: false,
    canComment: false,
    canManageUsers: false,
    canViewReports: false,
  });
  assert.equal(getRolePermissions("unknown"), getRolePermissions(USER_ROLES.NONE));
  assert.equal(getRolePermissions(USER_ROLES.ADMIN), getRolePermissions(USER_ROLES.ADMIN));
});


test("project edit permission remains admin-or-owned teacher and supervisor", () => {
  assert.equal(canUserEditProject(USER_ROLES.ADMIN, 1, 999), true);
  assert.equal(canUserEditProject(USER_ROLES.TEACHER, 7, 7), true);
  assert.equal(canUserEditProject(USER_ROLES.TEACHER, 7, 8), false);
  assert.equal(canUserEditProject(USER_ROLES.SUPERVISOR, 9, 9), true);
  assert.equal(canUserEditProject(USER_ROLES.SUPERVISOR, 9, 10), false);
  assert.equal(canUserEditProject(USER_ROLES.ART_TEAM, 7, 7), false);
  assert.equal(canUserEditProject(USER_ROLES.NONE, 7, 7), false);
});
