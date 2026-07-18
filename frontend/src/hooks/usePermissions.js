// 權限判斷 Hook
// 依據當前使用者角色回傳各項操作的布林旗標

import { useCallback, useMemo } from "react";

import { useAuth } from "../context/AuthContext";
import {
  USER_ROLES,
  canUserCommentProject,
  canUserDownloadProject,
  canUserEditProject,
  canUserReadProject,
  canUserReopenProject,
  canUserViewSupervisorReports,
  getRolePermissions,
  isOrganizationPermissionsPending,
} from "../utils/userRoles";

export function usePermissions() {
  const { currentUser } = useAuth();
  const role = currentUser?.role ?? USER_ROLES.NONE;
  const currentUserId = currentUser?.id;
  const rolePermissions = getRolePermissions(role);
  const canViewReports = canUserViewSupervisorReports(currentUser);
  const isOrganizationPermissionsLoading = isOrganizationPermissionsPending(currentUser);

  const canEditProject = useCallback(
    (project) => canUserEditProject(role, currentUserId, project),
    [role, currentUserId],
  );
  const canDownloadProject = useCallback(
    (project) => canUserDownloadProject(role, project),
    [role],
  );
  const canReadProject = useCallback(
    (project) => canUserReadProject(role, project),
    [role],
  );
  const canReopenProject = useCallback(
    (project) => canUserReopenProject(role, project),
    [role],
  );
  const canCommentProject = useCallback(
    (project) => canUserCommentProject(role, project),
    [role],
  );

  return useMemo(
    () => ({
      ...rolePermissions,
      canViewReports,
      isOrganizationPermissionsLoading,
      canCommentProject,
      canDownloadProject,
      canEditProject,
      canReadProject,
      canReopenProject,
    }),
    [
      rolePermissions,
      canViewReports,
      isOrganizationPermissionsLoading,
      canCommentProject,
      canDownloadProject,
      canEditProject,
      canReadProject,
      canReopenProject,
    ],
  );
}
