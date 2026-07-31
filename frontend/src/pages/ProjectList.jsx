import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Link } from "react-router-dom";
import {
  fetchAllProjects,
  fetchArchivedProjects,
  deleteProject,
  renameProject,
  restoreProject,
} from "../api/projectApi";
import {
  createClassroomProject,
  fetchMyClassrooms,
} from "../api/organizationApi";
import { fetchAvailableTemplates, fetchTemplateDepartments } from "../api/templateApi";
import {
  ArchiveRestore,
  Building2,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import ConfirmModal from "../components/ConfirmModal";
import FormModal from "../components/FormModal";
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
import { prefetchProjectWorkspaceRoutes } from "../routeLoaders";
import {
  findCurrentTeacherAssignment,
  getProjectsOutsideClassrooms,
  getTeacherAssignedClassrooms,
} from "../utils/classroomAssignments";

const PROJECT_LIST_GUIDE_STEPS = [
  {
    element: '[data-guide="project-create-button"]',
    title: "建立新一期相本",
    description: "主教直接在目前任教班級建立新一期；成員與完整姓名形成本期快照，相本稱呼持續跟隨園所設定。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="project-create-form"]',
    title: "選模板與命名",
    description: "選擇該班部門目前使用中的期別與模板，再填入相本名稱。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="project-search"]',
    title: "搜尋與篩選",
    description: "可用專案名稱、目前負責人、學生數或日期搜尋；管理員可再用部門、期別與目前負責人篩選，同樣會套用到封存復原清單。",
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
    description: "卡片會顯示學生數、建立日期與目前負責人。可直接改名、封存或進入後續流程。",
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
    description: "看全班進度、核對本期學生與園所設定的相本稱呼、標記全班完成並下載 PDF 或圖片。",
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
  const { currentUser } = useAuth();
  const {
    canEditProject,
    canViewReports,
    isAdmin,
    isSupervisor,
    isTeacher,
  } = usePermissions();
  // 老師只看目前任教班級的相本；班級卡已顯示主教，因此相本卡不重複顯示 owner。
  const showOwner = !isTeacher || canViewReports;
  const canUseProjectFilters = isAdmin;
  const [projects, setProjects] = useState([]);
  const [archivedProjects, setArchivedProjects] = useState([]);
  const [listLoadError, setListLoadError] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [departments, setDepartments] = useState(FALLBACK_DEPARTMENTS);
  const [showArchive, setShowArchive] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [nowMs] = useState(() => Date.now());
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_PROJECT_FILTERS);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [myClassrooms, setMyClassrooms] = useState([]);
  const [classProjectDraft, setClassProjectDraft] = useState(null);
  const [isCreatingClassProject, setIsCreatingClassProject] = useState(false);

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
  const teacherAssignedClassrooms = useMemo(
    () => getTeacherAssignedClassrooms(myClassrooms, currentUser?.id),
    [myClassrooms, currentUser?.id],
  );
  const availableTemplateById = useMemo(
    () => new Map(templates.map(template => [template.id, template])),
    [templates],
  );
  const getCreatableWorkSlots = useCallback((classroom) => (
    (classroom.work_slots ?? []).filter(workSlot => (
      workSlot.can_create_project
      && ["imported", "active"].includes(workSlot.semester_status)
      && workSlot.template_ids.some(templateId => availableTemplateById.has(templateId))
    ))
  ), [availableTemplateById]);
  const openClassProjectDraft = useCallback((classroom) => {
    const firstWorkSlot = getCreatableWorkSlots(classroom)[0];
    const firstTemplateId = firstWorkSlot?.template_ids.find(templateId => (
      availableTemplateById.has(templateId)
    ));
    setClassProjectDraft({
      classroom,
      name: "",
      workSlotId: firstWorkSlot ? String(firstWorkSlot.id) : "",
      templateId: firstTemplateId ? String(firstTemplateId) : "",
    });
  }, [availableTemplateById, getCreatableWorkSlots]);
  const hasTeacherWorkflow = isTeacher || teacherAssignedClassrooms.length > 0;
  // 目前班級以外仍讀得到的相本：曾任教班級與主管範圍都落在這裡，一律唯讀
  const readOnlyProjects = useMemo(
    () => getProjectsOutsideClassrooms(projects, teacherAssignedClassrooms),
    [projects, teacherAssignedClassrooms],
  );
  const visibleReadOnlyProjects = useMemo(
    () => getProjectsOutsideClassrooms(filteredProjects, teacherAssignedClassrooms),
    [filteredProjects, teacherAssignedClassrooms],
  );

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
    if (isTeacher || isSupervisor) {
      fetchMyClassrooms()
        .then(response => setMyClassrooms(response.data.classrooms ?? []))
        .catch(() => toast.error("載入我的班級失敗"));
    }
  }, [isSupervisor, isTeacher, loadProjectLists]);

  const handleCreateClassProject = async (event) => {
    event.preventDefault();
    const name = classProjectDraft.name.trim();
    const leadTeacher = classProjectDraft.classroom.current_teachers.find(
      teacher => teacher.duty === "lead",
    );
    if (!name || !classProjectDraft.workSlotId || !classProjectDraft.templateId || !leadTeacher) return;
    setIsCreatingClassProject(true);
    try {
      await createClassroomProject(classProjectDraft.classroom.id, {
        name,
        template_id: Number(classProjectDraft.templateId),
        owner_id: leadTeacher.teacher_id,
        work_slot_id: Number(classProjectDraft.workSlotId),
      });
      toast.success("已依班級目前名單建立新一期相本");
      setClassProjectDraft(null);
      const [, classroomResponse] = await Promise.all([
        loadProjectLists(),
        fetchMyClassrooms(),
      ]);
      setMyClassrooms(classroomResponse.data.classrooms ?? []);
    } catch (error) {
      const detail = error?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : detail?.message ?? "建立班級相本失敗");
    } finally {
      setIsCreatingClassProject(false);
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
        <FormField label="目前負責人">
          <div className="relative">
            <input
              list={ownerDatalistId}
              className={`${fieldControlClass} pr-10`}
              value={filters.ownerQuery ?? ""}
              onChange={event => updateFilter("ownerQuery", event.target.value)}
              placeholder="輸入目前負責人"
              aria-label="篩選目前負責人"
            />
            {filters.ownerQuery && (
              <button
                type="button"
                onClick={() => updateFilter("ownerQuery", "")}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="清除目前負責人篩選"
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
      <FormModal
        isOpen={!!classProjectDraft}
        title={`建立新一期相本：${classProjectDraft?.classroom.name ?? ""}`}
        onClose={() => {
          if (!isCreatingClassProject) setClassProjectDraft(null);
        }}
        maxWidthClass="max-w-lg"
      >
        {classProjectDraft && (
          <form className="space-y-4" onSubmit={handleCreateClassProject} data-guide="project-create-form">
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
              會以目前 {classProjectDraft.classroom.members.length} 位學生形成成員與完整姓名快照；相本稱呼會持續跟隨園所設定。主教是進度負責人，所有目前當班老師都可直接製作本班相本。
            </p>
            <FormField label="相本名稱">
              <input
                autoFocus
                required
                className={fieldControlClass}
                value={classProjectDraft.name}
                maxLength={100}
                onChange={event => setClassProjectDraft(current => ({ ...current, name: event.target.value }))}
                placeholder={`${classProjectDraft.classroom.name} 新一期相本`}
              />
            </FormField>
            <FormField label="正式學期期別">
              <select
                required
                className={fieldControlClass}
                value={classProjectDraft.workSlotId}
                onChange={event => {
                  const workSlotId = event.target.value;
                  const workSlot = getCreatableWorkSlots(classProjectDraft.classroom)
                    .find(item => String(item.id) === workSlotId);
                  const firstTemplateId = workSlot?.template_ids.find(templateId => (
                    availableTemplateById.has(templateId)
                  ));
                  setClassProjectDraft(current => ({
                    ...current,
                    workSlotId,
                    templateId: firstTemplateId ? String(firstTemplateId) : "",
                  }));
                }}
              >
                <option value="">請選擇可開工的期別</option>
                {getCreatableWorkSlots(classProjectDraft.classroom)
                  .map(workSlot => (
                    <option key={workSlot.id} value={workSlot.id}>
                      {workSlot.semester_label}／{workSlot.period_name}
                    </option>
                  ))}
              </select>
            </FormField>
            <FormField label="此期模板">
              <select
                required
                className={fieldControlClass}
                value={classProjectDraft.templateId}
                onChange={event => setClassProjectDraft(current => ({ ...current, templateId: event.target.value }))}
              >
                <option value="">請選擇模板</option>
                {templates
                  .filter(template => {
                    const workSlot = getCreatableWorkSlots(classProjectDraft.classroom)
                      .find(item => String(item.id) === classProjectDraft.workSlotId);
                    return workSlot?.template_ids.includes(template.id);
                  })
                  .map(template => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
              </select>
            </FormField>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
              主要負責：{classProjectDraft.classroom.current_teachers.find(teacher => teacher.duty === "lead")?.teacher_name}
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setClassProjectDraft(null)} disabled={isCreatingClassProject}>取消</Button>
              <Button
                type="submit"
                variant="success"
                disabled={isCreatingClassProject || !classProjectDraft.name.trim() || !classProjectDraft.workSlotId || !classProjectDraft.templateId}
              >
                {isCreatingClassProject ? "建立中..." : "建立班級相本"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>
      <PageHeader
        icon={FolderOpen}
        iconTone="success"
        title="相本工作"
        subtitle={teacherAssignedClassrooms.length > 0 ? "你的班級就是相本工作入口；各期相本直接依園所編制歸在班級下。" : "依班級與負責人查看、製作及審閱各期相本。"}
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
                placeholder="專案名稱、目前負責人、日期"
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
      ) : hasTeacherWorkflow ? (
        <div className="space-y-5">
          {teacherAssignedClassrooms.length === 0 && !canViewReports && (
            <Surface className="border-amber-200 bg-amber-50">
              <h2 className="font-semibold text-amber-900">尚未安排目前班級</h2>
              <p className="mt-1 text-sm text-amber-800">
                請管理員到「園所設定」安排班級與帶班職責；設定完成後，班級與各期相本會直接出現在這裡。
              </p>
            </Surface>
          )}

          {teacherAssignedClassrooms.map(classroom => {
            const currentAssignment = findCurrentTeacherAssignment(classroom, currentUser?.id);
            const leadTeacher = classroom.current_teachers.find(teacher => teacher.duty === "lead");
            const allClassProjects = projects.filter(project => project.classroom_id === classroom.id);
            const visibleClassProjects = filteredProjects.filter(project => project.classroom_id === classroom.id);
            const creatableWorkSlots = getCreatableWorkSlots(classroom);
            const canCreateForClass = (
              currentAssignment?.duty === "lead"
              && classroom.members.length > 0
              && creatableWorkSlots.length > 0
            );
            const createDisabledMessage = classroom.members.length === 0
              ? "班級目前沒有學生，請先由管理員完成名單設定"
              : creatableWorkSlots.length === 0
                ? "目前沒有可開工的正式學期期別，請管理員先完成學期與模板設定"
                : null;
            return (
              <Surface key={classroom.id} as="section" className="overflow-hidden" padding="none">
                <div className="border-b border-gray-100 bg-gradient-to-r from-indigo-50/80 to-white p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Building2 className="h-5 w-5 flex-shrink-0 text-indigo-600" />
                        <h2 className="text-lg font-bold text-gray-900">{classroom.name}</h2>
                        <Badge tone={currentAssignment?.duty === "lead" ? "primary" : "info"}>
                          {currentAssignment?.duty === "lead" ? "主教" : "協同"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-gray-500">
                        {classroom.campus_name} · {classroom.members.length} 位目前學生 · {allClassProjects.length} 期可見相本
                      </p>
                      <p className="mt-2 text-xs text-gray-500">
                        主教：{leadTeacher?.teacher_name ?? "尚未設定"}
                        {classroom.members.length > 0 && (
                          <span className="ml-2 text-gray-400">
                            學生：{classroom.members.map(member => member.name).join("、")}
                          </span>
                        )}
                      </p>
                    </div>
                    {currentAssignment?.duty === "lead" && (
                      <div className="flex max-w-xs flex-col items-start gap-1 sm:items-end">
                        <Button
                          size="sm"
                          variant="success"
                          data-guide="project-create-button"
                          disabled={!canCreateForClass}
                          onClick={() => openClassProjectDraft(classroom)}
                        >
                          <Plus className="h-4 w-4" />
                          建立新一期相本
                        </Button>
                        {createDisabledMessage && (
                          <p className="text-xs leading-5 text-amber-700 sm:text-right">
                            {createDisabledMessage}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="p-4 sm:p-5">
                  {visibleClassProjects.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {visibleClassProjects.map(project => (
                        <ProjectCard
                          key={project.id}
                          project={project}
                          editingId={editingId}
                          editingName={editingName}
                          showOwner={false}
                          canEditProject={canEditProject}
                          onEditStart={handleEditStart}
                          onEditSave={handleEditSave}
                          onEditCancel={handleEditCancel}
                          onEditNameChange={setEditingName}
                          onDelete={handleDelete}
                          onPrefetch={prefetchProjectWorkspaceRoutes}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 px-4 py-7 text-center text-sm text-gray-400">
                      {allClassProjects.length > 0
                        ? "這個班級沒有符合目前搜尋的相本"
                        : currentAssignment?.duty === "lead"
                          ? "尚未建立本班相本，請從上方建立新一期"
                          : "本班尚未建立相本；由主教建立後，所有當班老師都可直接製作"}
                    </div>
                  )}
                </div>
              </Surface>
            );
          })}

          {readOnlyProjects.length > 0 && (
            <section className="space-y-3">
              <div>
                <h2 className="font-semibold text-gray-800">
                  {canViewReports ? "帶過的班級與主管檢視範圍" : "我帶過的班級"}
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  以下相本來自你曾任教的班級{canViewReports ? "與校／部門主管範圍" : ""}，
                  可以查看與下載；只有目前列入該班老師編制的相本可以製作。
                </p>
              </div>
              {visibleReadOnlyProjects.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {visibleReadOnlyProjects.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      editingId={editingId}
                      editingName={editingName}
                      showOwner={showOwner}
                      canEditProject={canEditProject}
                      onEditStart={handleEditStart}
                      onEditSave={handleEditSave}
                      onEditCancel={handleEditCancel}
                      onEditNameChange={setEditingName}
                      onDelete={handleDelete}
                      onPrefetch={prefetchProjectWorkspaceRoutes}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 px-4 py-7 text-center text-sm text-gray-400">
                  沒有符合目前搜尋的相本
                </div>
              )}
            </section>
          )}

        </div>
      ) : projects.length === 0 ? (
        /* 零專案的首次引導：說清楚整條路，而不是一行灰字 */
        <Surface className="mx-auto mt-4 max-w-2xl text-center" padding="lg">
          <div className="mb-3 text-4xl">🎨</div>
          <h2 className="mb-1 text-lg font-bold text-gray-900">尚未建立班級相本</h2>
          <p className="mb-6 text-sm text-gray-500">先在園所設定完成分校、班級、帶班老師與學生名單，再從班級建立相本。</p>
          <div className="mb-6 grid gap-3 text-left sm:grid-cols-3">
            {[
              { step: 1, title: "設定班級", description: "安排分校、部門與班級" },
              { step: 2, title: "安排人員", description: "設定帶班老師與目前學生" },
              { step: 3, title: "建立相本", description: "從班級選模板建立新一期" },
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
          {isAdmin ? (
            <Button as={Link} to="/admin/organization" variant="primary" size="lg">
              <Building2 className="h-4 w-4" />
              前往園所設定
            </Button>
          ) : (
            <p className="text-sm text-gray-400">班級相本會由園所設定中的班級與老師編制提供</p>
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
              onPrefetch={prefetchProjectWorkspaceRoutes}
            />
          ))}
        </div>
      )}
    </div>
  );
}
