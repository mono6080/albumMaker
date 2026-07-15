// 權限判斷 Hook
// 依據當前使用者角色回傳各項操作的布林旗標

import { useCallback, useMemo } from "react";

import { useAuth } from "../context/AuthContext";
import {
  USER_ROLES,
  canUserEditProject,
  getRolePermissions,
} from "../utils/userRoles";

export function usePermissions() {
  const { currentUser } = useAuth();
  const role = currentUser?.role ?? USER_ROLES.NONE;
  const currentUserId = currentUser?.id;
  const rolePermissions = getRolePermissions(role);

  const canEditProject = useCallback(
    (ownerUserId) => canUserEditProject(role, currentUserId, ownerUserId),
    [role, currentUserId],
  );

  return useMemo(
    () => ({ ...rolePermissions, canEditProject }),
    [rolePermissions, canEditProject],
  );
}
