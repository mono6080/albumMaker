import { Link } from "react-router-dom";
import { BookOpen, Check, Images, Pencil, Trash2, X } from "lucide-react";
import {
  mobileVisibleHoverActionClass,
  mobileVisibleNamedHoverActionClass,
} from "./ResponsiveActionGroup";
import { Badge, Button, FormField, IconButton, Surface, fieldControlClass } from "./ui";
import { statusTone } from "../utils/periodStatus";

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("zh-TW");
}

// ── 模板卡片（名稱行內編輯、期別搬移、刪除與編輯入口）────────────────────────

export default function TemplateCard({
  template,
  periods,
  editingId,
  editingName,
  onEditStart,
  onEditSave,
  onEditCancel,
  onEditNameChange,
  onDelete,
  onMovePeriod,
}) {
  return (
    <Surface
      className="group overflow-hidden transition-all hover:border-indigo-200 hover:shadow-md"
      padding="none"
      data-guide="template-card"
    >
      <div className="p-5">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-500">
            <BookOpen className="h-4 w-4" />
          </div>
          <IconButton
            label="刪除模板"
            onClick={event => onDelete(template.id, event)}
            variant="danger"
            className={mobileVisibleHoverActionClass}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>

        {editingId === template.id ? (
          <div className="mb-2 flex min-w-0 items-center gap-1">
            <input
              autoFocus
              className={`${fieldControlClass} flex-1 py-1 font-semibold`}
              value={editingName}
              onChange={event => onEditNameChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") onEditSave(template.id);
                if (event.key === "Escape") onEditCancel();
              }}
            />
            <IconButton label="儲存模板名稱" variant="success" onClick={() => onEditSave(template.id)}>
              <Check className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label="取消編輯模板名稱" onClick={onEditCancel}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ) : (
          <div className="mb-2 flex min-w-0 items-center gap-1 group/name">
            <span className="truncate font-semibold text-gray-900">{template.name}</span>
            <IconButton
              label="編輯模板名稱"
              onClick={() => onEditStart(template.id, template.name)}
              variant="primary"
              size="xs"
              className={mobileVisibleNamedHoverActionClass}
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-gray-400" data-guide="template-card-counts">
          <Badge tone={statusTone(template.period_status)}>{template.period_status_label || "未分類"}</Badge>
          <span>{template.page_count} 頁</span>
          <span className="text-gray-300">·</span>
          <span className="inline-flex items-center gap-1">
            <Images className="h-3 w-3" />
            {template.photo_count ?? 0} 張照片
          </span>
          <span className="text-gray-300">·</span>
          <span>{formatDate(template.created_at)}</span>
        </div>

        <FormField label="所屬期別" className="mb-4">
          <select
            className={fieldControlClass}
            value={template.period_id || ""}
            onChange={event => onMovePeriod(template, event.target.value)}
          >
            {periods.map(period => (
              <option key={period.id} value={period.id}>
                {period.department_label} / {period.name}（{period.status_label}）
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="border-t border-gray-100 p-3">
        <Button
          as={Link}
          to={`/templates/${template.id}/edit`}
          data-guide="template-edit-link"
          variant="secondary"
          fullWidth
        >
          <Pencil className="h-3.5 w-3.5" />
          編輯模板
        </Button>
      </div>
    </Surface>
  );
}
