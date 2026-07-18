// 使用者角色、路由群組與後端 object permission 的共用常數/helpers
// 純模組供路由、權限 hook 與使用者管理共用。

export const USER_ROLES = Object.freeze({
  ADMIN: "admin",
  ART_TEAM: "art_team",
  SUPERVISOR: "supervisor",
  TEACHER: "teacher",
  NONE: "none",
});

export const ROLE_LABELS = Object.freeze({
  [USER_ROLES.ADMIN]: "管理員",
  [USER_ROLES.ART_TEAM]: "設計",
  [USER_ROLES.SUPERVISOR]: "主管",
  [USER_ROLES.TEACHER]: "帶班老師",
  [USER_ROLES.NONE]: "無權限",
});

export const ROLE_OPTIONS = [
  { value: USER_ROLES.ADMIN,      label: ROLE_LABELS[USER_ROLES.ADMIN] },
  { value: USER_ROLES.ART_TEAM,   label: ROLE_LABELS[USER_ROLES.ART_TEAM] },
  { value: USER_ROLES.SUPERVISOR, label: ROLE_LABELS[USER_ROLES.SUPERVISOR] },
  { value: USER_ROLES.TEACHER,    label: ROLE_LABELS[USER_ROLES.TEACHER] },
  { value: USER_ROLES.NONE,       label: ROLE_LABELS[USER_ROLES.NONE] },
];

export const ROLE_BADGE_STYLE = {
  [USER_ROLES.ADMIN]:      "bg-red-100 text-red-700",
  [USER_ROLES.ART_TEAM]:   "bg-violet-100 text-violet-700",
  [USER_ROLES.SUPERVISOR]: "bg-blue-100 text-blue-700",
  [USER_ROLES.TEACHER]:    "bg-emerald-100 text-emerald-700",
  [USER_ROLES.NONE]:       "bg-gray-100 text-gray-500",
};

export const ROLE_GROUPS = Object.freeze({
  ADMIN_ONLY: Object.freeze([USER_ROLES.ADMIN]),
  TEMPLATE_MANAGERS: Object.freeze([USER_ROLES.ADMIN, USER_ROLES.ART_TEAM]),
  PROJECT_READERS: Object.freeze([
    USER_ROLES.ADMIN,
    USER_ROLES.TEACHER,
    USER_ROLES.SUPERVISOR,
    USER_ROLES.ART_TEAM,
  ]),
  PROJECT_EDITORS: Object.freeze([
    USER_ROLES.ADMIN,
    USER_ROLES.TEACHER,
    USER_ROLES.SUPERVISOR,
  ]),
});

const ROLE_PERMISSIONS = Object.freeze(Object.fromEntries(
  Object.values(USER_ROLES).map((role) => [
    role,
    Object.freeze({
      isAdmin: role === USER_ROLES.ADMIN,
      isArtTeam: role === USER_ROLES.ART_TEAM,
      isSupervisor: role === USER_ROLES.SUPERVISOR,
      isTeacher: role === USER_ROLES.TEACHER,
      canManageTemplates: ROLE_GROUPS.TEMPLATE_MANAGERS.includes(role),
      canAccessProjects: ROLE_GROUPS.PROJECT_READERS.includes(role),
      // 建立相本是班級物件權限，不存在全域角色型建立入口。
      canCreateProject: false,
      canDownloadPrint: role === USER_ROLES.ADMIN,
      canManageUsers: role === USER_ROLES.ADMIN,
      // 非管理員的報表能力由校／部門主管指派提供。
      canViewReports: role === USER_ROLES.ADMIN,
    }),
  ]),
));

export function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS[USER_ROLES.NONE];
}

export function canUserEditProject(_role, _currentUserId, project) {
  return project?.permissions?.can_edit === true;
}

export function canUserReadProject(_role, project) {
  return project?.permissions?.can_read === true;
}

// PDF／圖片下載端點只要求 object read capability；產生新檔仍由 can_edit 控制。
export function canUserDownloadProject(_role, project) {
  return project?.permissions?.can_read === true;
}

export function canUserReopenProject(_role, project) {
  return project?.permissions?.can_reopen === true;
}

export function canUserCommentProject(_role, project) {
  return project?.permissions?.can_comment === true;
}

export function canUserViewSupervisorReports(user) {
  return user?.role === USER_ROLES.ADMIN
    || user?.organization_permissions?.can_view_supervisor_reports === true;
}

export function isOrganizationPermissionsPending(user) {
  return [USER_ROLES.TEACHER, USER_ROLES.SUPERVISOR].includes(user?.role)
    && user.organization_permissions === undefined;
}

export function getAssignableAccountLabel(user) {
  const displayName = user?.display_name ?? user?.username ?? `使用者 #${user?.id}`;
  const roleLabel = ROLE_LABELS[user?.role];
  return roleLabel ? `${displayName} · ${roleLabel}` : displayName;
}
