import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { usePermissions } from "./usePermissions";

/**
 * 相本編輯頁的擁有權守衛。
 *
 * 路由守衛只擋角色、擋不了擁有權：非 owner（如別班主管）直接輸入網址
 * 會看到可編輯 UI 但每次寫入都被後端 403，這裡直接轉去唯讀的班級總覽。
 *
 * ClassEdit 與 StudentEdit 共用同一個判準；新增可編輯的相本頁必須也掛上它，
 * 否則會重現「看得到編輯 UI、每次寫入 403」。
 */
export function useProjectEditGuard(project, projectId) {
  const navigate = useNavigate();
  const { canEditProject } = usePermissions();
  useEffect(() => {
    if (!project) return;
    if (!canEditProject(project)) {
      toast.error("你沒有此專案的編輯權限，已切到班級總覽");
      navigate(`/projects/${projectId}/review`, { replace: true });
    }
  }, [project, canEditProject, navigate, projectId]);
}
