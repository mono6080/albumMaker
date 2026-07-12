import { memo } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  CalendarClock,
  Check,
  Eye,
  MessageSquare,
  Pencil,
  RotateCcw,
  Users,
  X,
} from "lucide-react";
import {
  mobileVisibleHoverActionClass,
  mobileVisibleNamedHoverActionClass,
} from "./ResponsiveActionGroup";
import { Badge, Button, IconButton, Surface, fieldControlClass } from "./ui";

// ── 專案卡片（memo 化，只在自身資料變動時重渲染）────────────────────────────

const ProjectCard = memo(function ProjectCard({
  project,
  editingId,
  editingName,
  showOwner,
  canEditProject,
  onEditStart,
  onEditSave,
  onEditCancel,
  onEditNameChange,
  onDelete,
}) {
  const isEditing = editingId === project.id;
  const canEdit = canEditProject(project.owner_id);

  return (
    <Surface
      padding="none"
      className="group overflow-hidden transition-all hover:border-indigo-200 hover:shadow-md"
      data-guide="project-card"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div className="flex items-center gap-1 mb-1 min-w-0">
                <input
                  autoFocus
                  className={`${fieldControlClass} flex-1 py-1 font-semibold`}
                  value={editingName}
                  onChange={e => onEditNameChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") onEditSave(project.id);
                    if (e.key === "Escape") onEditCancel();
                  }}
                />
                <IconButton label="儲存專案名稱" variant="success" onClick={() => onEditSave(project.id)}>
                  <Check className="w-3.5 h-3.5" />
                </IconButton>
                <IconButton label="取消編輯專案名稱" onClick={onEditCancel}>
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            ) : (
              <div className="flex items-center gap-1 group/name min-w-0">
                <div className="font-semibold text-gray-900 text-lg truncate">{project.name}</div>
                {canEdit && (
                  <IconButton
                    label="編輯專案名稱"
                    onClick={() => onEditStart(project.id, project.name)}
                    variant="primary"
                    size="xs"
                    className={mobileVisibleNamedHoverActionClass}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </IconButton>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400 mt-0.5">
              <Users className="w-3 h-3" />
              {project.student_count} 位學生 · {new Date(project.created_at).toLocaleDateString("zh-TW")}
              {project.comment_count > 0 && (
                <>
                  <span className="text-gray-300">·</span>
                  <Link
                    to={`/projects/${project.id}/review`}
                    className="inline-flex items-center gap-0.5 font-medium text-violet-600 hover:text-violet-700"
                    title={`${project.comment_count} 則審閱意見，點擊查看`}
                  >
                    <MessageSquare className="w-3 h-3" />
                    {project.comment_count} 則審閱意見
                  </Link>
                </>
              )}
              {showOwner && project.owner_name && (
                <>
                  <span className="text-gray-300">·</span>
                  <span>{project.owner_name}</span>
                </>
              )}
              {project.template_period_name && (
                <>
                  <span className="text-gray-300">·</span>
                  <Badge tone="primary">
                    {project.department_label ? `${project.department_label} / ` : ""}
                    {project.template_period_name}
                  </Badge>
                </>
              )}
              {project.completed_at && (
                <Badge tone="success" title={`完成於 ${new Date(project.completed_at).toLocaleString("zh-TW")}`}>
                  ✓ 全班完成
                </Badge>
              )}
            </div>
          </div>
          {canEdit && (
            <IconButton
              label="封存專案"
              onClick={() => onDelete(project.id)}
              variant="neutral"
              className={mobileVisibleHoverActionClass}
            >
              <Archive className="w-4 h-4" />
            </IconButton>
          )}
        </div>
      </div>
      {/* 兩個入口：編輯（做內容）＋總覽（進度、名單與輸出） */}
      <div className={`border-t border-gray-100 grid divide-x divide-gray-100 ${canEdit ? "grid-cols-2" : "grid-cols-1"}`}>
        {canEdit && (
          <Link
            to={`/projects/${project.id}/edit`}
            data-guide="project-edit-link"
            className="min-w-0 flex items-center justify-center gap-1.5 px-2 py-2.5 text-sm text-indigo-600 font-medium hover:bg-indigo-50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
            編輯相本
          </Link>
        )}
        <Link
          to={`/projects/${project.id}/review`}
          data-guide="project-review-link"
          className="min-w-0 flex items-center justify-center gap-1.5 px-2 py-2.5 text-sm text-violet-600 font-medium hover:bg-violet-50 transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
          班級總覽
        </Link>
      </div>
    </Surface>
  );
});

// ── 封存專案列（memo 化；顯示剩餘可復原天數與復原按鈕）────────────────────────

export const ArchivedProjectRow = memo(function ArchivedProjectRow({
  project,
  showOwner,
  canEditProject,
  nowMs,
  onRestore,
  isRestoring,
}) {
  const expiresAt = project.archive_expires_at ? new Date(project.archive_expires_at) : null;
  const daysLeft = expiresAt
    ? Math.max(0, Math.ceil((expiresAt.getTime() - nowMs) / (24 * 60 * 60 * 1000)))
    : 0;

  return (
    <div className="grid grid-cols-1 gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="font-medium text-gray-900 truncate">{project.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
          <Users className="w-3 h-3" />
          {project.student_count} 位學生
          {showOwner && project.owner_name && (
            <>
              <span className="text-gray-300">·</span>
              <span>{project.owner_name}</span>
            </>
          )}
          <span className="text-gray-300">·</span>
          <CalendarClock className="w-3 h-3" />
          <span>{daysLeft} 天內可復原</span>
        </div>
      </div>
      {canEditProject(project.owner_id) && (
        <Button
          type="button"
          onClick={() => onRestore(project.id)}
          disabled={isRestoring}
          variant="successSoft"
          size="md"
        >
          <RotateCcw className="w-4 h-4" />
          {isRestoring ? "復原中" : "復原"}
        </Button>
      )}
    </div>
  );
});

export default ProjectCard;
