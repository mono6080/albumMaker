// 使用者角色、權限群組與主管顯示的共用常數/helpers
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
  PROJECT_OWNER_EDITORS: Object.freeze([USER_ROLES.TEACHER, USER_ROLES.SUPERVISOR]),
  COMMENTERS: Object.freeze([
    USER_ROLES.ADMIN,
    USER_ROLES.ART_TEAM,
    USER_ROLES.SUPERVISOR,
  ]),
  REPORT_VIEWERS: Object.freeze([USER_ROLES.ADMIN, USER_ROLES.SUPERVISOR]),
  SUPERVISABLE: Object.freeze([USER_ROLES.TEACHER, USER_ROLES.SUPERVISOR]),
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
      canCreateProject: ROLE_GROUPS.PROJECT_EDITORS.includes(role),
      canDownloadPrint: role === USER_ROLES.ADMIN,
      canComment: ROLE_GROUPS.COMMENTERS.includes(role),
      canManageUsers: role === USER_ROLES.ADMIN,
      canViewReports: ROLE_GROUPS.REPORT_VIEWERS.includes(role),
    }),
  ]),
));

export function getRolePermissions(role) {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS[USER_ROLES.NONE];
}

export function canUserEditProject(role, currentUserId, ownerUserId) {
  return role === USER_ROLES.ADMIN || (
    ROLE_GROUPS.PROJECT_OWNER_EDITORS.includes(role)
    && currentUserId === ownerUserId
  );
}

export function canHaveSupervisor(userOrRole) {
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole?.role;
  return ROLE_GROUPS.SUPERVISABLE.includes(role);
}

export function getSupervisorIds(user) {
  return user.supervisor_ids ?? (user.supervisor_id ? [user.supervisor_id] : []);
}

export function getSupervisorNames(user) {
  return user.supervisor_names ?? (user.supervisor_name ? [user.supervisor_name] : []);
}

export function getSupervisorSummary(user) {
  const names = getSupervisorNames(user);
  if (names.length === 0) return "未指定";
  if (names.length <= 2) return names.join("、");
  return `${names.slice(0, 2).join("、")} +${names.length - 2}`;
}
