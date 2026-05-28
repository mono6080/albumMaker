import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
import { fetchAvailableTemplates, fetchTemplateDepartments } from "../api/templateApi";
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
  Search,
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
    description: "每個班級每個月建立一個相本專案。先點這裡選模板，再補分校、班級或月份名稱。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="project-create-form"]',
    title: "選模板與命名",
    description: "先選部門與目前使用中的期別，再選設計組提供的模板並補上專案名稱。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-search"]',
    title: "搜尋與篩選",
    description: "可用專案名稱、建立者、學生數或日期搜尋；管理員可再用部門、期別與建立者篩選，同樣會套用到封存復原清單。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-archive-button"]',
    title: "封存復原",
    description: "刪除專案會先移到封存，30 天內可從這裡復原，不會立刻永久刪除。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="project-card"]',
    title: "專案卡片",
    description: "卡片會顯示學生數、建立日期與建立者。可直接改名、封存或進入後續流程。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-settings-link"]',
    title: "專案設定",
    description: "先進入專案設定登記學生名單、套用全班共用照片，並填整班共用文字。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-review-link"]',
    title: "個人編輯與輸出",
    description: "學生登記完成後，進入個人編輯逐位補照片、調整文字、審閱並輸出 PDF 或圖片。",
    side: "bottom",
    align: "end",
  },
];

const FALLBACK_DEPARTMENTS = [
  { code: "infant", name: "嬰幼部" },
  { code: "academy", name: "學院部" },
];

const ALL_FILTER_VALUE = "all";

const DEFAULT_PROJECT_FILTERS = {
  department: ALL_FILTER_VALUE,
  period: ALL_FILTER_VALUE,
  ownerQuery: "",
};

function normalizeSearchText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-TW");
}

function projectMatchesTerms(project, terms) {
  if (terms.length === 0) return true;
  const createdDate = project.created_at
    ? new Date(project.created_at).toLocaleDateString("zh-TW")
    : "";
  const haystack = normalizeSearchText([
    project.name,
    project.owner_name,
    project.department_label,
    project.template_period_name,
    project.student_count,
    createdDate,
  ].join(" "));
  return terms.every(term => haystack.includes(term));
}

function projectMatchesFilters(project, filters, showOwner, canUseProjectFilters) {
  if (!canUseProjectFilters) return true;
  if (filters.department !== ALL_FILTER_VALUE && String(project.department ?? "") !== filters.department) {
    return false;
  }
  if (filters.period !== ALL_FILTER_VALUE && String(project.template_period_id ?? "") !== filters.period) {
    return false;
  }
  const ownerQuery = normalizeSearchText(filters.ownerQuery);
  if (showOwner && ownerQuery) {
    const ownerText = normalizeSearchText([project.owner_name, project.owner_id].join(" "));
    if (!ownerText.includes(ownerQuery)) {
      return false;
    }
  }
  return true;
}

function buildEmptyListMessage(searchQuery, hasSearch, hasActiveFilters, targetLabel = "專案") {
  const trimmedSearch = searchQuery.trim();
  if (hasSearch && hasActiveFilters) {
    return `沒有符合「${trimmedSearch}」與目前篩選條件的${targetLabel}`;
  }
  if (hasSearch) {
    return `沒有符合「${trimmedSearch}」的${targetLabel}`;
  }
  return `沒有符合目前篩選條件的${targetLabel}`;
}

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
              {project.template_period_name && (
                <>
                  <span className="text-gray-300">·</span>
                  <Badge tone="primary">
                    {project.department_label ? `${project.department_label} / ` : ""}
                    {project.template_period_name}
                  </Badge>
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
  const canUseProjectFilters = currentUser?.role === "admin";
  const [projects, setProjects] = useState([]);
  const [archivedProjects, setArchivedProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState(FALLBACK_DEPARTMENTS);
  const [form, setForm] = useState({
    customName: "",
    department: "infant",
    period_id: "",
    template_id: "",
  });
  const [showForm, setShowForm] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [nowMs] = useState(() => Date.now());
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_PROJECT_FILTERS);

  const searchTerms = useMemo(
    () => normalizeSearchText(searchQuery).split(/\s+/).filter(Boolean),
    [searchQuery]
  );
  const filterSourceProjects = useMemo(
    () => [...projects, ...archivedProjects],
    [projects, archivedProjects]
  );
  const departmentFilterOptions = useMemo(() => {
    const optionMap = new Map();
    for (const department of departments) {
      if (!department.code) continue;
      optionMap.set(String(department.code), department.name || department.code);
    }
    for (const project of filterSourceProjects) {
      if (!project.department) continue;
      const value = String(project.department);
      if (!optionMap.has(value)) {
        optionMap.set(value, project.department_label || value);
      }
    }
    return Array.from(optionMap, ([value, label]) => ({ value, label }));
  }, [departments, filterSourceProjects]);
  const periodFilterOptions = useMemo(() => {
    const optionMap = new Map();
    for (const project of filterSourceProjects) {
      if (!project.template_period_id) continue;
      const value = String(project.template_period_id);
      if (optionMap.has(value)) continue;
      const periodLabel = project.template_period_name || `期別 ${value}`;
      optionMap.set(value, project.department_label ? `${project.department_label} / ${periodLabel}` : periodLabel);
    }
    return Array.from(optionMap, ([value, label]) => ({ value, label }));
  }, [filterSourceProjects]);
  const ownerFilterOptions = useMemo(() => {
    if (!showOwner) return [];
    const optionMap = new Map();
    for (const project of filterSourceProjects) {
      if (project.owner_id === null || project.owner_id === undefined) continue;
      const value = String(project.owner_id);
      if (!optionMap.has(value)) {
        optionMap.set(value, project.owner_name || `使用者 ${value}`);
      }
    }
    return Array.from(optionMap, ([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-TW"));
  }, [filterSourceProjects, showOwner]);
  const hasActiveFilters = canUseProjectFilters && (
    filters.department !== ALL_FILTER_VALUE ||
    filters.period !== ALL_FILTER_VALUE ||
    (showOwner && Boolean(filters.ownerQuery?.trim()))
  );
  const hasListFilters = searchTerms.length > 0 || hasActiveFilters;
  const filteredProjects = useMemo(
    () => projects.filter(project => (
      projectMatchesTerms(project, searchTerms) &&
      projectMatchesFilters(project, filters, showOwner, canUseProjectFilters)
    )),
    [projects, searchTerms, filters, showOwner, canUseProjectFilters]
  );
  const filteredArchivedProjects = useMemo(
    () => archivedProjects.filter(project => (
      projectMatchesTerms(project, searchTerms) &&
      projectMatchesFilters(project, filters, showOwner, canUseProjectFilters)
    )),
    [archivedProjects, searchTerms, filters, showOwner, canUseProjectFilters]
  );
  const hasSearch = searchTerms.length > 0;
  const activeEmptyMessage = buildEmptyListMessage(searchQuery, hasSearch, hasActiveFilters, "專案");
  const archivedEmptyMessage = buildEmptyListMessage(searchQuery, hasSearch, hasActiveFilters, "封存專案");
  const listCountLabel = hasListFilters
    ? `找到 ${filteredProjects.length} / ${projects.length} 個專案`
    : `共 ${projects.length} 個專案`;

  const updateFilter = useCallback((key, value) => {
    setFilters(current => ({ ...current, [key]: value }));
  }, []);

  const clearListFilters = useCallback(() => {
    setSearchQuery("");
    setFilters({ ...DEFAULT_PROJECT_FILTERS });
  }, []);

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
    fetchAvailableTemplates().then(r => setTemplates(r.data));
    fetchTemplateDepartments().then(r => setDepartments(r.data.length ? r.data : FALLBACK_DEPARTMENTS));
  }, []);

  const departmentTemplates = useMemo(
    () => templates.filter(template => template.department === form.department),
    [templates, form.department]
  );
  const activePeriods = useMemo(() => {
    const periodMap = new Map();
    for (const template of departmentTemplates) {
      if (!template.period_id || periodMap.has(template.period_id)) continue;
      periodMap.set(template.period_id, {
        id: template.period_id,
        name: template.period_name,
        department: template.department,
        department_label: template.department_label,
      });
    }
    return Array.from(periodMap.values());
  }, [departmentTemplates]);
  const periodTemplates = useMemo(
    () => departmentTemplates.filter(template => String(template.period_id) === String(form.period_id)),
    [departmentTemplates, form.period_id]
  );

  useEffect(() => {
    const periodExists = activePeriods.some(period => String(period.id) === String(form.period_id));
    const nextPeriodId = periodExists ? form.period_id : (activePeriods[0]?.id ? String(activePeriods[0].id) : "");
    const templatesForNextPeriod = departmentTemplates.filter(template => String(template.period_id) === String(nextPeriodId));
    const templateExists = templatesForNextPeriod.some(template => String(template.id) === String(form.template_id));
    const nextTemplateId = templateExists ? form.template_id : (templatesForNextPeriod[0]?.id ? String(templatesForNextPeriod[0].id) : "");
    if (nextPeriodId === form.period_id && nextTemplateId === form.template_id) return;
    setForm(current => ({
      ...current,
      period_id: nextPeriodId,
      template_id: nextTemplateId,
    }));
  }, [activePeriods, departmentTemplates, form.period_id, form.template_id]);

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
      await createProject(composedName, form.template_id, form.department, form.period_id);
      toast.success("專案已建立");
      setForm(current => ({ ...current, customName: "", template_id: "" }));
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
            data-guide="project-archive-button"
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
          ) : filteredArchivedProjects.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {archivedEmptyMessage}
            </div>
          ) : (
            <div>
              {filteredArchivedProjects.map(project => (
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
          <div className="grid grid-cols-1 gap-4 mb-4 md:grid-cols-2 xl:grid-cols-4">
            <FormField label="部門">
              <select
                className={fieldControlClass}
                value={form.department}
                onChange={e => setForm(f => ({
                  ...f,
                  department: e.target.value,
                  period_id: "",
                  template_id: "",
                }))}
              >
                {departments.map(department => (
                  <option key={department.code} value={department.code}>{department.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="期別">
              <select
                className={fieldControlClass}
                value={form.period_id}
                onChange={e => setForm(f => ({ ...f, period_id: e.target.value, template_id: "" }))}
                disabled={activePeriods.length <= 1}
              >
                {activePeriods.length === 0 ? (
                  <option value="">尚無使用中期別</option>
                ) : activePeriods.map(period => (
                  <option key={period.id} value={period.id}>{period.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="選擇模板">
              <select
                className={fieldControlClass}
                value={form.template_id}
                onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
              >
                {periodTemplates.length === 0 ? (
                  <option value="">此期別尚無模板</option>
                ) : (
                  <option value="">請選擇...</option>
                )}
                {periodTemplates.map(t => (
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

      <Surface
        variant="toolbar"
        padding="sm"
        className="mb-4"
        data-guide="project-search"
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <FormField label="搜尋" className="xl:w-80 xl:flex-shrink-0">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="專案名稱、建立者、日期"
                aria-label="搜尋專案"
                className={`${fieldControlClass} pl-9 pr-10`}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                  aria-label="清除搜尋"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </FormField>
          {canUseProjectFilters && (
            <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="部門">
                <select
                  className={fieldControlClass}
                  value={filters.department}
                  onChange={event => updateFilter("department", event.target.value)}
                >
                  <option value={ALL_FILTER_VALUE}>全部部門</option>
                  {departmentFilterOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="期別">
                <select
                  className={fieldControlClass}
                  value={filters.period}
                  onChange={event => updateFilter("period", event.target.value)}
                >
                  <option value={ALL_FILTER_VALUE}>全部期別</option>
                  {periodFilterOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </FormField>
              {showOwner && (
                <FormField label="建立者">
                  <div className="relative">
                    <input
                      list="project-owner-filter-options"
                      className={`${fieldControlClass} pr-10`}
                      value={filters.ownerQuery ?? ""}
                      onChange={event => updateFilter("ownerQuery", event.target.value)}
                      placeholder="輸入建立者"
                      aria-label="篩選建立者"
                    />
                    {filters.ownerQuery && (
                      <button
                        type="button"
                        onClick={() => updateFilter("ownerQuery", "")}
                        className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                        aria-label="清除建立者篩選"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <datalist id="project-owner-filter-options">
                      {ownerFilterOptions.map(option => (
                        <option key={option.value} value={option.label} />
                      ))}
                    </datalist>
                  </div>
                </FormField>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 xl:flex-shrink-0 xl:justify-end xl:pb-0.5">
            <div className="text-xs text-gray-400">{listCountLabel}</div>
            {hasListFilters && (
              <Button type="button" onClick={clearListFilters} variant="ghost" size="sm">
                <X className="h-3.5 w-3.5" />
                清除
              </Button>
            )}
          </div>
        </div>
      </Surface>

      {projects.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">尚無專案，請點右上角建立</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{activeEmptyMessage}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {filteredProjects.map(p => (
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
