// 權限判斷 Hook
// 依據當前使用者角色回傳各項操作的布林旗標

import { useAuth } from "../context/AuthContext";

export function usePermissions() {
  const { currentUser } = useAuth();
  const role = currentUser?.role ?? "none";

  return {
    /** 是否為管理員 */
    isAdmin: role === "admin",

    /** 可管理模板（建立、編輯、刪除） */
    canManageTemplates: role === "admin" || role === "art_team",

    /** 可建立新專案 */
    canCreateProject: role === "admin" || role === "teacher",

    /** 可編輯指定專案（需傳入 owner_id 判斷所有權） */
    canEditProject: (ownerUserId) =>
      role === "admin" || (role === "teacher" && currentUser?.id === ownerUserId),

    /** 可下載完整畫質 PDF（僅 admin） */
    canDownloadPrint: role === "admin",

    /** 可留下審閱意見 */
    canComment: role === "admin" || role === "art_team" || role === "supervisor",

    /** 可管理使用者帳號 */
    canManageUsers: role === "admin",
  };
}
