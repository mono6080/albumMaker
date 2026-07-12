// 使用者角色與主管顯示的共用常數/helpers
// 由 UserManagement 頁與 UserList 元件共用（獨立成純模組，元件檔依 react-refresh 規則不混出函式）

export const ROLE_OPTIONS = [
  { value: "admin",      label: "管理員" },
  { value: "art_team",   label: "設計" },
  { value: "supervisor", label: "主管" },
  { value: "teacher",    label: "帶班老師" },
  { value: "none",       label: "無權限" },
];

export const ROLE_BADGE_STYLE = {
  admin:      "bg-red-100 text-red-700",
  art_team:   "bg-violet-100 text-violet-700",
  supervisor: "bg-blue-100 text-blue-700",
  teacher:    "bg-emerald-100 text-emerald-700",
  none:       "bg-gray-100 text-gray-500",
};

const SUPERVISABLE_ROLES = new Set(["teacher", "supervisor"]);

export function canHaveSupervisor(userOrRole) {
  const role = typeof userOrRole === "string" ? userOrRole : userOrRole?.role;
  return SUPERVISABLE_ROLES.has(role);
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
