// 新學期編班：先編輯全園目標狀態，驗證差異後再一次套用。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Pencil,
  RefreshCw,
  Save,
  School,
  Search,
  Users,
} from "lucide-react";

import {
  applyTermReclassificationPlan,
  cancelTermReclassificationPlan,
  createTermReclassificationPlan,
  fetchOrganizationOverview,
  fetchTermReclassificationPlan,
  updateTermReclassificationPlan,
  validateTermReclassificationPlan,
} from "../api/organizationApi";
import ConfirmModal from "../components/ConfirmModal";
import FormModal from "../components/FormModal";
import {
  Badge,
  Button,
  FormField,
  PageHeader,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { getApiErrorMessage } from "../utils/apiError";
import { getAssignableAccountLabel } from "../utils/userRoles";

const DUTY_LABELS = {
  lead: "主教",
  co_teacher: "協同老師",
};

const getDiffCount = (value) => Array.isArray(value) ? value.length : Number(value ?? 0);

const isStudentPlacementChanged = placement => (
  placement.outcome === "departed"
  || placement.target_classroom_id !== placement.source_classroom_id
);

const normalizeSearchText = value => value.replace(/[\s\u3000]+/g, "").toLocaleLowerCase("zh-TW");

const VALIDATION_ERROR_MESSAGES = {
  stale_reclassification_plan: "目前名單或老師編制已變更，這份草稿必須取消後重新建立。",
  target_classroom_not_found: "目標班級已不存在，請重新選擇。",
  inactive_target_classroom: "學生被編入不屬於這個新學期的班級，或該分校已停用。",
  classroom_student_limit_exceeded: "目標班級人數超過相本可容納上限。",
  duplicate_target_student_name: "同一目標班級有重複姓名，請確認是否編錯學生。",
  inactive_teacher_classroom: "老師編制落在不屬於這個新學期的班級，或該分校已停用。",
  invalid_lead_count: "非空老師編制必須恰有一位主教。",
  teacher_not_found: "目標老師帳號已不存在。",
  invalid_teacher_role: "目標帳號已無法指派為帶班老師，請重新指派。",
  semester_period_required: "正式學期至少需要一個期別。請先到模板管理建立期別。",
  semester_period_not_active: "正式學期的所有期別都必須先設為使用中。",
  invalid_semester_dates: "學期開始日不可晚於結束日。",
};

function getValidationErrorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message
    ?? VALIDATION_ERROR_MESSAGES[error?.code]
    ?? error?.code
    ?? "目標狀態不符合規則";
}

function getValidationTargetId(error) {
  const sourceMemberId = error?.source_member_id ?? error?.source_member_ids?.[0];
  if (sourceMemberId) return `term-student-${sourceMemberId}`;
  const classroomId = error?.classroom_id ?? error?.target_classroom_id;
  return classroomId ? `term-classroom-${classroomId}` : null;
}

function getTermErrorCode(error) {
  return error?.response?.data?.detail?.code;
}

export default function TermReclassification() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [plan, setPlan] = useState(null);
  const [label, setLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);
  const [studentSearchText, setStudentSearchText] = useState("");
  const [isShowingChangedStudentsOnly, setIsShowingChangedStudentsOnly] = useState(false);
  const [expandedStudentClassroomId, setExpandedStudentClassroomId] = useState(null);
  const [teacherEditor, setTeacherEditor] = useState(null);
  const [pendingValidationTargetId, setPendingValidationTargetId] = useState(null);

  const loadWorkspace = useCallback(async () => {
    setIsLoading(true);
    setLoadError("");
    try {
      const overviewResponse = await fetchOrganizationOverview();
      const nextOverview = overviewResponse.data;
      setOverview(nextOverview);
      if (nextOverview.draft_term_plan_id) {
        const planResponse = await fetchTermReclassificationPlan(nextOverview.draft_term_plan_id);
        setPlan(planResponse.data);
      } else {
        setPlan(null);
      }
      setIsDirty(false);
    } catch (error) {
      setLoadError(getApiErrorMessage(error, "載入新學期編班資料失敗"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!pendingValidationTargetId) return;
    const target = document.getElementById(pendingValidationTargetId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    setPendingValidationTargetId(null);
  }, [expandedStudentClassroomId, pendingValidationTargetId]);

  // 可編入的是目標學期新建的班，不是目前學期那份清單
  const targetClassrooms = useMemo(
    () => (plan?.target_classrooms ?? []).map(classroom => ({
      id: classroom.classroom_id,
      name: classroom.name,
      department: classroom.department,
      campusName: classroom.campus_name,
    })),
    [plan?.target_classrooms],
  );
  const teacherOptions = useMemo(
    () => overview?.teacher_options ?? [],
    [overview?.teacher_options],
  );
  const classroomById = useMemo(
    () => new Map(targetClassrooms.map(classroom => [classroom.id, classroom])),
    [targetClassrooms],
  );
  const placementByMemberId = useMemo(
    () => new Map((plan?.student_placements ?? []).map(placement => (
      [placement.source_member_id, placement]
    ))),
    [plan?.student_placements],
  );
  const teacherOptionById = useMemo(
    () => new Map(teacherOptions.map(teacher => [teacher.id, teacher])),
    [teacherOptions],
  );
  const studentPlacementGroups = useMemo(() => {
    const groupsByClassroomId = new Map();
    for (const placement of plan?.student_placements ?? []) {
      const currentGroup = groupsByClassroomId.get(placement.source_classroom_id) ?? {
        classroomId: placement.source_classroom_id,
        campusName: placement.source_campus_name,
        classroomName: placement.source_classroom_name,
        placements: [],
      };
      currentGroup.placements.push(placement);
      groupsByClassroomId.set(placement.source_classroom_id, currentGroup);
    }
    return [...groupsByClassroomId.values()].sort((firstGroup, secondGroup) => (
      firstGroup.campusName.localeCompare(secondGroup.campusName, "zh-TW")
      || firstGroup.classroomName.localeCompare(secondGroup.classroomName, "zh-TW")
    ));
  }, [plan?.student_placements]);
  const visibleStudentPlacementGroups = useMemo(() => {
    const normalizedQuery = normalizeSearchText(studentSearchText);
    return studentPlacementGroups
      .map(group => {
        const filteredPlacements = group.placements.filter(placement => {
          if (isShowingChangedStudentsOnly && !isStudentPlacementChanged(placement)) return false;
          if (!normalizedQuery) return true;
          const targetClassroom = classroomById.get(placement.target_classroom_id);
          return normalizeSearchText([
            placement.student_name,
            placement.source_campus_name,
            placement.source_classroom_name,
            targetClassroom?.campusName,
            targetClassroom?.name,
          ].filter(Boolean).join(" ")).includes(normalizedQuery);
        });
        return {
          ...group,
          filteredPlacements,
          changedCount: group.placements.filter(isStudentPlacementChanged).length,
        };
      })
      .filter(group => group.filteredPlacements.length > 0);
  }, [classroomById, isShowingChangedStudentsOnly, studentPlacementGroups, studentSearchText]);
  const visibleExpandedStudentClassroomId = visibleStudentPlacementGroups.some(
    group => group.classroomId === expandedStudentClassroomId,
  )
    ? expandedStudentClassroomId
    : (visibleStudentPlacementGroups[0]?.classroomId ?? null);

  const handleTermMutationError = useCallback(async (error, fallback) => {
    const errorCode = getTermErrorCode(error);
    if (errorCode === "term_plan_revision_conflict") {
      toast.error("草稿已在其他視窗更新，已為你載入最新版本。請確認差異後再操作。");
      await loadWorkspace();
      return;
    }
    if (errorCode === "stale_reclassification_plan") {
      toast.error("目前名單或老師編制已變更，請取消這份草稿並從最新狀態重新建立。");
      await loadWorkspace();
      return;
    }
    toast.error(getApiErrorMessage(error, fallback));
  }, [loadWorkspace]);

  const markPlanEdited = (updater) => {
    setPlan(currentPlan => {
      const nextPlan = updater(currentPlan);
      return { ...nextPlan, validation: null, diff: null };
    });
    setIsDirty(true);
  };

  const handleStudentTargetChange = (sourceMemberId, value) => {
    markPlanEdited(currentPlan => ({
      ...currentPlan,
      student_placements: currentPlan.student_placements.map(placement => {
        if (placement.source_member_id !== sourceMemberId) return placement;
        if (value === "departed") {
          return { ...placement, outcome: "departed", target_classroom_id: null };
        }
        return {
          ...placement,
          outcome: "classroom",
          target_classroom_id: Number(value),
        };
      }),
    }));
  };

  const handleOpenTeacherEditor = (classroomId) => {
    const target = plan.classroom_teacher_targets.find(item => item.classroom_id === classroomId);
    if (!target) return;
    setTeacherEditor({
      classroomId,
      teachers: target.teachers.map(teacher => ({ ...teacher })),
    });
  };

  const handleTeacherEditorLeadChange = (teacherIdValue) => {
    const teacherId = teacherIdValue ? Number(teacherIdValue) : null;
    setTeacherEditor(currentEditor => {
      const coTeachers = currentEditor.teachers.filter(teacher => (
          teacher.duty === "co_teacher" && teacher.teacher_id !== teacherId
      ));
      return {
        ...currentEditor,
        teachers: teacherId === null
          ? coTeachers
          : [{ teacher_id: teacherId, duty: "lead" }, ...coTeachers],
      };
    });
  };

  const handleTeacherEditorCoTeacherChange = (teacherId, isChecked) => {
    setTeacherEditor(currentEditor => {
      const teachers = currentEditor.teachers.filter(teacher => (
        !(teacher.teacher_id === teacherId && teacher.duty === "co_teacher")
      ));
      if (isChecked) teachers.push({ teacher_id: teacherId, duty: "co_teacher" });
      return { ...currentEditor, teachers };
    });
  };

  const handleRemoveTeacherEditorTarget = (teacherIndex) => {
    setTeacherEditor(currentEditor => ({
      ...currentEditor,
      teachers: currentEditor.teachers.filter((_, index) => index !== teacherIndex),
    }));
  };

  const handleTeacherEditorSubmit = (event) => {
    event.preventDefault();
    markPlanEdited(currentPlan => ({
      ...currentPlan,
      classroom_teacher_targets: currentPlan.classroom_teacher_targets.map(target => (
        target.classroom_id === teacherEditor.classroomId
          ? { ...target, teachers: teacherEditor.teachers }
          : target
      )),
    }));
    setTeacherEditor(null);
  };

  const saveDraft = async ({ showToast = true } = {}) => {
    if (!plan || !isDirty) return plan;
    const response = await updateTermReclassificationPlan(
      plan.id,
      plan.revision,
      plan.student_placements.map(placement => ({
        source_member_id: placement.source_member_id,
        outcome: placement.outcome,
        target_classroom_id: placement.target_classroom_id,
      })),
      plan.classroom_teacher_targets.map(target => ({
        classroom_id: target.classroom_id,
        teachers: target.teachers.map(teacher => ({
          teacher_id: teacher.teacher_id,
          duty: teacher.duty,
        })),
      })),
    );
    setPlan(response.data);
    setIsDirty(false);
    if (showToast) toast.success("編班草稿已儲存");
    return response.data;
  };

  const handleCreatePlan = async (event) => {
    event.preventDefault();
    const normalizedLabel = label.trim();
    if (!normalizedLabel) return;
    setIsSubmitting(true);
    try {
      const response = await createTermReclassificationPlan(normalizedLabel, {
        startsOn,
        endsOn,
      });
      setPlan(response.data);
      setIsDirty(false);
      toast.success("已從目前名單建立新學期草稿");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "建立編班草稿失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSave = async () => {
    setIsSubmitting(true);
    try {
      await saveDraft();
    } catch (error) {
      await handleTermMutationError(error, "儲存編班草稿失敗");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRefresh = () => {
    if (isDirty) {
      setConfirmAction("reload");
      return;
    }
    void loadWorkspace();
  };

  const handleReturnToOrganization = () => {
    if (isDirty) {
      setConfirmAction("leave");
      return;
    }
    navigate("/admin/organization");
  };

  const handleValidate = async () => {
    setIsSubmitting(true);
    try {
      const savedPlan = await saveDraft({ showToast: false });
      const response = await validateTermReclassificationPlan(savedPlan.id);
      setPlan(response.data);
      setIsDirty(false);
      if (response.data.validation?.is_valid) {
        toast.success("驗證通過，可以套用新學期編班");
      } else {
        toast.error("草稿仍有需要修正的項目");
      }
    } catch (error) {
      await handleTermMutationError(error, "驗證編班草稿失敗");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApply = async () => {
    setIsSubmitting(true);
    try {
      const response = await applyTermReclassificationPlan(plan.id, plan.revision);
      setPlan(response.data);
      setIsDirty(false);
      setConfirmAction(null);
      toast.success("新學期名單與老師編制已一次套用");
    } catch (error) {
      setConfirmAction(null);
      await handleTermMutationError(error, "套用新學期編班失敗");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    setIsSubmitting(true);
    try {
      await cancelTermReclassificationPlan(plan.id);
      setPlan(null);
      setLabel("");
      setStartsOn("");
      setEndsOn("");
      setIsDirty(false);
      setConfirmAction(null);
      toast.success("編班草稿已取消，目前名單沒有變更");
    } catch (error) {
      setConfirmAction(null);
      await handleTermMutationError(error, "取消編班草稿失敗");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <div className="flex min-h-64 items-center justify-center text-sm text-gray-400">載入新學期編班中...</div>;
  }

  const validationErrors = plan?.validation?.errors ?? [];
  const studentDiff = plan?.diff?.students ?? {};
  const teacherDiff = plan?.diff?.teachers ?? {};
  const classroomCounts = studentDiff.classroom_counts ?? [];
  const teacherEditorClassroom = teacherEditor
    ? classroomById.get(teacherEditor.classroomId)
    : null;
  const teacherEditorLead = teacherEditor?.teachers.find(teacher => teacher.duty === "lead");
  const teacherEditorCoTeacherIds = new Set(
    teacherEditor?.teachers
      .filter(teacher => teacher.duty === "co_teacher")
      .map(teacher => teacher.teacher_id) ?? [],
  );
  const selectableTeacherIds = new Set(teacherOptions.map(teacher => teacher.id));
  const invalidTeacherEditorTargets = (teacherEditor?.teachers ?? [])
    .map((teacher, teacherIndex) => ({ teacher, teacherIndex }))
    .filter(({ teacher }) => (
      teacher.teacher_id === null || !selectableTeacherIds.has(teacher.teacher_id)
    ));
  const getClassroomName = classroomId => {
    const classroom = classroomById.get(classroomId);
    return classroom
      ? `${classroom.campusName}／${classroom.name}`
      : `班級 #${classroomId}`;
  };
  const getStudentDiffLabel = row => {
    const placement = placementByMemberId.get(row.source_member_id);
    const sourceName = placement
      ? `${placement.source_campus_name}／${placement.source_classroom_name}`
      : getClassroomName(row.from_classroom_id);
    const targetName = row.to_classroom_id ? getClassroomName(row.to_classroom_id) : "離園／畢業";
    return `${row.student_name}：${sourceName} → ${targetName}`;
  };
  const scrollToValidationTarget = (error) => {
    const targetId = getValidationTargetId(error);
    if (!targetId) return;
    const sourceMemberId = error?.source_member_id ?? error?.source_member_ids?.[0];
    if (sourceMemberId) {
      const placement = placementByMemberId.get(sourceMemberId);
      setStudentSearchText("");
      setIsShowingChangedStudentsOnly(false);
      setExpandedStudentClassroomId(placement?.source_classroom_id ?? null);
    }
    setPendingValidationTargetId(targetId);
  };

  return (
    <div className="mx-auto w-full max-w-7xl">
      <ConfirmModal
        isOpen={confirmAction === "apply"}
        message="確定套用新學期編班嗎？學生目前班級與老師編制會一次切換；既有相本不會變更。"
        confirmLabel="確認套用"
        confirmVariant="success"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleApply}
      />
      <ConfirmModal
        isOpen={confirmAction === "cancel"}
        message="確定取消這份編班草稿嗎？目前名單與老師編制不會變更。"
        confirmLabel="取消草稿"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleCancel}
      />
      <ConfirmModal
        isOpen={confirmAction === "leave"}
        message="這份編班草稿有尚未儲存的變更。確定放棄變更並返回班級與名單嗎？"
        confirmLabel="放棄變更並離開"
        confirmVariant="danger"
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          setIsDirty(false);
          setConfirmAction(null);
          navigate("/admin/organization");
        }}
      />
      <ConfirmModal
        isOpen={confirmAction === "reload"}
        message="這份編班草稿有尚未儲存的變更。確定放棄變更並重新載入已儲存版本嗎？"
        confirmLabel="放棄變更並重新載入"
        confirmVariant="danger"
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          setIsDirty(false);
          setConfirmAction(null);
          void loadWorkspace();
        }}
      />
      <FormModal
        isOpen={Boolean(teacherEditor)}
        title={`調整老師：${teacherEditorClassroom?.campusName ?? ""}／${teacherEditorClassroom?.name ?? "班級"}`}
        onClose={() => setTeacherEditor(null)}
        maxWidthClass="max-w-xl"
      >
        {teacherEditor && (
          <form className="space-y-4" onSubmit={handleTeacherEditorSubmit}>
            <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs leading-5 text-indigo-700">
              這裡設定的是新學期目標編制；確認套用整份草稿前，不會改變目前相本權限。
            </p>
            <FormField label="主教" hint="有老師編制時必須恰好一位主教。">
              <select
                aria-label="主教"
                className={fieldControlClass}
                value={selectableTeacherIds.has(teacherEditorLead?.teacher_id)
                  ? teacherEditorLead.teacher_id
                  : ""}
                onChange={event => handleTeacherEditorLeadChange(event.target.value)}
              >
                <option value="">不設定老師</option>
                {teacherOptions.map(teacher => (
                  <option key={teacher.id} value={teacher.id}>{getAssignableAccountLabel(teacher)}</option>
                ))}
              </select>
            </FormField>
            <div>
              <div className="mb-1 text-xs font-medium text-gray-500">協同老師</div>
              <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {teacherOptions.map(teacher => {
                  const isLead = teacherEditorLead?.teacher_id === teacher.id;
                  return (
                    <label
                      key={teacher.id}
                      className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm ${isLead ? "border-indigo-100 bg-indigo-50 text-indigo-500" : "border-gray-200"}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={teacher.display_name}
                        checked={teacherEditorCoTeacherIds.has(teacher.id)}
                        disabled={isLead}
                        onChange={event => handleTeacherEditorCoTeacherChange(teacher.id, event.target.checked)}
                      />
                      <span className="min-w-0 truncate">{getAssignableAccountLabel(teacher)}</span>
                    </label>
                  );
                })}
              </div>
              {teacherOptions.length === 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  尚無可指派的老師帳號。
                </p>
              )}
            </div>
            {invalidTeacherEditorTargets.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="mb-2 text-xs font-semibold text-amber-800">已失效的老師目標</div>
                <div className="space-y-2">
                  {invalidTeacherEditorTargets.map(({ teacher, teacherIndex }) => (
                    <div key={`${teacher.teacher_id ?? "deleted"}-${teacherIndex}`} className="flex items-center justify-between gap-2 text-sm text-amber-900">
                      <span className="min-w-0 truncate">
                        {teacher.teacher_name ?? `已刪除老師 #${teacherIndex + 1}`} · {DUTY_LABELS[teacher.duty]}
                      </span>
                      <Button
                        size="xs"
                        variant="dangerSoft"
                        onClick={() => handleRemoveTeacherEditorTarget(teacherIndex)}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setTeacherEditor(null)}>取消</Button>
              <Button type="submit" variant="primary">套用老師設定</Button>
            </div>
          </form>
        )}
      </FormModal>

      <PageHeader
        icon={ArrowRightLeft}
        iconTone="review"
        title="新學期編班"
        subtitle="先預覽全園新學期目標狀態，確認後才一次切換；舊相本不會被改寫。"
        actions={(
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handleReturnToOrganization}>返回班級與名單</Button>
            <Button size="sm" onClick={handleRefresh} disabled={isSubmitting}>
              <RefreshCw className="h-4 w-4" />
              重新整理
            </Button>
          </div>
        )}
      />

      {loadError ? (
        <Surface className="mb-5 border-red-200 bg-red-50">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-red-900">無法載入編班工作區</h2>
              <p role="alert" className="mt-1 text-sm text-red-700">{loadError}</p>
            </div>
            <Button variant="dangerSoft" onClick={() => void loadWorkspace()}>
              <RefreshCw className="h-4 w-4" />
              重試載入
            </Button>
          </div>
        </Surface>
      ) : !plan ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Surface>
            <h2 className="text-lg font-semibold text-gray-900">建立編班草稿</h2>
            <p className="mt-1 text-sm leading-6 text-gray-500">
              系統會把目前每位學生預設留在原班，並複製各班目前老師編制。草稿期間不會改動正式資料。
            </p>
            <form className="mt-5 space-y-4" onSubmit={handleCreatePlan}>
              <FormField label="正式學期名稱" hint="這個名稱會出現在老師進度與學期彙整報表。">
                <input
                  className={fieldControlClass}
                  value={label}
                  maxLength={100}
                  onChange={event => setLabel(event.target.value)}
                  placeholder="例如：2026 學年度上學期"
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="開始日" hint="選填，供學期歷史辨識。">
                  <input
                    type="date"
                    className={fieldControlClass}
                    value={startsOn}
                    onChange={event => setStartsOn(event.target.value)}
                  />
                </FormField>
                <FormField label="結束日" hint="選填，需晚於開始日。">
                  <input
                    type="date"
                    className={fieldControlClass}
                    min={startsOn || undefined}
                    value={endsOn}
                    onChange={event => setEndsOn(event.target.value)}
                  />
                </FormField>
              </div>
              <Button type="submit" variant="review" disabled={isSubmitting || !label.trim()}>
                {isSubmitting ? "建立中..." : "從目前狀態建立草稿"}
              </Button>
            </form>
          </Surface>
          <Surface>
            <div className="mb-3 flex items-center gap-2">
              <School className="h-4 w-4 text-indigo-500" />
              <h2 className="font-semibold text-gray-900">可編入的目標班級</h2>
            </div>
            <p className="mb-3 text-xs leading-5 text-gray-500">建立草稿時已照目前的分校／部門／班名長出新學期的班。</p>
            <div className="space-y-2">
              {targetClassrooms.map(classroom => (
                <div key={classroom.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                  <div className="font-medium text-gray-800">{classroom.name}</div>
                  <div className="text-xs text-gray-400">{classroom.campusName}</div>
                </div>
              ))}
              {targetClassrooms.length === 0 && <p className="text-sm text-amber-700">這份草稿還沒有任何新學期班級。</p>}
            </div>
          </Surface>

        </div>
      ) : plan.status !== "draft" ? (
        <Surface className="border-emerald-200 bg-emerald-50">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
            <div>
              <h2 className="font-semibold text-emerald-900">{plan.label} 已套用</h2>
              <p className="mt-1 text-sm text-emerald-800">目前名單與老師編制已切換，接下來可從班級建立新一期相本。</p>
              <Button as={Link} to="/admin/organization" size="sm" variant="success" className="mt-4">
                前往建立新一期相本
              </Button>
            </div>
          </div>
        </Surface>
      ) : (
        <div className="space-y-5">
          <Surface>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-gray-900">{plan.label}</h2>
                  <Badge tone="warning">草稿 v{plan.revision}</Badge>
                  {isDirty && <Badge tone="warning">尚未儲存</Badge>}
                </div>
                <p className="mt-1 text-xs text-gray-500">所有調整仍是草稿；驗證與套用前會再次確認目前資料沒有被其他操作改變。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="dangerSoft" onClick={() => setConfirmAction("cancel")} disabled={isSubmitting}>
                  取消整份草稿
                </Button>
              </div>
            </div>
          </Surface>

          <Surface className={plan.target_semester?.periods?.length ? "border-indigo-100" : "border-amber-200 bg-amber-50"}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold text-gray-900">正式學期期別</h2>
                  <Badge tone={plan.target_semester?.periods?.length ? "info" : "warning"}>
                    {plan.target_semester?.periods?.length ?? 0} 個期別
                  </Badge>
                </div>
                {plan.target_semester?.periods?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {plan.target_semester.periods.map(period => (
                      <Badge key={period.id} tone="neutral">
                        {period.name} · {period.department === "infant" ? "嬰幼部" : "學院部"}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-amber-800">
                    這個新學期還沒有期別。請先到模板管理建立新期別；草稿存在期間，新期別會自動歸入這個學期。將期別設為「使用中」後再回來重新整理與驗證。
                  </p>
                )}
              </div>
              <Button as={Link} to="/templates" size="sm" variant="secondary">
                管理學期期別
              </Button>
            </div>
          </Surface>

          {plan.diff && (
            <Surface className={plan.validation?.is_valid ? "border-emerald-200" : "border-amber-200"}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="font-semibold text-gray-900">套用差異預覽</h2>
                <Badge tone={plan.validation?.is_valid ? "success" : "warning"}>
                  {plan.validation?.is_valid ? "驗證通過" : "需要修正"}
                </Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ["留班", studentDiff.stay],
                  ["轉班", studentDiff.move],
                  ["離園", studentDiff.departed],
                  ["新增老師", teacherDiff.add],
                  ["移除老師", teacherDiff.remove],
                  ["職責變更", teacherDiff.duty_change],
                ].map(([diffLabel, value]) => (
                  <div key={diffLabel} className="rounded-lg bg-gray-50 px-3 py-3 text-center">
                    <div className="text-xl font-bold text-gray-900">{getDiffCount(value)}</div>
                    <div className="text-xs text-gray-500">{diffLabel}</div>
                  </div>
                ))}
              </div>
              {classroomCounts.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold text-gray-800">各班學生人數</h3>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {classroomCounts.map(count => (
                      <div key={count.classroom_id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate text-gray-700">{getClassroomName(count.classroom_id)}</span>
                        <span className="ml-3 whitespace-nowrap font-semibold text-gray-900">
                          {count.before} → {count.after}
                          <span className={`ml-1 text-xs ${count.change > 0 ? "text-emerald-600" : count.change < 0 ? "text-amber-600" : "text-gray-400"}`}>
                            ({count.change > 0 ? "+" : ""}{count.change})
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(getDiffCount(studentDiff.move) > 0 || getDiffCount(studentDiff.departed) > 0) && (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  <section className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
                    <h3 className="mb-2 text-sm font-semibold text-indigo-900">轉班明細</h3>
                    <ul className="space-y-1.5 text-sm text-indigo-800">
                      {(studentDiff.move ?? []).map(row => (
                        <li key={row.source_member_id}>{getStudentDiffLabel(row)}</li>
                      ))}
                      {getDiffCount(studentDiff.move) === 0 && <li className="text-indigo-400">沒有轉班學生</li>}
                    </ul>
                  </section>
                  <section className="rounded-lg border border-amber-100 bg-amber-50/60 p-3">
                    <h3 className="mb-2 text-sm font-semibold text-amber-900">離園／畢業明細</h3>
                    <ul className="space-y-1.5 text-sm text-amber-800">
                      {(studentDiff.departed ?? []).map(row => (
                        <li key={row.source_member_id}>{getStudentDiffLabel(row)}</li>
                      ))}
                      {getDiffCount(studentDiff.departed) === 0 && <li className="text-amber-400">沒有離園學生</li>}
                    </ul>
                  </section>
                </div>
              )}
              {(getDiffCount(teacherDiff.add) > 0 || getDiffCount(teacherDiff.remove) > 0 || getDiffCount(teacherDiff.duty_change) > 0) && (
                <div className="mt-4 rounded-lg border border-violet-100 bg-violet-50/60 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-violet-900">老師編制異動明細</h3>
                  <ul className="grid gap-1.5 text-sm text-violet-800 lg:grid-cols-2">
                    {(teacherDiff.add ?? []).map(row => (
                      <li key={`add-${row.classroom_id}-${row.teacher_id}`}>
                        {getClassroomName(row.classroom_id)}：新增 {row.teacher_name}（{DUTY_LABELS[row.duty]}）
                      </li>
                    ))}
                    {(teacherDiff.remove ?? []).map(row => (
                      <li key={`remove-${row.classroom_id}-${row.teacher_id}`}>
                        {getClassroomName(row.classroom_id)}：移除 {row.teacher_name}（{DUTY_LABELS[row.duty]}）
                      </li>
                    ))}
                    {(teacherDiff.duty_change ?? []).map(row => (
                      <li key={`duty-${row.classroom_id}-${row.teacher_id}`}>
                        {getClassroomName(row.classroom_id)}：{row.teacher_name} {DUTY_LABELS[row.from_duty]} → {DUTY_LABELS[row.to_duty]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {validationErrors.length > 0 && (
                <ul className="mt-4 space-y-2 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">
                  {validationErrors.map((error, errorIndex) => {
                    const targetId = getValidationTargetId(error);
                    return (
                      <li key={`${error?.code ?? "error"}-${errorIndex}`} className="flex items-start justify-between gap-3">
                        <span>• {getValidationErrorMessage(error)}</span>
                        {targetId && (
                          <button
                            type="button"
                            className="flex-shrink-0 font-medium text-red-800 underline underline-offset-2"
                            onClick={() => scrollToValidationTarget(error)}
                          >
                            前往修正
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Surface>
          )}

          <Surface>
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900">學生目標班級</h2>
                <p className="mt-0.5 text-xs text-gray-500">依目前班級逐班調整；每位學生必須選擇一個目標班級或標記離園。</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 sm:w-64">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    type="search"
                    value={studentSearchText}
                    onChange={event => setStudentSearchText(event.target.value)}
                    placeholder="搜尋學生或班級"
                    aria-label="搜尋學生或班級"
                    className={`${fieldControlClass} pl-9`}
                  />
                </div>
                <label className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 max-sm:min-h-11">
                  <input
                    type="checkbox"
                    checked={isShowingChangedStudentsOnly}
                    onChange={event => setIsShowingChangedStudentsOnly(event.target.checked)}
                  />
                  僅顯示有變更
                </label>
                <Badge tone="info">{plan.student_placements.length} 位</Badge>
              </div>
            </div>
            <div className="space-y-2">
              {visibleStudentPlacementGroups.map(group => {
                const isExpanded = group.classroomId === visibleExpandedStudentClassroomId;
                const groupPanelId = `term-student-group-${group.classroomId}`;
                return (
                  <section key={group.classroomId} className="overflow-hidden rounded-xl border border-gray-200">
                    <button
                      type="button"
                      className="flex min-h-12 w-full items-center gap-3 bg-gray-50 px-3 py-2.5 text-left hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                      aria-label={`編輯 ${group.campusName}／${group.classroomName} 學生目標班級`}
                      aria-expanded={isExpanded}
                      aria-controls={groupPanelId}
                      onClick={() => setExpandedStudentClassroomId(group.classroomId)}
                    >
                      {isExpanded
                        ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                        : <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-gray-900">{group.classroomName}</span>
                        <span className="block truncate text-xs text-gray-400">{group.campusName}</span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-1.5">
                        {group.changedCount > 0 && <Badge tone="warning">{group.changedCount} 位變更</Badge>}
                        <Badge tone="neutral">{group.filteredPlacements.length}/{group.placements.length} 位</Badge>
                      </span>
                    </button>
                    {isExpanded && (
                      <div id={groupPanelId} className="divide-y divide-gray-100">
                        {group.filteredPlacements.map(placement => {
                          const isChanged = isStudentPlacementChanged(placement);
                          return (
                            <div
                              key={placement.source_member_id}
                              id={`term-student-${placement.source_member_id}`}
                              tabIndex={-1}
                              className="grid scroll-mt-24 gap-3 px-3 py-3 outline-none focus:bg-amber-50 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)] sm:items-center"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-medium text-gray-900">{placement.student_name}</span>
                                {isChanged && <Badge tone="warning">已變更</Badge>}
                              </div>
                              <select
                                aria-label={`${placement.student_name} 的目標班級`}
                                className={fieldControlClass}
                                value={placement.outcome === "departed" ? "departed" : String(placement.target_classroom_id)}
                                onChange={event => handleStudentTargetChange(placement.source_member_id, event.target.value)}
                              >
                                {targetClassrooms.map(classroom => (
                                  <option key={classroom.id} value={classroom.id}>{classroom.campusName}／{classroom.name}</option>
                                ))}
                                <option value="departed">離園／畢業，不編入班級</option>
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
              {visibleStudentPlacementGroups.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                  沒有符合目前篩選條件的學生
                </div>
              )}
            </div>
          </Surface>

          <Surface>
            <div className="mb-4 flex items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-gray-900">新學期老師編制</h2>
                <p className="mt-0.5 text-xs text-gray-500">非空編制必須指定一位主教；其他老師可設為協同。</p>
              </div>
              <Users className="h-5 w-5 text-indigo-500" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {plan.classroom_teacher_targets.map(target => {
                const classroom = classroomById.get(target.classroom_id);
                const lead = target.teachers.find(teacher => teacher.duty === "lead");
                const coTeachers = target.teachers.filter(teacher => teacher.duty === "co_teacher");
                const invalidTeachers = target.teachers
                  .filter(teacher => (
                    teacher.teacher_id === null || !selectableTeacherIds.has(teacher.teacher_id)
                  ));
                const getTeacherTargetLabel = teacher => {
                  const teacherOption = teacherOptionById.get(teacher?.teacher_id);
                  return teacherOption
                    ? getAssignableAccountLabel(teacherOption)
                    : (teacher?.teacher_name ?? "已刪除老師");
                };
                return (
                  <section
                    key={target.classroom_id}
                    id={`term-classroom-${target.classroom_id}`}
                    tabIndex={-1}
                    aria-label={classroom
                      ? `新學期老師編制 ${classroom.campusName}／${classroom.name}`
                      : `新學期老師編制 班級 #${target.classroom_id}`}
                    className="scroll-mt-24 rounded-xl border border-gray-200 p-4 outline-none focus:border-amber-300 focus:bg-amber-50/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold text-gray-900">{classroom?.name ?? `班級 #${target.classroom_id}`}</h3>
                        <p className="text-xs text-gray-400">{classroom?.campusName}</p>
                      </div>
                      {invalidTeachers.length > 0
                        ? <Badge tone="warning">{invalidTeachers.length} 筆需修正</Badge>
                        : <Badge tone={lead ? "success" : "neutral"}>{lead ? "已設定" : "尚無老師"}</Badge>}
                    </div>
                    <dl className="mt-4 space-y-2 text-sm">
                      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                        <dt className="text-gray-400">主教</dt>
                        <dd className="truncate font-medium text-gray-800">{lead ? getTeacherTargetLabel(lead) : "未設定"}</dd>
                      </div>
                      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                        <dt className="text-gray-400">協同老師</dt>
                        <dd className="flex min-w-0 flex-wrap gap-1.5">
                          {coTeachers.map((teacher, teacherIndex) => (
                            <Badge key={`${teacher.teacher_id ?? "deleted"}-${teacherIndex}`} tone="info">
                              {getTeacherTargetLabel(teacher)}
                            </Badge>
                          ))}
                          {coTeachers.length === 0 && <span className="text-gray-500">無</span>}
                        </dd>
                      </div>
                    </dl>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-4"
                      onClick={() => handleOpenTeacherEditor(target.classroom_id)}
                    >
                      <Pencil className="h-4 w-4" />
                      調整老師
                    </Button>
                  </section>
                );
              })}
            </div>
          </Surface>

          <div className="sticky bottom-2 z-20 pb-1">
            <Surface variant="toolbar" padding="sm" className="border-indigo-100 shadow-lg shadow-indigo-100/60">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-xs" aria-live="polite">
                  {isDirty ? (
                    <span className="font-medium text-amber-700">有尚未儲存的變更</span>
                  ) : plan.validation?.is_valid ? (
                    <span className="font-medium text-emerald-700">已儲存且驗證通過，可以套用</span>
                  ) : (
                    <span className="text-gray-500">調整完成後，請先儲存並預覽差異</span>
                  )}
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-shrink-0">
                  <Button size="sm" onClick={() => void handleSave()} disabled={isSubmitting || !isDirty}>
                    <Save className="h-4 w-4" />儲存草稿
                  </Button>
                  <Button size="sm" variant="review" onClick={() => void handleValidate()} disabled={isSubmitting}>
                    <ClipboardCheck className="h-4 w-4" />預覽並驗證
                  </Button>
                  <Button
                    size="sm"
                    variant="success"
                    className="col-span-2"
                    disabled={isSubmitting || isDirty || !plan.validation?.is_valid}
                    onClick={() => setConfirmAction("apply")}
                  >
                    確認套用新學期編班
                  </Button>
                </div>
              </div>
            </Surface>
          </div>
        </div>
      )}
    </div>
  );
}
