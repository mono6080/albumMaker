import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  fetchAllProjects,
  fetchArchivedProjects,
  deleteProject,
  renameProject,
  restoreProject,
} from "../api/projectApi";
import { fetchAvailableTemplates, fetchTemplateDepartments } from "../api/templateApi";
import {
  ArchiveRestore,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { usePermissions } from "../hooks/usePermissions";
import ConfirmModal from "../components/ConfirmModal";
import CreateProjectModal from "../components/CreateProjectModal";
import ProjectCard, { ArchivedProjectRow } from "../components/ProjectCard";
import ResponsiveActionGroup, {
  responsiveActionItemClass,
} from "../components/ResponsiveActionGroup";
import {
  Badge,
  Button,
  FormField,
  PageHeader,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { useInlineEdit } from "../hooks/useInlineEdit";
import { startProductGuide } from "../utils/productGuide";

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
    element: '[data-guide="project-edit-link"]',
    title: "編輯相本",
    description: "進入相本編輯器：先在全班範圍放共用照片與文字，再切到個別學生微調。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-review-link"]',
    title: "班級總覽",
    description: "看全班進度、管理學生名單、標記全班完成並下載 PDF 或圖片。",
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

// ── 專案清單頁面 ──────────────────────────────────────────────────────────────

export default function ProjectList() {
  const { canCreateProject, canEditProject, isAdmin, isTeacher } = usePermissions();
  // teacher 只能看自己的專案，顯示建立者無意義；其餘角色顯示
  const showOwner = !isTeacher;
  const canUseProjectFilters = isAdmin;
  const [projects, setProjects] = useState([]);
  const [archivedProjects, setArchivedProjects] = useState([]);
  const [listLoadError, setListLoadError] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState(FALLBACK_DEPARTMENTS);
  const [showForm, setShowForm] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [nowMs] = useState(() => Date.now());
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_PROJECT_FILTERS);
  const [showMobileFilters, setShowMobileFilters] = useState(false);

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
    // 建立表單已改為 Modal：導覽不預開（會遮住其他步驟），表單步驟在 Modal 開啟時才會出現
    startProductGuide(PROJECT_LIST_GUIDE_STEPS);
  }, []);

  // 專案清單載入失敗必須顯示錯誤，不能讓網路錯誤偽裝成「尚無專案」空狀態
  const loadProjectLists = useCallback(async () => {
    setListLoadError(null);
    try {
      const [projectsResponse, archivedResponse] = await Promise.all([
        fetchAllProjects(),
        fetchArchivedProjects(),
      ]);
      setProjects(projectsResponse.data);
      setArchivedProjects(archivedResponse.data);
    } catch {
      setListLoadError("載入專案清單失敗，請檢查網路後重試");
    }
  }, []);

  useEffect(() => {
    loadProjectLists();
    fetchAvailableTemplates()
      .then(r => setTemplates(r.data))
      .catch(() => toast.error("載入模板清單失敗"));
    fetchTemplateDepartments()
      .then(r => setDepartments(r.data.length ? r.data : FALLBACK_DEPARTMENTS))
      .catch(() => setDepartments(FALLBACK_DEPARTMENTS));
  }, [loadProjectLists]);

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

  const renderProjectFilterControls = (ownerDatalistId) => (
    <>
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
              list={ownerDatalistId}
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
            <datalist id={ownerDatalistId}>
              {ownerFilterOptions.map(option => (
                <option key={option.value} value={option.label} />
              ))}
            </datalist>
          </div>
        </FormField>
      )}
    </>
  );

  // 零專案且無封存時封存鈕是噪音，藏起來；新建鈕的跨欄也跟著這個旗標走
  const showArchiveButton = projects.length > 0 || archivedProjects.length > 0;

  return (
    <div className="w-full">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
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
            <span className="hidden sm:inline">製作教學</span>
            <span className="sm:hidden">教學</span>
          </Button>
          {/* 零專案且無封存時是噪音，先藏 */}
          {showArchiveButton && (
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
          )}
        {canCreateProject && (
          <Button
            onClick={() => setShowForm(v => !v)}
            data-guide="project-create-button"
            variant="primary"
            size="touch"
            // 三顆鈕時新建跨兩欄補滿第二列；只剩兩顆（無封存）時與教學同列，避免孤懸半寬
            className={`${responsiveActionItemClass} ${showArchiveButton ? "col-span-2 sm:col-span-1" : ""}`}
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

      {/* Create form（Modal；關閉不清空輸入，誤觸不失資料） */}
      <CreateProjectModal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        templates={templates}
        departments={departments}
        projects={projects}
      />

      {/* 零專案時搜尋列是噪音，藏起來讓空狀態引導成為焦點 */}
      {projects.length > 0 && (
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
            <div className="hidden flex-1 grid-cols-1 gap-3 xl:grid xl:grid-cols-3">
              {renderProjectFilterControls("project-owner-filter-options")}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 xl:flex-shrink-0 xl:justify-end xl:pb-0.5">
            <div className="text-xs text-gray-400">{listCountLabel}</div>
            <div className="flex items-center gap-2">
              {canUseProjectFilters && (
                <Button
                  type="button"
                  onClick={() => setShowMobileFilters(value => !value)}
                  variant={showMobileFilters || hasActiveFilters ? "secondary" : "ghost"}
                  size="sm"
                  className="xl:hidden"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  篩選
                </Button>
              )}
              {hasListFilters && (
                <Button type="button" onClick={clearListFilters} variant="ghost" size="sm">
                  <X className="h-3.5 w-3.5" />
                  清除
                </Button>
              )}
            </div>
          </div>
        </div>
        {canUseProjectFilters && (
          <div className={`${showMobileFilters ? "grid" : "hidden"} grid-cols-1 gap-3 sm:grid-cols-2 xl:hidden`}>
            {renderProjectFilterControls("project-owner-filter-options-mobile")}
          </div>
        )}
      </Surface>
      )}

      {listLoadError ? (
        <div className="text-center py-20 text-gray-500">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="mb-4 text-sm">{listLoadError}</p>
          <Button variant="secondary" size="sm" onClick={loadProjectLists}>重新載入</Button>
        </div>
      ) : projects.length === 0 ? (
        /* 零專案的首次引導：說清楚整條路，而不是一行灰字 */
        <Surface className="mx-auto mt-4 max-w-2xl text-center" padding="lg">
          <div className="mb-3 text-4xl">🎨</div>
          <h2 className="mb-1 text-lg font-bold text-gray-900">開始製作第一本班級相本</h2>
          <p className="mb-6 text-sm text-gray-500">跟著三個步驟，就能做出每位孩子的個人化相本</p>
          <div className="mb-6 grid gap-3 text-left sm:grid-cols-3">
            {[
              { step: 1, title: "建立專案", description: "選擇行政準備好的模板" },
              { step: 2, title: "加入學生名單", description: "貼上全班名字，一行一位" },
              { step: 3, title: "放照片、看預覽", description: "全班或逐位學生上傳照片" },
            ].map(({ step, title, description }) => (
              <div key={step} className="rounded-xl border border-gray-100 bg-gray-50/60 p-4">
                <div className="mb-1 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                  {step}
                </div>
                <div className="text-sm font-semibold text-gray-800">{title}</div>
                <div className="mt-0.5 text-xs text-gray-500">{description}</div>
              </div>
            ))}
          </div>
          {canCreateProject ? (
            <Button variant="primary" size="lg" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" />
              建立第一個專案
            </Button>
          ) : (
            <p className="text-sm text-gray-400">目前帳號沒有建立專案的權限，請聯絡管理員</p>
          )}
        </Surface>
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
