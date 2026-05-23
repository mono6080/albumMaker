import { memo, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  fetchAllProjects,
  fetchArchivedProjects,
  createProject,
  deleteProject,
  renameProject,
  restoreProject,
} from "../api/projectApi";
import { fetchAllTemplates } from "../api/templateApi";
import {
  ArchiveRestore,
  CalendarClock,
  Check,
  CircleHelp,
  Eye,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import ResponsiveActionGroup, {
  mobileVisibleHoverActionClass,
  mobileVisibleNamedHoverActionClass,
  responsiveActionItemClass,
} from "../components/ResponsiveActionGroup";
import {
  Badge,
  Button,
  FormField,
  IconButton,
  PageHeader,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { useInlineEdit } from "../hooks/useInlineEdit";
import { startProductGuide } from "../utils/productGuide";

// ── 專案卡片（memo 化，只在自身資料變動時重渲染）────────────────────────────

const PROJECT_LIST_GUIDE_STEPS = [
  {
    element: '[data-guide="project-create-button"]',
    title: "新建專案",
    description: "每個班級每個月建立一個相本專案。先點這裡選模板並命名。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="project-create-form"]',
    title: "選模板與命名",
    description: "選擇設計組提供的模板，輸入班級或月份補充名稱，系統會組成專案全名。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-card"]',
    title: "專案卡片",
    description: "卡片會顯示學生數與建立日期。建立後從這裡進入設定或編輯。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-settings-link"]',
    title: "專案設定",
    description: "先進入專案設定登記學生名單，並填整班共用文字。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-review-link"]',
    title: "個人編輯與輸出",
    description: "學生登記完成後，進入個人編輯逐位補照片、調整文字並輸出 PDF。",
    side: "bottom",
    align: "end",
  },
];

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
      <div className="p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
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
              {showOwner && project.owner_name && (
                <>
                  <span className="text-gray-300">·</span>
                  <span>{project.owner_name}</span>
                </>
              )}
            </div>
          </div>
          {canEdit && (
            <IconButton
              label="封存專案"
              onClick={() => onDelete(project.id)}
              variant="danger"
              className={mobileVisibleHoverActionClass}
            >
              <Trash2 className="w-4 h-4" />
            </IconButton>
          )}
        </div>
      </div>
      <div className={`border-t border-gray-100 grid divide-x divide-gray-100 ${canEdit ? "grid-cols-2" : "grid-cols-1"}`}>
        {canEdit && (
          <Link
            to={`/projects/${project.id}/batch`}
            data-guide="project-settings-link"
            className="min-w-0 flex items-center justify-center gap-1.5 px-2 py-3 text-sm text-indigo-600 font-medium hover:bg-indigo-50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
            專案設定
          </Link>
        )}
        <Link
          to={`/projects/${project.id}/review`}
          data-guide="project-review-link"
          className="min-w-0 flex items-center justify-center gap-1.5 px-2 py-3 text-sm text-emerald-600 font-medium hover:bg-emerald-50 transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
          {canEdit ? "個人編輯" : "審閱"}
        </Link>
      </div>
    </Surface>
  );
});

const ArchivedProjectRow = memo(function ArchivedProjectRow({
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

// ── 專案清單頁面 ──────────────────────────────────────────────────────────────

export default function ProjectList() {
  const { canCreateProject, canEditProject } = usePermissions();
  const { currentUser } = useAuth();
  // teacher 只能看自己的專案，顯示建立者無意義；其餘角色顯示
  const showOwner = currentUser?.role !== "teacher";
  const [projects, setProjects] = useState([]);
  const [archivedProjects, setArchivedProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ customName: "", template_id: "" });
  const [showForm, setShowForm] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [nowMs] = useState(() => Date.now());

  const startGuide = useCallback(() => {
    if (canCreateProject && !showForm) {
      setShowForm(true);
      window.requestAnimationFrame(() => startProductGuide(PROJECT_LIST_GUIDE_STEPS));
      return;
    }
    startProductGuide(PROJECT_LIST_GUIDE_STEPS);
  }, [canCreateProject, showForm]);

  useEffect(() => {
    fetchAllProjects().then(r => setProjects(r.data));
    fetchArchivedProjects().then(r => setArchivedProjects(r.data));
    fetchAllTemplates().then(r => setTemplates(r.data));
  }, []);

  const selectedTemplate = templates.find(t => String(t.id) === String(form.template_id));
  const composedName = selectedTemplate
    ? `${selectedTemplate.name}${form.customName.trim() ? " " + form.customName.trim() : ""}`
    : form.customName.trim();

  // ── 建立（樂觀更新：先顯示後 fetch 完整清單）
  const handleCreate = async () => {
    if (!form.template_id) return toast.error("請選擇模板");
    if (!composedName.trim()) return toast.error("請填寫名稱");
    setCreating(true);
    try {
      await createProject(composedName, form.template_id);
      toast.success("專案已建立");
      setForm({ customName: "", template_id: "" });
      setShowForm(false);
      // 建立後 fetch 完整清單以取得 id / student_count / owner_name
      const r = await fetchAllProjects();
      setProjects(r.data);
    } catch {
      toast.error("建立失敗");
    } finally {
      setCreating(false);
    }
  };

  // ── 重命名（樂觀更新）
  const { editingId, editingValue: editingName, setEditingValue: setEditingName,
    startEdit: handleEditStart, cancelEdit: handleEditCancel, submitEdit: handleEditSave } =
    useInlineEdit(useCallback(async (id, newName) => {
      // cancelEdit 在 submitEdit 中已先執行，此處直接樂觀更新
      setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
      try {
        await renameProject(id, newName);
        toast.success("已更新名稱");
      } catch {
        const r = await fetchAllProjects();
        setProjects(r.data);
        toast.error("更新失敗");
      }
    }, []));

  // ── 刪除（樂觀更新）
  const handleDelete = useCallback((id) => {
    setConfirmModal({
      message: "確定將此專案移到封存？30 天內可從「封存復原」找回，期間一般列表不會顯示。",
      confirmLabel: "移到封存",
      confirmVariant: "archive",
      onConfirm: async () => {
        const prev = projects;
        setProjects(p => p.filter(x => x.id !== id));
        try {
          await deleteProject(id);
          toast.success("已移到封存，30 天內可復原");
          try {
            const archived = await fetchArchivedProjects();
            setArchivedProjects(archived.data);
          } catch {
            // 封存已成功，封存清單稍後可手動重新整理。
          }
        } catch {
          setProjects(prev);
          toast.error("封存失敗");
        }
      },
    });
  }, [projects]);

  const handleRestore = useCallback(async (id) => {
    setRestoringId(id);
    try {
      await restoreProject(id);
      const [active, archived] = await Promise.all([
        fetchAllProjects(),
        fetchArchivedProjects(),
      ]);
      setProjects(active.data);
      setArchivedProjects(archived.data);
      toast.success("專案已復原");
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "復原失敗");
    } finally {
      setRestoringId(null);
    }
  }, []);

  return (
    <div className="w-full">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
      />
      <PageHeader
        icon={FolderOpen}
        iconTone="success"
        title="相本專案"
        subtitle="每個班級每個月一個專案"
        actions={(
        <ResponsiveActionGroup mobileColumns={2}>
          <Button
            type="button"
            onClick={startGuide}
            variant="secondary"
            size="touch"
            className={responsiveActionItemClass}
          >
            <CircleHelp className="w-4 h-4" />
            <span className="whitespace-nowrap">製作教學</span>
          </Button>
          <Button
            type="button"
            onClick={() => setShowArchive(v => !v)}
            variant="archive"
            size="touch"
            className={responsiveActionItemClass}
          >
            <ArchiveRestore className="w-4 h-4" />
            <span className="whitespace-nowrap">封存復原</span>
            {archivedProjects.length > 0 && (
              <Badge tone="archive" className="ml-0.5 bg-slate-200">
                {archivedProjects.length}
              </Badge>
            )}
          </Button>
        {canCreateProject && (
          <Button
            onClick={() => setShowForm(v => !v)}
            data-guide="project-create-button"
            variant="primary"
            size="touch"
            className={`${responsiveActionItemClass} col-span-2 sm:col-span-1`}
          >
            <Plus className="w-4 h-4" />
            <span className="whitespace-nowrap">新建專案</span>
          </Button>
        )}
        </ResponsiveActionGroup>
        )}
      />

      {showArchive && (
        <Surface as="section" padding="none" className="mb-8 overflow-hidden border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="font-semibold text-gray-800 text-sm">封存復原</h2>
              <p className="text-xs text-gray-500">專案移到封存後保留 30 天，可在期限內復原。</p>
            </div>
            <Button
              type="button"
              onClick={() => fetchArchivedProjects().then(r => setArchivedProjects(r.data))}
              variant="archive"
              size="xs"
            >
              重新整理
            </Button>
          </div>
          {archivedProjects.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              目前沒有可復原的封存專案
            </div>
          ) : (
            <div>
              {archivedProjects.map(project => (
                <ArchivedProjectRow
                  key={project.id}
                  project={project}
                  showOwner={showOwner}
                  canEditProject={canEditProject}
                  nowMs={nowMs}
                  onRestore={handleRestore}
                  isRestoring={restoringId === project.id}
                />
              ))}
            </div>
          )}
        </Surface>
      )}

      {/* Create form */}
      {showForm && (
        <Surface className="mb-8 border-indigo-100" padding="lg" data-guide="project-create-form">
          <h2 className="font-semibold text-gray-800 mb-4">新建相本專案</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <FormField label="選擇模板">
              <select
                className={fieldControlClass}
                value={form.template_id}
                onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
              >
                <option value="">請選擇...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.page_count} 頁 / {t.photo_count ?? 0} 張照片）
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="自訂名稱 (分校) (班級)">
              <input
                className={fieldControlClass}
                placeholder="例：東區校 10階A"
                value={form.customName}
                onChange={e => setForm(f => ({ ...f, customName: e.target.value }))}
              />
            </FormField>
          </div>
          {composedName && (
            <div className="text-xs text-gray-500 mb-4 break-words">
              專案全名：<span className="font-medium text-gray-800">{composedName}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleCreate} disabled={creating} variant="primary">
              {creating ? "建立中..." : "建立"}
            </Button>
            <Button onClick={() => setShowForm(false)} variant="ghost">
              取消
            </Button>
          </div>
        </Surface>
      )}

      {projects.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">尚無專案，請點右上角建立</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              editingId={editingId}
              editingName={editingName}
              showOwner={showOwner}
              canEditProject={canEditProject}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={handleEditCancel}
              onEditNameChange={setEditingName}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
