// 園所管理頁（僅 admin）：分校／班級、目前名單、歷史成員與每期相本快照。

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  Building2,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  GraduationCap,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  School,
  ShieldCheck,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";

import {
  autoFillClassroomMemberAlbumNames,
  autoFillRosterChildAlbumName,
  assignProjectOwner,
  batchAddClassroomMembers,
  createCampus,
  createClassroom,
  createClassroomProject,
  fetchOrganizationOverview,
  fetchProjectAssignmentHistory,
  updateCampus,
  updateCampusSupervisors,
  updateClassroom,
  updateClassroomTeachers,
  updateClassroomMember,
  updateRosterChildAlbumName,
} from "../api/organizationApi";
import CompositionTextarea from "../components/CompositionTextarea";
import ConfirmModal from "../components/ConfirmModal";
import FormModal from "../components/FormModal";
import LegacyProjectMigrationModal from "../components/LegacyProjectMigrationModal";
import {
  Badge,
  Button,
  FormField,
  IconButton,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { getApiErrorMessage } from "../utils/apiError";
import { buildClassroomOwnerOptions } from "../utils/classroomAssignments";
import { showRetryToast } from "../utils/retryToast";
import { getAssignableAccountLabel, ROLE_LABELS } from "../utils/userRoles";

const VIEW_OPTIONS = [
  { value: "active", label: "目前名單", icon: Users },
  { value: "history", label: "歷史紀錄", icon: History },
  { value: "projects", label: "各期相本", icon: BookOpen },
];

const DEPARTMENT_OPTIONS = [
  { value: "all", label: "全部部門" },
  { value: "infant", label: "嬰幼部" },
  { value: "academy", label: "學院部" },
];

const DEPARTMENT_LABELS = {
  infant: "嬰幼部",
  academy: "學院部",
};

const END_REASON_LABELS = {
  departed: "離園",
  transfer: "轉班",
  term_departed: "新學期離園／畢業",
  term_reassignment: "新學期轉班",
};

const SUPERVISOR_SCOPE_SECTIONS = [
  { key: "campus", department: null, label: "全校主管" },
  { key: "infant", department: "infant", label: "嬰幼部主管" },
  { key: "academy", department: "academy", label: "學院部主管" },
];

const SUPERVISOR_END_REASON_LABELS = {
  assignment_replaced: "主管設定已替換",
  role_none: "帳號已停權",
  role_change: "角色已變更",
  user_deleted: "帳號已刪除",
};

function buildSupervisorDraft(campus) {
  const currentScopes = campus?.supervisor_scopes?.current ?? [];
  return Object.fromEntries(SUPERVISOR_SCOPE_SECTIONS.map(section => [
    section.key,
    currentScopes
      .filter(scope => scope.department === section.department && scope.supervisor_id !== null)
      .map(scope => scope.supervisor_id),
  ]));
}

function hasSameIds(firstIds, secondIds) {
  if (firstIds.length !== secondIds.length) return false;
  const secondIdSet = new Set(secondIds);
  return firstIds.every(id => secondIdSet.has(id));
}

const formatDateTime = (value) => value
  ? new Intl.DateTimeFormat("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value))
  : "—";

function EmptyState({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 px-4 py-10 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}

function ProjectTimeline({ project, historyEntries }) {
  const sortedHistory = [...historyEntries].sort(
    (firstEntry, secondEntry) => new Date(firstEntry.changed_at) - new Date(secondEntry.changed_at),
  );

  return (
    <div className="mt-4 border-t border-gray-100 pt-4">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">負責人完整時間線</h4>
      <ol className="space-y-3">
        <li className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3 text-sm">
          <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-indigo-400" />
          <div>
            <div className="font-medium text-gray-800">建立相本</div>
            <div className="mt-0.5 text-xs text-gray-500">
              建立者：{project.created_by_name ?? (
                <span className="font-medium text-amber-700">歷史資料無法確認</span>
              )}
              <span className="mx-1.5 text-gray-300">·</span>
              {formatDateTime(project.created_at)}
            </div>
          </div>
        </li>
        {sortedHistory.map(entry => (
          <li key={entry.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3 text-sm">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-violet-400" />
            <div>
              <div className="font-medium text-gray-800">
                {entry.from_owner_name ?? "未指派"}
                <span className="mx-2 text-gray-300">→</span>
                {entry.to_owner_name ?? "已刪除使用者"}
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                由 {entry.changed_by_name ?? "歷史資料無法確認"} 轉交
                <span className="mx-1.5 text-gray-300">·</span>
                {formatDateTime(entry.changed_at)}
              </div>
              {entry.reason && (
                <p className="mt-1 rounded-md bg-gray-50 px-2 py-1 text-xs leading-5 text-gray-600">
                  {entry.reason}
                </p>
              )}
            </div>
          </li>
        ))}
        {sortedHistory.length === 0 && (
          <li className="pl-6 text-xs text-gray-500">尚無轉交紀錄</li>
        )}
      </ol>
    </div>
  );
}

export default function OrganizationManagement() {
  const [overview, setOverview] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedCampusId, setSelectedCampusId] = useState(null);
  const [selectedClassroomId, setSelectedClassroomId] = useState(null);
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [activeView, setActiveView] = useState("active");
  const [formModal, setFormModal] = useState(null);
  const [migrationProject, setMigrationProject] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAutoFillingClassroomAlbumNames, setIsAutoFillingClassroomAlbumNames] = useState(false);
  const [autoFillingRosterChildId, setAutoFillingRosterChildId] = useState(null);
  const [expandedHistoryProjectId, setExpandedHistoryProjectId] = useState(null);
  const [historyByProjectId, setHistoryByProjectId] = useState({});
  const [loadingHistoryProjectId, setLoadingHistoryProjectId] = useState(null);
  const [supervisorDraft, setSupervisorDraft] = useState({
    campus: [],
    infant: [],
    academy: [],
  });
  const [supervisorSearchQuery, setSupervisorSearchQuery] = useState("");
  const overviewRequestSequence = useRef(0);

  const loadOverview = useCallback(async ({ isInitial = false } = {}) => {
    const requestSequence = overviewRequestSequence.current + 1;
    overviewRequestSequence.current = requestSequence;
    setLoadError("");
    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    try {
      const response = await fetchOrganizationOverview();
      if (overviewRequestSequence.current !== requestSequence) return;
      setOverview(response.data);
    } catch (error) {
      if (overviewRequestSequence.current !== requestSequence) return;
      setLoadError(getApiErrorMessage(error, "載入園所資料失敗"));
    } finally {
      if (overviewRequestSequence.current === requestSequence) {
        if (isInitial) {
          setIsLoading(false);
        } else {
          setIsRefreshing(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    void loadOverview({ isInitial: true });
  }, [loadOverview]);

  const campuses = overview?.campuses ?? [];
  const selectedCampus = campuses.find(campus => campus.id === selectedCampusId)
    ?? campuses[0]
    ?? null;
  useEffect(() => {
    setSupervisorDraft(buildSupervisorDraft(selectedCampus));
  }, [selectedCampus]);
  const visibleSelectedCampusClassrooms = selectedCampus?.classrooms.filter(
    classroom => departmentFilter === "all" || classroom.department === departmentFilter,
  ) ?? [];
  const selectedClassroom = visibleSelectedCampusClassrooms.find(
    classroom => classroom.id === selectedClassroomId,
  ) ?? visibleSelectedCampusClassrooms[0] ?? null;

  const allClassrooms = campuses.flatMap(campus => campus.classrooms.map(classroom => ({
    ...classroom,
    campusName: campus.name,
    campusIsActive: campus.is_active,
  })));
  const activeMembers = selectedClassroom?.members.filter(member => member.status === "active") ?? [];
  const unsetActiveMemberAlbumNameCount = activeMembers.filter(
    member => !(member.album_name || "").trim(),
  ).length;
  const historicalMembers = selectedClassroom?.members.filter(member => member.status === "ended") ?? [];
  const availableTemplates = overview?.templates.filter(template => (
    template.period_status === "active"
  )) ?? [];
  const classroomWorkSlots = (overview?.work_slots ?? []).filter(workSlot => (
    workSlot.classroom_id === selectedClassroom?.id
  ));
  const creatableWorkSlots = classroomWorkSlots.filter(workSlot => (
    workSlot.can_create_project
    && availableTemplates.some(template => template.period_id === workSlot.template_period_id)
  ));
  const selectedProjectWorkSlot = formModal?.type === "project"
    ? creatableWorkSlots.find(workSlot => String(workSlot.id) === String(formModal.workSlotId))
    : null;
  const selectedSlotTemplates = selectedProjectWorkSlot
    ? availableTemplates.filter(template => (
        template.period_id === selectedProjectWorkSlot.template_period_id
      ))
    : [];
  const teacherOptions = overview?.teacher_options ?? [];
  const supervisorOptions = overview?.supervisor_options ?? [];
  const normalizedSupervisorSearchQuery = supervisorSearchQuery.trim().toLocaleLowerCase("zh-TW");
  const filteredSupervisorOptions = supervisorOptions.filter(supervisor => (
    !normalizedSupervisorSearchQuery
    || `${supervisor.display_name} ${supervisor.username} ${ROLE_LABELS[supervisor.role] ?? supervisor.role}`
      .toLocaleLowerCase("zh-TW")
      .includes(normalizedSupervisorSearchQuery)
  ));
  const unassignedProjects = overview?.unassigned_projects ?? [];
  const migrationStatus = overview?.migration_status ?? {
    unassigned_project_count: unassignedProjects.length,
    pending_identity_student_count: unassignedProjects.reduce(
      (total, project) => total + (project.students?.length ?? 0),
      0,
    ),
    archived_teacher_supervisor_link_count: 0,
    archived_identity_resolution_count: 0,
    assigned_identity_anomaly_count: 0,
    is_complete: unassignedProjects.length === 0,
  };
  const hasAssignedIdentityAnomalies = migrationStatus.assigned_identity_anomaly_count > 0;
  const supervisorHistory = selectedCampus?.supervisor_scopes?.history ?? [];
  const hasInactiveSupervisorTargets = !selectedCampus?.is_active
    && Object.values(supervisorDraft).some(supervisorIds => supervisorIds.length > 0);
  const savedSupervisorDraft = buildSupervisorDraft(selectedCampus);
  const hasSupervisorChanges = SUPERVISOR_SCOPE_SECTIONS.some(section => (
    !hasSameIds(supervisorDraft[section.key], savedSupervisorDraft[section.key])
  ));
  const currentTeachers = selectedClassroom?.current_teachers ?? [];
  const teacherHistory = selectedClassroom?.teacher_history ?? [];
  const leadTeacher = currentTeachers.find(teacher => teacher.duty === "lead") ?? null;
  const createProjectDisabledReasons = selectedClassroom ? [
    ...(!selectedCampus?.is_active ? ["分校已停用"] : []),
    ...(!selectedClassroom.is_active ? ["班級已停用"] : []),
    ...(activeMembers.length === 0 ? ["目前名單沒有學生"] : []),
    ...(creatableWorkSlots.length === 0 ? ["目前學期沒有可建立且已有模板的期別工作格"] : []),
    ...(!leadTeacher ? ["尚未設定主教"] : []),
  ] : [];

  const handleCampusSelect = (campus) => {
    setSelectedCampusId(campus.id);
    setSelectedClassroomId(campus.classrooms.find(
      classroom => departmentFilter === "all" || classroom.department === departmentFilter,
    )?.id ?? null);
  };

  const handleClassroomSelect = (campusId, classroomId) => {
    setSelectedCampusId(campusId);
    setSelectedClassroomId(classroomId);
  };

  const handleDepartmentFilterChange = (nextDepartment) => {
    setDepartmentFilter(nextDepartment);
    setSelectedClassroomId(selectedCampus?.classrooms.find(
      classroom => nextDepartment === "all" || classroom.department === nextDepartment,
    )?.id ?? null);
  };

  const openSupervisorModal = () => {
    setSupervisorDraft(buildSupervisorDraft(selectedCampus));
    setSupervisorSearchQuery("");
    setFormModal({ type: "supervisors" });
  };

  const closeFormModal = () => {
    if (isSubmitting || autoFillingRosterChildId !== null) return;
    if (formModal?.type === "supervisors") {
      setSupervisorDraft(buildSupervisorDraft(selectedCampus));
      setSupervisorSearchQuery("");
    }
    setFormModal(null);
  };

  const handleStructureSubmit = async (event) => {
    event.preventDefault();
    const name = formModal.name.trim();
    if (!name) return;
    setIsSubmitting(true);
    try {
      let response;
      if (formModal.kind === "campus" && formModal.mode === "create") {
        response = await createCampus({ name, is_active: formModal.isActive });
        setSelectedCampusId(response.data.id);
        setSelectedClassroomId(null);
        toast.success("分校已建立");
      } else if (formModal.kind === "campus") {
        response = await updateCampus(formModal.id, { name, is_active: formModal.isActive });
        setSelectedCampusId(response.data.id);
        toast.success("分校已更新");
      } else if (formModal.mode === "create") {
        response = await createClassroom({
          campus_id: Number(formModal.campusId),
          name,
          department: formModal.department,
          is_active: formModal.isActive,
        });
        setSelectedCampusId(response.data.campus_id);
        setSelectedClassroomId(response.data.id);
        toast.success("班級已建立");
      } else {
        response = await updateClassroom(formModal.id, {
          campus_id: Number(formModal.campusId),
          name,
          department: formModal.department,
          is_active: formModal.isActive,
        });
        setSelectedCampusId(response.data.campus_id);
        setSelectedClassroomId(response.data.id);
        toast.success("班級已更新");
      }
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "儲存失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMembersSubmit = async (event) => {
    event.preventDefault();
    const members = formModal.names
      .split(/\r?\n/)
      .map(name => name.trim())
      .filter(Boolean)
      .map(name => ({ name }));
    if (members.length === 0) {
      toast.error("請至少輸入一位學生姓名");
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await batchAddClassroomMembers(selectedClassroom.id, members);
      toast.success(`已新增 ${response.data.created.length} 位學生`);
      if (response.data.skipped.length > 0) {
        toast(`已跳過：${response.data.skipped.join("、")}`);
      }
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "新增學生失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTeachersSubmit = async (event) => {
    event.preventDefault();
    if (!formModal.leadTeacherId && formModal.coTeacherIds.length > 0) {
      toast.error("有協同老師時必須指定一位主教");
      return;
    }
    const leadTeacherId = formModal.leadTeacherId ? Number(formModal.leadTeacherId) : null;
    const teachers = [
      ...(leadTeacherId ? [{ teacher_id: leadTeacherId, duty: "lead" }] : []),
      ...formModal.coTeacherIds
        .map(Number)
        .filter(teacherId => teacherId !== leadTeacherId)
        .map(teacherId => ({ teacher_id: teacherId, duty: "co_teacher" })),
    ];
    setIsSubmitting(true);
    try {
      await updateClassroomTeachers(selectedClassroom.id, teachers);
      toast.success("班級老師編制已更新");
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "更新老師編制失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSupervisorToggle = (scopeKey, supervisorId, isChecked) => {
    setSupervisorDraft(current => ({
      ...current,
      [scopeKey]: isChecked
        ? [...current[scopeKey], supervisorId]
        : current[scopeKey].filter(currentId => currentId !== supervisorId),
    }));
  };

  const handleSupervisorsSubmit = async (event) => {
    event.preventDefault();
    if (!selectedCampus || hasInactiveSupervisorTargets || !hasSupervisorChanges) return;
    setIsSubmitting(true);
    try {
      await updateCampusSupervisors(selectedCampus.id, {
        campus_supervisor_ids: supervisorDraft.campus,
        department_supervisors: [
          { department: "infant", supervisor_ids: supervisorDraft.infant },
          { department: "academy", supervisor_ids: supervisorDraft.academy },
        ],
      });
      toast.success("分校主管範圍已更新");
      setFormModal(null);
      setSupervisorSearchQuery("");
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "更新主管範圍失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAutoFillClassroomAlbumNames = async () => {
    if (!selectedClassroom || unsetActiveMemberAlbumNameCount === 0) return;
    const classroomId = selectedClassroom.id;
    setIsAutoFillingClassroomAlbumNames(true);
    try {
      const response = await autoFillClassroomMemberAlbumNames(classroomId);
      const { updated = 0, unresolved = 0 } = response.data || {};
      await loadOverview();

      if (updated > 0 && unresolved > 0) {
        toast.success(`已自動填入 ${updated} 位學生；${unresolved} 位需手動確認`);
      } else if (updated > 0) {
        toast.success(`已自動填入 ${updated} 位學生的相本稱呼`);
      } else if (unresolved > 0) {
        toast.error(`無法安全判斷；${unresolved} 位學生需手動設定`);
      } else {
        toast("目前沒有未設定的相本稱呼");
      }
    } catch {
      showRetryToast("自動填入相本稱呼失敗", handleAutoFillClassroomAlbumNames);
    } finally {
      setIsAutoFillingClassroomAlbumNames(false);
    }
  };

  const handleAutoFillRosterChildAlbumName = async () => {
    const rosterChildId = formModal?.rosterChildId;
    if (!rosterChildId || autoFillingRosterChildId !== null) return;
    const studentName = formModal.studentName ?? formModal.name;
    setAutoFillingRosterChildId(rosterChildId);
    try {
      const response = await autoFillRosterChildAlbumName(rosterChildId);
      const { updated = 0, unresolved = 0 } = response.data || {};
      if (updated > 0) setFormModal(null);
      await loadOverview();

      if (updated > 0) {
        toast.success(`已自動填入「${studentName}」的相本稱呼`);
      } else if (unresolved > 0) {
        toast.error(`無法安全判斷「${studentName}」的相本稱呼，請手動設定`);
      } else {
        toast(`「${studentName}」目前不需自動填入`);
      }
    } catch {
      showRetryToast(
        `自動偵測「${studentName}」的相本稱呼失敗`,
        handleAutoFillRosterChildAlbumName,
      );
    } finally {
      setAutoFillingRosterChildId(null);
    }
  };

  const handleMemberDetailsSubmit = async (event) => {
    event.preventDefault();
    if (autoFillingRosterChildId !== null) return;
    const name = formModal.name.trim();
    if (!name) return;
    const albumName = formModal.albumName.trim() || null;
    const changes = {};
    if (name !== formModal.originalName) changes.name = name;
    if (albumName !== formModal.originalAlbumName) changes.album_name = albumName;
    if (Object.keys(changes).length === 0) {
      setFormModal(null);
      return;
    }
    setIsSubmitting(true);
    try {
      await updateClassroomMember(formModal.classroomId, formModal.memberId, changes);
      toast.success("學生資料已更新");
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "更新學生資料失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRosterChildAlbumNameSubmit = async (event) => {
    event.preventDefault();
    if (autoFillingRosterChildId !== null) return;
    const albumName = formModal.albumName.trim() || null;
    if (albumName === formModal.originalAlbumName) {
      setFormModal(null);
      return;
    }
    setIsSubmitting(true);
    try {
      await updateRosterChildAlbumName(formModal.rosterChildId, albumName);
      toast.success("園所相本稱呼已更新");
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "更新園所相本稱呼失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMemberTransferSubmit = async (event) => {
    event.preventDefault();
    if (!formModal.targetClassroomId) return;
    setIsSubmitting(true);
    try {
      await updateClassroomMember(formModal.classroomId, formModal.memberId, {
        target_classroom_id: Number(formModal.targetClassroomId),
      });
      toast.success("學生已轉班；原班保留歷史紀錄");
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "轉班失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateProjectSubmit = async (event) => {
    event.preventDefault();
    const name = formModal.name.trim();
    if (!name || !formModal.workSlotId || !formModal.templateId || !formModal.ownerId) return;
    setIsSubmitting(true);
    try {
      await createClassroomProject(selectedClassroom.id, {
        name,
        template_id: Number(formModal.templateId),
        work_slot_id: Number(formModal.workSlotId),
        owner_id: Number(formModal.ownerId),
      });
      toast.success("新一期相本已依目前名單建立");
      setFormModal(null);
      setActiveView("projects");
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "建立相本失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAssignmentSubmit = async (event) => {
    event.preventDefault();
    if (!formModal.ownerId) return;
    setIsSubmitting(true);
    try {
      const reason = formModal.reason.trim();
      await assignProjectOwner(formModal.projectId, {
        owner_id: Number(formModal.ownerId),
        ...(reason ? { reason } : {}),
      });
      toast.success("目前負責人已轉交");
      setHistoryByProjectId(previous => {
        const next = { ...previous };
        delete next[formModal.projectId];
        return next;
      });
      setFormModal(null);
      await loadOverview();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "轉交失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHistoryToggle = async (project) => {
    if (expandedHistoryProjectId === project.id) {
      setExpandedHistoryProjectId(null);
      return;
    }
    setExpandedHistoryProjectId(project.id);
    if (historyByProjectId[project.id]) return;
    setLoadingHistoryProjectId(project.id);
    try {
      const response = await fetchProjectAssignmentHistory(project.id);
      setHistoryByProjectId(previous => ({ ...previous, [project.id]: response.data }));
    } catch (error) {
      toast.error(getApiErrorMessage(error, "載入轉交歷程失敗"));
    } finally {
      setLoadingHistoryProjectId(null);
    }
  };

  const handleEndMember = (member) => {
    setConfirmModal({
      message: `確定要把「${member.name}」標記為離園嗎？這不會刪除既有各期相本。`,
      confirmLabel: "標記離園",
      onConfirm: async () => {
        await updateClassroomMember(selectedClassroom.id, member.id, {
          status: "ended",
          end_reason: "departed",
        });
        toast.success("已移到歷史成員");
        await loadOverview();
      },
    });
  };

  const handleRestoreMember = (member) => {
    setConfirmModal({
      message: `確定要把「${member.name}」恢復到「${selectedClassroom.name}」的目前名單嗎？`,
      confirmLabel: "恢復名單",
      confirmVariant: "primary",
      onConfirm: async () => {
        await updateClassroomMember(selectedClassroom.id, member.id, { status: "active" });
        toast.success("已恢復到目前名單");
        await loadOverview();
      },
    });
  };

  if (isLoading && !overview) {
    return <div role="status" className="flex min-h-64 items-center justify-center text-sm text-gray-500">載入園所資料中...</div>;
  }

  if (!overview) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        <PageHeader
          icon={School}
          title="園所設定"
          subtitle="在同一處維護班級與名單、人員權限，以及新學期編班。"
        />
        <Surface className="border-red-200 bg-red-50">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-red-900">無法載入園所資料</h2>
              <p role="alert" className="mt-1 text-sm text-red-700">
                {loadError || "請重新載入園所資料。"}
              </p>
            </div>
            <Button
              variant="dangerSoft"
              disabled={isLoading}
              onClick={() => void loadOverview({ isInitial: true })}
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              {isLoading ? "重新載入中..." : "重新載入"}
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
        onCancel={() => setConfirmModal(null)}
        onConfirm={async () => {
          await confirmModal?.onConfirm();
          setConfirmModal(null);
        }}
      />

      <FormModal
        isOpen={formModal?.type === "supervisors"}
        title={`編輯主管權限：${selectedCampus?.name ?? "分校"}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-5xl"
      >
        {formModal?.type === "supervisors" && selectedCampus && (
          <section aria-label={`主管設定 ${selectedCampus.name}`}>
            <form className="space-y-4" onSubmit={handleSupervisorsSubmit}>
              <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm leading-6 text-indigo-700">
                全校主管涵蓋「{selectedCampus.name}」所有班級；部門主管只涵蓋同校的嬰幼部或學院部。
              </p>

              {!selectedCampus.is_active && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                  此分校已停用，只能取消所有已勾選主管並儲存清空，不能新增或保留主管權限。
                </p>
              )}

              <FormField label="搜尋主管帳號" hint="可搜尋姓名、帳號或目前角色。">
                <input
                  autoFocus
                  type="search"
                  value={supervisorSearchQuery}
                  onChange={event => setSupervisorSearchQuery(event.target.value)}
                  className={fieldControlClass}
                  placeholder="輸入姓名或帳號"
                />
              </FormField>

              <div className="grid gap-3 lg:grid-cols-3">
                {SUPERVISOR_SCOPE_SECTIONS.map(section => (
                  <fieldset key={section.key} className="rounded-xl border border-gray-200 p-3">
                    <legend className="px-1 text-sm font-semibold text-gray-800">
                      {section.label}
                      <span className="ml-1 text-xs font-normal text-gray-500">
                        已選 {supervisorDraft[section.key].length} 位
                      </span>
                    </legend>
                    <div className="mt-1 max-h-72 space-y-2 overflow-y-auto pr-1">
                      {filteredSupervisorOptions.map(supervisor => {
                        const isSelected = supervisorDraft[section.key].includes(supervisor.id);
                        return (
                          <label
                            key={supervisor.id}
                            className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${isSelected ? "border-indigo-200 bg-indigo-50 text-indigo-800" : "border-gray-200 text-gray-700"}`}
                          >
                            <input
                              type="checkbox"
                              aria-label={`${section.label}：${supervisor.display_name}`}
                              checked={isSelected}
                              disabled={!selectedCampus.is_active && !isSelected}
                              onChange={event => handleSupervisorToggle(
                                section.key,
                                supervisor.id,
                                event.target.checked,
                              )}
                            />
                            <span className="min-w-0 truncate">{getAssignableAccountLabel(supervisor)}</span>
                          </label>
                        );
                      })}
                      {filteredSupervisorOptions.length === 0 && (
                        <p className="rounded-lg bg-gray-50 px-3 py-4 text-center text-sm text-gray-500">
                          {supervisorOptions.length === 0
                            ? "尚無可指派人員，請先建立帶班老師或主管帳號。"
                            : "沒有符合搜尋條件的人員。"}
                        </p>
                      )}
                    </div>
                  </fieldset>
                ))}
              </div>

              <div className="flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p role="status" className={`text-sm font-medium ${hasSupervisorChanges ? "text-amber-700" : "text-gray-500"}`}>
                  {hasSupervisorChanges ? "尚有未儲存的主管設定" : "目前設定沒有變更"}
                </p>
                <div className="flex justify-end gap-2">
                  <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting || hasInactiveSupervisorTargets || !hasSupervisorChanges}
                  >
                    {isSubmitting ? "儲存中..." : "儲存主管設定"}
                  </Button>
                </div>
              </div>
            </form>
          </section>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "structure"}
        title={`${formModal?.mode === "create" ? "新增" : "編輯"}${formModal?.kind === "campus" ? "分校" : "班級"}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-lg"
      >
        {formModal?.type === "structure" && (
          <form className="space-y-4" onSubmit={handleStructureSubmit}>
            {formModal.kind === "classroom" && (
              <>
                <FormField label="所屬分校">
                  <select
                    required
                    value={formModal.campusId}
                    onChange={event => setFormModal(current => ({ ...current, campusId: event.target.value }))}
                    className={fieldControlClass}
                  >
                    {campuses.map(campus => (
                      <option key={campus.id} value={campus.id}>{campus.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="部門">
                  <select
                    required
                    value={formModal.department}
                    onChange={event => setFormModal(current => ({ ...current, department: event.target.value }))}
                    className={fieldControlClass}
                  >
                    {DEPARTMENT_OPTIONS.slice(1).map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </FormField>
              </>
            )}
            <FormField label={`${formModal.kind === "campus" ? "分校" : "班級"}名稱`}>
              <input
                autoFocus
                required
                value={formModal.name}
                onChange={event => setFormModal(current => ({ ...current, name: event.target.value }))}
                className={fieldControlClass}
              />
            </FormField>
            <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={formModal.isActive}
                onChange={event => setFormModal(current => ({ ...current, isActive: event.target.checked }))}
              />
              啟用此{formModal.kind === "campus" ? "分校" : "班級"}
            </label>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "儲存中..." : "儲存"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "teachers"}
        title={`設定老師：${selectedClassroom?.name ?? "班級"}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-xl"
      >
        {formModal?.type === "teachers" && (
          <form className="space-y-4" onSubmit={handleTeachersSubmit}>
            <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs leading-5 text-indigo-700">
              目前編制直接決定此班相本的存取權限；相本負責人只用於主要進度歸戶。
            </p>
            <FormField label="主教" hint="有老師編制時必須恰好一位主教；建立新相本時預設為主要負責人。">
              <select
                value={formModal.leadTeacherId}
                onChange={event => setFormModal(current => ({
                  ...current,
                  leadTeacherId: event.target.value,
                  coTeacherIds: current.coTeacherIds.filter(teacherId => teacherId !== event.target.value),
                }))}
                className={fieldControlClass}
              >
                <option value="">不設定老師</option>
                {teacherOptions.map(teacher => (
                  <option key={teacher.id} value={teacher.id}>{getAssignableAccountLabel(teacher)}</option>
                ))}
              </select>
            </FormField>
            <div>
              <div className="mb-1 text-xs font-medium text-gray-500">協同老師</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {teacherOptions.map(teacher => {
                  const teacherId = String(teacher.id);
                  const isLead = formModal.leadTeacherId === teacherId;
                  return (
                    <label
                      key={teacher.id}
                      className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${isLead ? "border-indigo-100 bg-indigo-50 text-indigo-500" : "border-gray-200"}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={teacher.display_name}
                        disabled={isLead}
                        checked={formModal.coTeacherIds.includes(teacherId)}
                        onChange={event => setFormModal(current => ({
                          ...current,
                          coTeacherIds: event.target.checked
                            ? [...current.coTeacherIds, teacherId]
                            : current.coTeacherIds.filter(currentId => currentId !== teacherId),
                        }))}
                      />
                      <span className="min-w-0 truncate">{getAssignableAccountLabel(teacher)}</span>
                    </label>
                  );
                })}
              </div>
              {teacherOptions.length === 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  尚無可指派人員，請先到「人員與權限」建立帶班老師或主管帳號。
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "儲存中..." : "儲存老師編制"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "members"}
        title={`新增學生到 ${selectedClassroom?.name ?? "班級"}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-lg"
      >
        {formModal?.type === "members" && (
          <form className="space-y-4" onSubmit={handleMembersSubmit}>
            <FormField label="學生完整姓名" hint="每行一位；已在此班目前名單中的同名學生會跳過。">
              <CompositionTextarea
                autoFocus
                rows={7}
                value={formModal.names}
                onChange={value => setFormModal(current => ({ ...current, names: value }))}
                className={`${fieldControlClass} resize-y`}
                placeholder={"王小明\n陳小花"}
              />
            </FormField>
            <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs leading-5 text-indigo-700">
              新增後可在目前名單設定相本稱呼；園所設定是唯一來源，既有已歸班與之後建立的相本都會立即套用。
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "新增中..." : "新增學生"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "member-details"}
        title="修改學生資料"
        onClose={closeFormModal}
        maxWidthClass="max-w-md"
      >
        {formModal?.type === "member-details" && (
          <form className="space-y-4" onSubmit={handleMemberDetailsSubmit}>
            <FormField label="完整姓名">
              <input
                autoFocus
                required
                maxLength={100}
                value={formModal.name}
                onChange={event => setFormModal(current => ({ ...current, name: event.target.value }))}
                className={fieldControlClass}
              />
            </FormField>
            <FormField
              label="相本稱呼（選填）"
              hint="留空時相本會沿用完整姓名；修改後，既有已歸班與之後建立的相本都會立即套用。"
            >
              <div className="flex items-center gap-2">
                <input
                  maxLength={100}
                  value={formModal.albumName}
                  onChange={event => setFormModal(current => ({ ...current, albumName: event.target.value }))}
                  className={`${fieldControlClass} min-w-0 flex-1`}
                  placeholder="例如：小明"
                />
                {!formModal.albumName.trim() && formModal.originalAlbumName === null && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={
                      isSubmitting
                      || autoFillingRosterChildId !== null
                      || formModal.name.trim() !== formModal.originalName
                    }
                    onClick={handleAutoFillRosterChildAlbumName}
                  >
                    {autoFillingRosterChildId === formModal.rosterChildId
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Sparkles className="h-3.5 w-3.5" />}
                    {autoFillingRosterChildId === formModal.rosterChildId ? "偵測中…" : "自動偵測"}
                  </Button>
                )}
              </div>
            </FormField>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting || autoFillingRosterChildId !== null}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting || autoFillingRosterChildId !== null}>
                {isSubmitting ? "儲存中..." : "儲存"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "roster-child-album-name"}
        title="修改園所相本稱呼"
        onClose={closeFormModal}
        maxWidthClass="max-w-md"
      >
        {formModal?.type === "roster-child-album-name" && (
          <form className="space-y-4" onSubmit={handleRosterChildAlbumNameSubmit}>
            <p className="text-sm text-gray-600">
              完整姓名：<span className="font-medium text-gray-900">{formModal.studentName}</span>
            </p>
            <FormField
              label="相本稱呼（選填）"
              hint="這是園所唯一來源；儲存後，這位學生所有既有已歸班與未來相本都會立即套用。"
            >
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  maxLength={100}
                  value={formModal.albumName}
                  onChange={event => setFormModal(current => ({ ...current, albumName: event.target.value }))}
                  className={`${fieldControlClass} min-w-0 flex-1`}
                  placeholder="留空時各期相本沿用該期完整姓名"
                />
                {!formModal.albumName.trim() && formModal.originalAlbumName === null && (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={isSubmitting || autoFillingRosterChildId !== null}
                    onClick={handleAutoFillRosterChildAlbumName}
                  >
                    {autoFillingRosterChildId === formModal.rosterChildId
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Sparkles className="h-3.5 w-3.5" />}
                    {autoFillingRosterChildId === formModal.rosterChildId ? "偵測中…" : "自動偵測"}
                  </Button>
                )}
              </div>
            </FormField>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting || autoFillingRosterChildId !== null}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting || autoFillingRosterChildId !== null}>
                {isSubmitting ? "儲存中..." : "儲存"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "member-transfer"}
        title={`轉班：${formModal?.memberName ?? ""}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-md"
      >
        {formModal?.type === "member-transfer" && (
          <form className="space-y-4" onSubmit={handleMemberTransferSubmit}>
            <FormField label="轉入班級" hint="原班會留下歷史紀錄，既有各期相本不會改動。">
              <select
                autoFocus
                required
                value={formModal.targetClassroomId}
                onChange={event => setFormModal(current => ({ ...current, targetClassroomId: event.target.value }))}
                className={fieldControlClass}
              >
                <option value="">請選擇班級</option>
                {allClassrooms
                  .filter(classroom => (
                    classroom.id !== formModal.classroomId
                    && classroom.is_active
                    && classroom.campusIsActive
                  ))
                  .map(classroom => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.campusName}／{classroom.name}
                    </option>
                  ))}
              </select>
            </FormField>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button type="submit" variant="primary" disabled={isSubmitting || !formModal.targetClassroomId}>
                {isSubmitting ? "轉班中..." : "確認轉班"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "project"}
        title={`建立新一期相本：${selectedClassroom?.name ?? ""}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-lg"
      >
        {formModal?.type === "project" && (
          <form className="space-y-4" onSubmit={handleCreateProjectSubmit}>
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
              將目前 {activeMembers.length} 位學生的成員與完整姓名形成這一期快照；之後離園或轉班不會讓快照消失，相本稱呼則持續跟隨園所設定。
            </p>
            <FormField label="相本名稱">
              <input
                autoFocus
                required
                value={formModal.name}
                onChange={event => setFormModal(current => ({ ...current, name: event.target.value }))}
                className={fieldControlClass}
                placeholder="例如：大班 2026 畢業相本"
              />
            </FormField>
            <FormField label="正式學期期別">
              <select
                required
                value={formModal.workSlotId}
                onChange={event => {
                  const nextWorkSlotId = event.target.value;
                  const nextWorkSlot = creatableWorkSlots.find(workSlot => (
                    String(workSlot.id) === nextWorkSlotId
                  ));
                  const nextTemplate = availableTemplates.find(template => (
                    template.period_id === nextWorkSlot?.template_period_id
                  ));
                  setFormModal(current => ({
                    ...current,
                    workSlotId: nextWorkSlotId,
                    templateId: nextTemplate ? String(nextTemplate.id) : "",
                  }));
                }}
                className={fieldControlClass}
              >
                <option value="">請選擇尚未開始的期別工作格</option>
                {creatableWorkSlots.map(workSlot => (
                  <option key={workSlot.id} value={workSlot.id}>
                    {workSlot.academic_term_label}／{workSlot.period_name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="此期模板">
              <select
                required
                value={formModal.templateId}
                onChange={event => setFormModal(current => ({ ...current, templateId: event.target.value }))}
                className={fieldControlClass}
              >
                <option value="">請選擇此期使用中的模板</option>
                {selectedSlotTemplates.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="目前負責老師">
              <select
                required
                value={formModal.ownerId}
                onChange={event => setFormModal(current => ({ ...current, ownerId: event.target.value }))}
                className={fieldControlClass}
              >
                <option value="">請選擇負責人</option>
                {currentTeachers.map(teacher => (
                  <option key={teacher.teacher_id} value={teacher.teacher_id}>
                    {teacher.teacher_name}（{teacher.duty === "lead" ? "主教" : "協同"}）
                  </option>
                ))}
              </select>
            </FormField>
            {currentTeachers.length > 1 && (
              <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs leading-5 text-violet-700">
                所有目前當班老師都可依班級編制存取；所選負責人只決定主要進度歸戶。
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button
                type="submit"
                variant="success"
                disabled={
                  isSubmitting
                  || !formModal.name.trim()
                  || !formModal.workSlotId
                  || !formModal.templateId
                  || !formModal.ownerId
                }
              >
                {isSubmitting ? "建立中..." : "建立相本"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <FormModal
        isOpen={formModal?.type === "assignment"}
        title={`轉交相本：${formModal?.projectName ?? ""}`}
        onClose={closeFormModal}
        maxWidthClass="max-w-lg"
      >
        {formModal?.type === "assignment" && (
          <form className="space-y-4" onSubmit={handleAssignmentSubmit}>
            <FormField label="新的目前負責人">
              <select
                autoFocus
                required
                value={formModal.ownerId}
                onChange={event => setFormModal(current => ({ ...current, ownerId: event.target.value }))}
                className={fieldControlClass}
              >
                <option value="">請選擇負責人</option>
                {formModal.ownerOptions
                  .filter(owner => owner.id !== formModal.currentOwnerId)
                  .map(owner => (
                    <option key={owner.id} value={owner.id}>
                      {owner.display_name}（{ROLE_LABELS[owner.role] ?? owner.role}）
                    </option>
                  ))}
              </select>
            </FormField>
            <FormField label="轉交備註（選填）">
              <CompositionTextarea
                rows={3}
                value={formModal.reason}
                onChange={value => setFormModal(current => ({ ...current, reason: value }))}
                className={`${fieldControlClass} resize-y`}
                placeholder="例如：新學期改由王老師負責"
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button onClick={closeFormModal} disabled={isSubmitting}>取消</Button>
              <Button type="submit" variant="review" disabled={isSubmitting || !formModal.ownerId}>
                {isSubmitting ? "轉交中..." : "確認轉交"}
              </Button>
            </div>
          </form>
        )}
      </FormModal>

      <LegacyProjectMigrationModal
        isOpen={migrationProject !== null}
        project={migrationProject}
        classrooms={allClassrooms}
        onClose={() => setMigrationProject(null)}
        onMigrated={async () => {
          setMigrationProject(null);
          await loadOverview();
        }}
      />

      <PageHeader
        icon={School}
        title="園所設定"
        subtitle="在同一處維護班級與名單、人員權限，以及新學期編班。"
        actions={(
          <div className="flex flex-wrap gap-2">
            <Button as={Link} to="/admin/users" size="sm" variant="secondary">
              <Users className="h-4 w-4" />
              人員帳號
            </Button>
            <Button as={Link} to="/admin/organization/new-term" size="sm" variant="reviewSoft">
              <GraduationCap className="h-4 w-4" />
              新學期編班
            </Button>
            <Button
              size="sm"
              onClick={() => void loadOverview()}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "更新中..." : "重新整理"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setFormModal({
                type: "structure",
                kind: "campus",
                mode: "create",
                name: "",
                isActive: true,
              })}
            >
              <Plus className="h-4 w-4" />
              新增分校
            </Button>
          </div>
        )}
      />

      {loadError && (
        <Surface className="mb-5 border-red-200 bg-red-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-sm text-red-700">{loadError}</p>
            <Button size="sm" variant="dangerSoft" disabled={isRefreshing} onClick={() => void loadOverview()}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              {isRefreshing ? "重試中..." : "重試"}
            </Button>
          </div>
        </Surface>
      )}

      {migrationStatus.is_complete && !hasAssignedIdentityAnomalies ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />
            <h2 className="font-semibold">舊相本歸班完成</h2>
            <span className="text-emerald-700">所有使用中的相本都已納入班級權限。</span>
          </div>
          {migrationStatus.archived_identity_resolution_count > 0 && (
            <span className="text-xs text-emerald-700">
              已保存 {migrationStatus.archived_identity_resolution_count} 筆身分決策供稽核
            </span>
          )}
        </div>
      ) : (
        <Surface className={`mb-5 ${
          hasAssignedIdentityAnomalies
            ? "border-red-200 bg-red-50"
            : "border-amber-200 bg-amber-50"
        }`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle className={`mt-0.5 h-5 w-5 flex-shrink-0 ${
                hasAssignedIdentityAnomalies ? "text-red-600" : "text-amber-600"
              }`} />
              <div>
                <h2 className={`font-semibold ${hasAssignedIdentityAnomalies ? "text-red-900" : "text-amber-900"}`}>
                  {hasAssignedIdentityAnomalies
                    ? `已有 ${migrationStatus.assigned_identity_anomaly_count} 位已歸班學生身分異常`
                    : `尚有 ${migrationStatus.unassigned_project_count} 本舊相本待歸班`}
                </h2>
                <p className={`mt-1 text-sm leading-6 ${hasAssignedIdentityAnomalies ? "text-red-700" : "text-amber-700"}`}>
                  {hasAssignedIdentityAnomalies
                    ? "已歸班相本仍有缺少或重複的學生身分，遷移尚未完成，請先停止學期彙整並檢查資料。"
                    : "請逐本選擇班級並核對學生身分；完成前，未歸班相本只供管理員處理。"}
                </p>
                {migrationStatus.pending_identity_student_count > 0 && (
                  <p className={`mt-2 text-sm font-medium ${hasAssignedIdentityAnomalies ? "text-red-800" : "text-amber-800"}`}>
                    共 {migrationStatus.pending_identity_student_count} 位學生待逐筆核對身分。
                  </p>
                )}
                {migrationStatus.archived_teacher_supervisor_link_count > 0 && (
                  <p className="mt-2 text-xs leading-5 text-slate-600">
                    舊逐人主管關係已封存、未自動轉權限，請依校／部門設定
                    （共 {migrationStatus.archived_teacher_supervisor_link_count} 筆）。
                  </p>
                )}
                {migrationStatus.archived_identity_resolution_count > 0 && (
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    已封存 {migrationStatus.archived_identity_resolution_count} 筆學生身分遷移決策供稽核。
                  </p>
                )}
              </div>
            </div>
            {unassignedProjects.length > 0 && (
              <Button as="a" href="#unassigned-projects" size="sm" variant="primary" className="flex-shrink-0">
                查看待歸班相本
              </Button>
            )}
          </div>
        </Surface>
      )}

      {campuses.length === 0 ? (
        <Surface>
          <EmptyState>尚未建立分校。請先按右上角「新增分校」。</EmptyState>
        </Surface>
      ) : (
        <>
          <Surface padding="sm" className="mb-4 lg:hidden">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-800">目前管理範圍</h2>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => setFormModal({
                  type: "structure",
                  kind: "classroom",
                  mode: "create",
                  campusId: String(selectedCampus.id),
                  department: departmentFilter === "all" ? "infant" : departmentFilter,
                  name: "",
                  isActive: true,
                })}
              >
                <Plus className="h-3.5 w-3.5" />
                新增班級
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="目前分校">
                <select
                  className={fieldControlClass}
                  value={selectedCampus?.id ?? ""}
                  onChange={event => {
                    const campus = campuses.find(item => item.id === Number(event.target.value));
                    if (campus) handleCampusSelect(campus);
                  }}
                >
                  {campuses.map(campus => (
                    <option key={campus.id} value={campus.id}>
                      {campus.name}{campus.is_active ? "" : "（停用）"}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="部門篩選">
                <select
                  className={fieldControlClass}
                  value={departmentFilter}
                  onChange={event => handleDepartmentFilterChange(event.target.value)}
                >
                  {DEPARTMENT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="目前班級">
                <select
                  className={fieldControlClass}
                  value={selectedClassroom?.id ?? ""}
                  disabled={visibleSelectedCampusClassrooms.length === 0}
                  onChange={event => handleClassroomSelect(selectedCampus.id, Number(event.target.value))}
                >
                  {visibleSelectedCampusClassrooms.length === 0 ? (
                    <option value="">此篩選沒有班級</option>
                  ) : visibleSelectedCampusClassrooms.map(classroom => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.name}（{DEPARTMENT_LABELS[classroom.department]}）
                      {classroom.is_active ? "" : "（停用）"}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          </Surface>

          <div className="grid min-w-0 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Surface padding="sm" className="hidden h-fit min-w-0 lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <div className="mb-3 flex items-center justify-between gap-2 px-1">
              <h2 className="text-sm font-semibold text-gray-800">分校與班級</h2>
              <Button
                size="xs"
                variant="secondary"
                disabled={!selectedCampus}
                onClick={() => setFormModal({
                type: "structure",
                kind: "classroom",
                mode: "create",
                campusId: String(selectedCampus.id),
                department: departmentFilter === "all" ? "infant" : departmentFilter,
                name: "",
                isActive: true,
                })}
              >
                <Plus className="h-3.5 w-3.5" />
                班級
              </Button>
            </div>
            <FormField label="部門篩選" className="mb-3 px-1">
              <select
                className={fieldControlClass}
                value={departmentFilter}
                onChange={event => handleDepartmentFilterChange(event.target.value)}
              >
                {DEPARTMENT_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </FormField>
            <div className="space-y-2">
              {campuses.map(campus => (
                <div key={campus.id} className="overflow-hidden rounded-lg border border-gray-200">
                  <div className={`flex items-center gap-1 ${selectedCampus?.id === campus.id ? "bg-indigo-50" : "bg-gray-50"}`}>
                    <button
                      type="button"
                      onClick={() => handleCampusSelect(campus)}
                      aria-pressed={selectedCampus?.id === campus.id}
                      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left text-sm font-semibold text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                    >
                      <Building2 className="h-4 w-4 flex-shrink-0 text-indigo-500" />
                      <span className="truncate">{campus.name}</span>
                      {!campus.is_active && <Badge tone="archive">停用</Badge>}
                    </button>
                    <IconButton
                      label={`編輯分校 ${campus.name}`}
                      size="xs"
                      onClick={() => setFormModal({
                        type: "structure",
                        kind: "campus",
                        mode: "edit",
                        id: campus.id,
                        name: campus.name,
                        isActive: campus.is_active,
                      })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                  {selectedCampus?.id === campus.id && (
                  <div className="border-t border-gray-100 p-1.5">
                    {campus.classrooms.filter(
                      classroom => departmentFilter === "all" || classroom.department === departmentFilter,
                    ).length === 0 ? (
                      <div className="px-2 py-2 text-xs text-gray-500">
                        <p>{departmentFilter === "all" ? "尚無班級" : `沒有${DEPARTMENT_LABELS[departmentFilter]}班級`}</p>
                        {departmentFilter !== "all" && (
                          <button
                            type="button"
                            className="mt-1 font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                            onClick={() => handleDepartmentFilterChange("all")}
                          >
                            查看全部部門
                          </button>
                        )}
                      </div>
                    ) : campus.classrooms
                      .filter(classroom => departmentFilter === "all" || classroom.department === departmentFilter)
                      .map(classroom => (
                      <div key={classroom.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleClassroomSelect(campus.id, classroom.id)}
                          aria-pressed={selectedClassroom?.id === classroom.id}
                          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm ${
                            selectedClassroom?.id === classroom.id
                              ? "bg-indigo-600 font-medium text-white"
                              : "text-gray-600 hover:bg-gray-100"
                          } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1`}
                        >
                          <Users className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate">{classroom.name}</span>
                          <span className={`text-xs ${selectedClassroom?.id === classroom.id ? "text-indigo-100" : "text-gray-500"}`}>
                            {DEPARTMENT_LABELS[classroom.department]}
                          </span>
                          {!classroom.is_active && (
                            <span className={`text-xs ${selectedClassroom?.id === classroom.id ? "text-indigo-100" : "text-gray-500"}`}>
                              停用
                            </span>
                          )}
                        </button>
                        <IconButton
                          label={`編輯班級 ${classroom.name}`}
                          size="xs"
                          onClick={() => setFormModal({
                            type: "structure",
                            kind: "classroom",
                            mode: "edit",
                            id: classroom.id,
                            campusId: String(classroom.campus_id),
                            department: classroom.department,
                            name: classroom.name,
                            isActive: classroom.is_active,
                          })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                  )}
                </div>
              ))}
            </div>
          </Surface>

          <div className="min-w-0">
            {!selectedClassroom ? (
              <Surface className="mb-4">
                <EmptyState>
                  {departmentFilter === "all"
                    ? `請先在「${selectedCampus.name}」建立班級。`
                    : `「${selectedCampus.name}」沒有${DEPARTMENT_LABELS[departmentFilter]}班級。`}
                  {departmentFilter !== "all" && (
                    <button
                      type="button"
                      className="ml-1 font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      onClick={() => handleDepartmentFilterChange("all")}
                    >
                      查看全部部門
                    </button>
                  )}
                </EmptyState>
              </Surface>
            ) : (
              <>
                <Surface className="mb-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="mb-1 text-sm font-medium text-indigo-700">
                        目前管理：{selectedCampus.name}／{DEPARTMENT_LABELS[selectedClassroom.department]}／{selectedClassroom.name}
                      </p>
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-xl font-bold text-gray-900">{selectedClassroom.name}</h2>
                        <Badge tone="info">{DEPARTMENT_LABELS[selectedClassroom.department]}</Badge>
                        <Badge tone={selectedClassroom.is_active ? "success" : "archive"}>
                          {selectedClassroom.is_active ? "使用中" : "已停用"}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-500">
                        {selectedCampus.name} · 目前 {activeMembers.length} 位 · 歷史 {historicalMembers.length} 位 · {selectedClassroom.projects.length} 期相本
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!selectedCampus.is_active || !selectedClassroom.is_active}
                        onClick={() => setFormModal({
                          type: "teachers",
                          leadTeacherId: String(leadTeacher?.teacher_id ?? ""),
                          coTeacherIds: currentTeachers
                            .filter(teacher => teacher.duty === "co_teacher")
                            .map(teacher => String(teacher.teacher_id)),
                        })}
                      >
                        <Users className="h-4 w-4" />
                        設定老師
                      </Button>
                      <Button
                        size="sm"
                        disabled={!selectedCampus.is_active || !selectedClassroom.is_active}
                        onClick={() => setFormModal({ type: "members", names: "" })}
                      >
                        <UserPlus className="h-4 w-4" />
                        新增學生
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        disabled={createProjectDisabledReasons.length > 0}
                        onClick={() => setFormModal({
                          type: "project",
                          name: "",
                          workSlotId: String(creatableWorkSlots[0]?.id ?? ""),
                          templateId: String(availableTemplates.find(template => (
                            template.period_id === creatableWorkSlots[0]?.template_period_id
                          ))?.id ?? ""),
                          ownerId: String(leadTeacher?.teacher_id ?? ""),
                        })}
                      >
                        <BookOpen className="h-4 w-4" />
                        建立新一期相本
                      </Button>
                    </div>
                  </div>
                  {createProjectDisabledReasons.length > 0 && (
                    <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      尚不能建立新一期相本：{createProjectDisabledReasons.join("、")}。
                    </p>
                  )}
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">目前老師編制</div>
                    <div className="flex flex-wrap gap-2">
                      {currentTeachers.map(teacher => (
                        <Badge key={teacher.id} tone={teacher.duty === "lead" ? "primary" : "info"}>
                          {teacher.teacher_name} · {teacher.duty === "lead" ? "主教" : "協同"}
                        </Badge>
                      ))}
                      {currentTeachers.length === 0 && (
                        <span className="text-sm text-amber-700">尚未設定老師，無法建立班級相本。</span>
                      )}
                    </div>
                  </div>
                </Surface>

                <SegmentedControl
                  value={activeView}
                  onChange={setActiveView}
                  options={VIEW_OPTIONS}
                  className="mb-4"
                  ariaLabel="切換班級資料檢視"
                />

                {activeView === "active" && (
                  <Surface>
                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900">目前名單</h3>
                        <p className="mt-0.5 text-xs text-gray-500">
                          成員異動不回寫已建立的相本；相本稱呼是園所唯一來源，會同步套用於既有與未來相本。
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="success">{activeMembers.length} 位</Badge>
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={
                            isAutoFillingClassroomAlbumNames
                            || autoFillingRosterChildId !== null
                            || unsetActiveMemberAlbumNameCount === 0
                            || !selectedCampus?.is_active
                            || !selectedClassroom?.is_active
                          }
                          onClick={handleAutoFillClassroomAlbumNames}
                        >
                          {isAutoFillingClassroomAlbumNames
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Sparkles className="h-3.5 w-3.5" />}
                          {isAutoFillingClassroomAlbumNames ? "偵測中…" : "自動填入相本稱呼"}
                        </Button>
                      </div>
                    </div>
                    {activeMembers.length === 0 ? (
                      <EmptyState>目前沒有在班學生。</EmptyState>
                    ) : (
                      <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                        {activeMembers.map(member => (
                          <div key={member.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1">
                                <span className="truncate font-medium text-gray-900">{member.name}</span>
                                <IconButton
                                  label={`修改 ${member.name} 的完整姓名與相本稱呼`}
                                  size="xs"
                                  onClick={() => setFormModal({
                                    type: "member-details",
                                    classroomId: selectedClassroom.id,
                                    memberId: member.id,
                                    rosterChildId: member.roster_child_id,
                                    name: member.name,
                                    originalName: member.name,
                                    albumName: member.album_name ?? "",
                                    originalAlbumName: member.album_name ?? null,
                                  })}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </IconButton>
                              </div>
                              <div className="mt-0.5 text-xs leading-5 text-gray-500">
                                <div className="break-words">
                                  {`相本稱呼：${member.effective_album_name}${member.album_name ? "" : "（未另設）"}`}
                                </div>
                                <div>加入：{formatDateTime(member.started_at)}</div>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="xs"
                                aria-label={`轉班：${member.name}`}
                                onClick={() => setFormModal({
                                  type: "member-transfer",
                                  classroomId: selectedClassroom.id,
                                  memberId: member.id,
                                  memberName: member.name,
                                  targetClassroomId: "",
                                })}
                                disabled={allClassrooms.every(classroom => (
                                  classroom.id === selectedClassroom.id
                                  || !classroom.is_active
                                  || !classroom.campusIsActive
                                ))}
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                                轉班
                              </Button>
                              <Button
                                size="xs"
                                variant="dangerSoft"
                                aria-label={`標記離園：${member.name}`}
                                onClick={() => handleEndMember(member)}
                              >
                                <UserMinus className="h-3.5 w-3.5" />
                                標記離園
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Surface>
                )}

                {activeView === "history" && (
                  <Surface>
                    <div className="mb-6 border-b border-gray-100 pb-5">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div>
                          <h3 className="font-semibold text-gray-900">歷史老師編制</h3>
                          <p className="mt-0.5 text-xs text-gray-500">
                            換班或職責變更會結束舊區間；相本內容與負責人紀錄不改寫，操作權限立即依目前編制重算。
                          </p>
                        </div>
                        <Badge tone="archive">{teacherHistory.length} 筆</Badge>
                      </div>
                      {teacherHistory.length === 0 ? (
                        <p className="text-sm text-gray-500">尚無歷史老師編制。</p>
                      ) : (
                        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                          {teacherHistory.map(teacher => (
                            <div key={teacher.id} className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <span className="font-medium text-gray-800">{teacher.teacher_name}</span>
                                <span className="ml-2 text-xs text-gray-500">{teacher.duty === "lead" ? "主教" : "協同老師"}</span>
                              </div>
                              <div className="text-xs text-gray-500">
                                {formatDateTime(teacher.started_at)} ～ {formatDateTime(teacher.ended_at)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <div>
                        <h3 className="font-semibold text-gray-900">歷史成員</h3>
                        <p className="mt-0.5 text-xs text-gray-500">離園或轉班後仍保留在原班的歷史紀錄。</p>
                      </div>
                      <Badge tone="archive">{historicalMembers.length} 位</Badge>
                    </div>
                    {historicalMembers.length === 0 ? (
                      <EmptyState>尚無歷史成員。</EmptyState>
                    ) : (
                      <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                        {historicalMembers.map(member => {
                          const currentClassroom = allClassrooms.find(classroom => (
                            classroom.members.some(classroomMember => (
                              classroomMember.roster_child_id === member.roster_child_id
                              && classroomMember.status === "active"
                            ))
                          ));
                          return (
                            <div key={member.id} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex min-w-0 items-center gap-1">
                                    <div className="truncate font-medium text-gray-800">{member.name}</div>
                                    <IconButton
                                      label={`修改 ${member.name} 的完整姓名與相本稱呼`}
                                      size="xs"
                                      onClick={() => setFormModal({
                                        type: "member-details",
                                        classroomId: selectedClassroom.id,
                                        memberId: member.id,
                                        rosterChildId: member.roster_child_id,
                                        name: member.name,
                                        originalName: member.name,
                                        albumName: member.album_name ?? "",
                                        originalAlbumName: member.album_name ?? null,
                                      })}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </IconButton>
                                  </div>
                                  <Badge tone={
                                    ["transfer", "term_reassignment"].includes(member.end_reason)
                                      ? "info"
                                      : "archive"
                                  }>
                                    {END_REASON_LABELS[member.end_reason] ?? "原因未記錄"}
                                  </Badge>
                                </div>
                                <div className="mt-0.5 text-xs leading-5 text-gray-500">
                                  <div className="break-words">
                                    {`相本稱呼：${member.effective_album_name}${member.album_name ? "" : "（未另設）"}`}
                                  </div>
                                  <div>{formatDateTime(member.started_at)} ～ {formatDateTime(member.ended_at)}</div>
                                </div>
                              </div>
                              {currentClassroom ? (
                                <Badge tone="info">
                                  目前在 {currentClassroom.campusName}／{currentClassroom.name}
                                </Badge>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="secondary"
                                  aria-label={`恢復到此班：${member.name}`}
                                  onClick={() => handleRestoreMember(member)}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  恢復到此班
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Surface>
                )}

                {activeView === "projects" && (
                  <div className="space-y-4">
                    {selectedClassroom.projects.length === 0 ? (
                      <Surface><EmptyState>尚未從目前名單建立任何一期相本。</EmptyState></Surface>
                    ) : selectedClassroom.projects.map(project => {
                      const isHistoryExpanded = expandedHistoryProjectId === project.id;
                      const historyEntries = historyByProjectId[project.id] ?? project.assignment_history;
                      return (
                        <Surface as="section" key={project.id} aria-label={`相本 ${project.name}`}>
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone="primary">{project.template_period_name}</Badge>
                                {project.completed_at && <Badge tone="success">已完成</Badge>}
                                <Link
                                  to={`/projects/${project.id}/review`}
                                  className="inline-flex min-w-0 items-center gap-1 font-semibold text-gray-900 hover:text-indigo-700"
                                >
                                  <span className="truncate">{project.name}</span>
                                  <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
                                </Link>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                                <span>模板：{project.template_name}</span>
                                <span>建立：{formatDateTime(project.created_at)}</span>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="reviewSoft"
                                onClick={() => setFormModal({
                                  type: "assignment",
                                  projectId: project.id,
                                  projectName: project.name,
                                  currentOwnerId: project.owner_id,
                                  ownerId: "",
                                  reason: "",
                                  ownerOptions: buildClassroomOwnerOptions(
                                    currentTeachers,
                                    teacherOptions,
                                  ),
                                })}
                                disabled={!currentTeachers.some(teacher => teacher.teacher_id !== project.owner_id)}
                              >
                                <ArrowRightLeft className="h-4 w-4" />
                                轉交負責人
                              </Button>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                              <div className="text-xs text-gray-500">建立者</div>
                              {project.created_by_name ? (
                                <div className="mt-0.5 font-medium text-gray-800">{project.created_by_name}</div>
                              ) : (
                                <div className="mt-0.5 font-medium text-amber-700">歷史資料無法確認</div>
                              )}
                            </div>
                            <div className="rounded-lg border border-violet-100 bg-violet-50 px-3 py-2">
                              <div className="text-xs text-violet-500">目前負責人</div>
                              <div className="mt-0.5 font-medium text-violet-800">
                                {project.owner_name ?? "尚未指派"}
                              </div>
                            </div>
                          </div>

                          <p className="mt-3 text-xs leading-5 text-indigo-600">
                            存取權限直接來自目前班級老師編制；負責人只用於主要進度歸戶。
                          </p>

                          <div className="mt-4">
                            <div className="mb-2 flex items-center gap-2">
                              <CalendarDays className="h-4 w-4 text-gray-500" />
                              <h4 className="text-sm font-semibold text-gray-800">本期學生</h4>
                              <Badge>{project.students.length} 位</Badge>
                            </div>
                            <p className="mb-2 text-xs text-gray-500">
                              成員與完整姓名是本期快照；相本稱呼持續跟隨園所設定。
                            </p>
                            {project.students.length === 0 ? (
                              <p className="text-xs text-gray-500">此期相本沒有學生。</p>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {[...project.students]
                                  .sort((firstStudent, secondStudent) => firstStudent.order_index - secondStudent.order_index)
                                  .map(student => (
                                    <div
                                      key={student.id}
                                      className="flex items-center gap-1 rounded-full border border-gray-200 bg-white py-1 pl-2.5 pr-1 text-xs text-gray-700"
                                    >
                                      <span>{student.name}</span>
                                      {student.effective_album_name !== student.name && (
                                        <span className="ml-1 text-gray-500">相本：{student.effective_album_name}</span>
                                      )}
                                      {student.roster_child_id && (
                                        <IconButton
                                          label={`修改 ${student.name} 的園所相本稱呼`}
                                          size="xs"
                                          onClick={() => setFormModal({
                                            type: "roster-child-album-name",
                                            rosterChildId: student.roster_child_id,
                                            studentName: student.name,
                                            albumName: student.album_name ?? "",
                                            originalAlbumName: student.album_name ?? null,
                                          })}
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </IconButton>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>

                          <div className="mt-4 flex justify-end">
                            <Button size="xs" onClick={() => void handleHistoryToggle(project)}>
                              <History className="h-3.5 w-3.5" />
                              {loadingHistoryProjectId === project.id
                                ? "載入中..."
                                : isHistoryExpanded ? "收合歷程" : "查看完整歷程"}
                            </Button>
                          </div>
                          {isHistoryExpanded && (
                            <ProjectTimeline project={project} historyEntries={historyEntries} />
                          )}
                        </Surface>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <Surface as="section" aria-label={`主管摘要 ${selectedCampus.name}`} className="mt-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-indigo-500" />
                    <h2 className="font-semibold text-gray-900">{selectedCampus.name}主管權限</h2>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-gray-600">
                    主管設定會直接決定可查看、留言與退回的班級相本範圍。
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    !selectedCampus.is_active
                    && (selectedCampus.supervisor_scopes?.current?.length ?? 0) === 0
                  }
                  onClick={openSupervisorModal}
                >
                  <Pencil className="h-4 w-4" />
                  編輯主管權限
                </Button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {SUPERVISOR_SCOPE_SECTIONS.map(section => {
                  const scopeSupervisors = (selectedCampus.supervisor_scopes?.current ?? []).filter(
                    scope => scope.department === section.department,
                  );
                  return (
                    <div key={section.key} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-gray-800">{section.label}</h3>
                        <Badge tone={scopeSupervisors.length > 0 ? "primary" : "neutral"}>
                          {scopeSupervisors.length} 位
                        </Badge>
                      </div>
                      <p className={`mt-2 text-sm leading-6 ${scopeSupervisors.length > 0 ? "text-gray-700" : "text-gray-500"}`}>
                        {scopeSupervisors.length > 0
                          ? scopeSupervisors.map(scope => scope.supervisor_name).join("、")
                          : "尚未設定"}
                      </p>
                    </div>
                  );
                })}
              </div>

              <details className="mt-4 border-t border-gray-100 pt-3 text-sm text-gray-600">
                <summary className="cursor-pointer select-none font-medium text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  主管異動歷程（{supervisorHistory.length}）
                </summary>
                {supervisorHistory.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-500">尚無已結束的主管範圍。</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {supervisorHistory.map(scope => {
                      const section = SUPERVISOR_SCOPE_SECTIONS.find(
                        item => item.department === scope.department,
                      );
                      return (
                        <div key={scope.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                          <span className="font-medium text-gray-800">{section?.label}：{scope.supervisor_name}</span>
                          <span className="mx-1.5 text-gray-400">·</span>
                          {formatDateTime(scope.started_at)} → {formatDateTime(scope.ended_at)}
                          <span className="mx-1.5 text-gray-400">·</span>
                          {SUPERVISOR_END_REASON_LABELS[scope.end_reason] ?? scope.end_reason ?? "已結束"}
                          <span className="mx-1.5 text-gray-400">·</span>
                          由 {scope.ended_by_name ?? "系統"} 操作
                        </div>
                      );
                    })}
                  </div>
                )}
              </details>
            </Surface>
          </div>
        </div>
        </>
      )}

      {unassignedProjects.length > 0 && (
        <Surface id="unassigned-projects" className="mt-5 scroll-mt-4">
          <div className="mb-3">
            <h2 className="font-semibold text-gray-900">未歸班相本</h2>
            <p className="mt-0.5 text-xs leading-5 text-gray-500">
              這些相本未從班級目前名單建立（包含班級資料上線前的舊相本）；本頁不猜測或自動指定班級。
            </p>
          </div>
          <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {unassignedProjects.map(project => {
              const isHistoryExpanded = expandedHistoryProjectId === project.id;
              const historyEntries = historyByProjectId[project.id] ?? project.assignment_history;
              const migrationClassrooms = allClassrooms.filter(classroom => (
                classroom.is_active
                && classroom.campusIsActive
                && (!project.department || classroom.department === project.department)
              ));
              return (
                <div
                  key={project.id}
                  role="group"
                  aria-label={`未歸班相本 ${project.name}`}
                  className="px-3 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="archive">{project.template_period_name ?? "未設定期別"}</Badge>
                        <span className="font-medium text-gray-900">{project.name}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        建立者：{project.created_by_name ?? "歷史資料無法確認"}
                        <span className="mx-1.5 text-gray-300">·</span>
                        目前負責人：{project.owner_name ?? "尚未指派"}
                        <span className="mx-1.5 text-gray-300">·</span>
                        {project.students.length} 位學生
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={migrationClassrooms.length === 0}
                        onClick={() => setMigrationProject(project)}
                      >
                        <Building2 className="h-3.5 w-3.5" />
                        歸入班級
                      </Button>
                      <Button as={Link} to={`/projects/${project.id}/review`} size="sm">
                        查看相本
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" onClick={() => void handleHistoryToggle(project)}>
                        <History className="h-3.5 w-3.5" />
                        {loadingHistoryProjectId === project.id
                          ? "載入中..."
                          : isHistoryExpanded ? "收合歷程" : "查看完整歷程"}
                      </Button>
                    </div>
                  </div>
                  {isHistoryExpanded && (
                    <ProjectTimeline project={project} historyEntries={historyEntries} />
                  )}
                </div>
              );
            })}
          </div>
        </Surface>
      )}
    </div>
  );
}
