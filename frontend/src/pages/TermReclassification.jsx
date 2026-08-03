// 新學期編班：先編輯全園目標狀態，驗證差異後再一次套用。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  ArrowRightLeft,
  CheckCircle2,
  ClipboardCheck,
  RefreshCw,
  Save,
  School,
  Search,
} from "lucide-react";

import {
  applyTermReclassificationPlan,
  batchAddClassroomMembers,
  cancelTermReclassificationPlan,
  createClassroom,
  createTermReclassificationPlan,
  deleteClassroom,
  fetchOrganizationOverview,
  reorderClassrooms,
  updateClassroom,
  deleteDraftClassroomMember,
  fetchTermReclassificationPlan,
  updateTermReclassificationPlan,
  validateTermReclassificationPlan,
} from "../api/organizationApi";
import ConfirmModal from "../components/ConfirmModal";
import TermPlacementBoard from "../components/TermPlacementBoard";
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

// 來源班與目標班分屬不同學期，id 直接比不出有沒有換班。後端給的 stay_classroom_id
// 是「來源班在目標學期的對應班」，與使用者目前選了什麼無關——搬走再改回來也認得出。
const isStudentPlacementChanged = placement => (
  placement.outcome === "departed"
  || placement.target_classroom_id !== placement.stay_classroom_id
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
  const [teacherEditor, setTeacherEditor] = useState(null);
  const [pendingValidationTargetId, setPendingValidationTargetId] = useState(null);
  const [classroomDraft, setClassroomDraft] = useState(null);
  const [newStudentDraft, setNewStudentDraft] = useState(null);
  // 每次本地編輯都遞增；用來辨認「儲存回應回來時，本地是不是又動過了」
  const saveGenerationRef = useRef(0);
  const [focusAttempt, setFocusAttempt] = useState(0);
  // 看板的分校分頁：放在頁面層才不會被載入狀態的卸載重置
  const [activeCampusTab, setActiveCampusTab] = useState(null);
  const reorderGenerationRef = useRef(0);

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
    if (!pendingValidationTargetId) return undefined;
    const target = document.getElementById(pendingValidationTargetId);
    if (!target) {
      // 目標可能在別的分校分頁上，看板要先切過去才會 render。重試幾次再放棄——
      // 只試一次的話，切分頁不會重新觸發這個 effect，永遠定位不到。
      if (focusAttempt >= 8) {
        setPendingValidationTargetId(null);
        return undefined;
      }
      const retry = setTimeout(() => setFocusAttempt(count => count + 1), 120);
      return () => clearTimeout(retry);
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    setPendingValidationTargetId(null);
    setFocusAttempt(0);
    return undefined;
  }, [pendingValidationTargetId, focusAttempt]);

  // 可編入的是目標學期新建的班，不是目前學期那份清單
  const targetClassrooms = useMemo(
    () => (plan?.target_classrooms ?? []).map(classroom => ({
      id: classroom.classroom_id,
      name: classroom.name,
      department: classroom.department,
      campusId: classroom.campus_id,
      campusName: classroom.campus_name,
      // 可不可以移除由後端算，前端不自己再判一次——規則兩邊各一份就會走岔
      canRemove: classroom.can_remove !== false,
    })),
    [plan?.target_classrooms],
  );
  const teacherOptions = useMemo(
    () => overview?.teacher_options ?? [],
    [overview?.teacher_options],
  );
  const currentClassrooms = useMemo(
    () => (overview?.campuses ?? []).flatMap(campus => (
      campus.classrooms.map(classroom => ({
        id: classroom.id,
        name: classroom.name,
        campusName: campus.name,
      }))
    )),
    [overview?.campuses],
  );
  const campusOptions = useMemo(
    () => (overview?.campuses ?? [])
      .filter(campus => campus.is_active)
      .map(campus => ({ id: campus.id, name: campus.name })),
    [overview?.campuses],
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
  // 看板是一欄一個目標班級，不再依來源班分組；搜尋與篩選直接作用在卡片上
  const visibleBoardPlacements = useMemo(() => {
    const normalizedQuery = normalizeSearchText(studentSearchText);
    return (plan?.student_placements ?? []).filter(placement => {
      if (isShowingChangedStudentsOnly && !isStudentPlacementChanged(placement)) return false;
      if (!normalizedQuery) return true;
      const target = placement.outcome === "departed"
        ? "離園"
        : (() => {
          const classroom = classroomById.get(placement.target_classroom_id);
          return classroom ? `${classroom.campusName}${classroom.name}` : "";
        })();
      return normalizeSearchText([
        placement.student_name,
        placement.source_campus_name,
        placement.source_classroom_name,
        target,
      ].join("")).includes(normalizedQuery);
    });
  }, [classroomById, isShowingChangedStudentsOnly, plan?.student_placements, studentSearchText]);

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
    saveGenerationRef.current += 1;
    setPlan(currentPlan => {
      const nextPlan = updater(currentPlan);
      return { ...nextPlan, validation: null, diff: null };
    });
    setIsDirty(true);
  };

  const handleStudentTargetChange = (sourceMemberIds, value) => {
    const targets = new Set(sourceMemberIds);
    markPlanEdited(currentPlan => ({
      ...currentPlan,
      student_placements: currentPlan.student_placements.map(placement => {
        if (!targets.has(placement.source_member_id)) return placement;
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

  const handleAddTargetClassroom = async (event) => {
    event.preventDefault();
    const name = classroomDraft.name.trim();
    if (!name) return;
    // 增班會改動草稿的班級集合，之後必須重載；先擋住未儲存的編輯免得被蓋掉
    if (isDirty) {
      toast.error("請先儲存草稿，再增減班級。");
      return;
    }
    setIsSubmitting(true);
    try {
      await createClassroom({
        campus_id: Number(classroomDraft.campusId),
        department: classroomDraft.department,
        name,
        semester_id: plan.target_semester_id,
      });
      setClassroomDraft(null);
      await loadWorkspace();
      toast.success("已新增新學期班級");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "新增班級失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // 新生：名冊裡還沒有的孩子，直接編進新學期的班。他們不是 placement（沒有來源名單
  // 列），套用時不會被動到，會原封不動留在新學期。
  const handleAddNewStudents = async (event) => {
    event.preventDefault();
    const names = newStudentDraft.text
      .split(/[\n,、，]/)
      .map(name => name.trim())
      .filter(Boolean);
    if (!names.length) return;
    if (isDirty) {
      toast.error("請先儲存草稿，再編入新生。");
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await batchAddClassroomMembers(
        newStudentDraft.classroomId,
        names.map(name => ({ name })),
      );
      setNewStudentDraft(null);
      await loadWorkspace();
      const skipped = response.data?.skipped_names ?? [];
      if (skipped.length) {
        toast.error(`${skipped.length} 位重名未編入：${skipped.join("、")}`);
      } else {
        toast.success(`已編入 ${names.length} 位新生`);
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, "編入新生失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveNewStudent = async (classroomId, student) => {
    if (isDirty) {
      toast.error("請先儲存草稿，再移除新生。");
      return;
    }
    setIsSubmitting(true);
    try {
      await deleteDraftClassroomMember(classroomId, student.member_id);
      await loadWorkspace();
      toast.success(`已移除新生 ${student.name}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "移除新生失敗"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // 改名與調順序都不重載：loadWorkspace 會把伺服器版本蓋回來，
  // 未儲存的學生編班與老師調整會被無聲丟掉。這兩件事不影響草稿內容，本地更新即可。
  const handleRenameTargetClassroom = async (classroomId, name) => {
    const previous = plan.target_classrooms;
    setPlan(currentPlan => ({
      ...currentPlan,
      target_classrooms: currentPlan.target_classrooms.map(classroom => (
        classroom.classroom_id === classroomId ? { ...classroom, name } : classroom
      )),
    }));
    try {
      await updateClassroom(classroomId, { name });
    } catch (error) {
      setPlan(currentPlan => ({ ...currentPlan, target_classrooms: previous }));
      toast.error(getApiErrorMessage(error, "更新班級名稱失敗"));
    }
  };

  const handleReorderTargetClassrooms = async (classroomIds) => {
    const previous = plan.target_classrooms;
    const byId = new Map(previous.map(classroom => [classroom.classroom_id, classroom]));
    // 連按 ‹ › 會送出多個請求；沒有序號的話，先送的後到就會把最後一次操作蓋掉，
    // 失敗回滾也可能蓋掉之後成功的狀態。只有最後一次請求的結果算數。
    const attempt = ++reorderGenerationRef.current;
    setPlan(currentPlan => ({
      ...currentPlan,
      target_classrooms: classroomIds.map(id => byId.get(id)).filter(Boolean),
    }));
    try {
      await reorderClassrooms(plan.target_semester_id, classroomIds);
    } catch (error) {
      if (attempt !== reorderGenerationRef.current) return;
      setPlan(currentPlan => ({ ...currentPlan, target_classrooms: previous }));
      toast.error(getApiErrorMessage(error, "調整班級順序失敗"));
    }
  };

  // 拖到沒有主教的班就成為主教（驗證要求非空編制必須有一位），否則成為協同。
  // 主教唯一是 DB 唯一鍵擋著的，這裡先算好才不會送出去才被拒絕。
  const handleMoveTeachers = (items, toClassroomId) => {
    markPlanEdited((currentPlan) => {
      const destination = currentPlan.classroom_teacher_targets
        .find(target => target.classroom_id === toClassroomId);
      if (!destination) return currentPlan;
      const alreadyThere = new Set(destination.teachers.map(teacher => teacher.teacher_id));
      // 同一位老師可能同時掛在多個來源班；一次搬到第三班時會變成同班重複，
      // 後端會直接拒絕整份草稿。這裡先去重。
      const seen = new Set();
      const moving = items
        .filter((item) => {
          if (item.fromClassroomId === toClassroomId) return false;
          if (alreadyThere.has(item.teacherId) || seen.has(item.teacherId)) return false;
          seen.add(item.teacherId);
          return true;
        })
        .map(item => ({
          ...item,
          teacher: currentPlan.classroom_teacher_targets
            .find(target => target.classroom_id === item.fromClassroomId)
            ?.teachers.find(teacher => teacher.teacher_id === item.teacherId),
        }))
        .filter(item => item.teacher);
      if (!moving.length) return currentPlan;
      // 目標班沒有主教時由這批的第一位補上；主教唯一是 DB 唯一鍵擋著的
      let needsLead = !destination.teachers.some(teacher => teacher.duty === "lead");
      const arrivals = moving.map((item) => {
        const duty = needsLead ? "lead" : "co_teacher";
        needsLead = false;
        return { ...item.teacher, duty };
      });
      const removedByClassroom = new Map();
      for (const item of moving) {
        const bucket = removedByClassroom.get(item.fromClassroomId) ?? new Set();
        bucket.add(item.teacherId);
        removedByClassroom.set(item.fromClassroomId, bucket);
      }
      return {
        ...currentPlan,
        classroom_teacher_targets: currentPlan.classroom_teacher_targets.map((target) => {
          if (target.classroom_id === toClassroomId) {
            return { ...target, teachers: [...target.teachers, ...arrivals] };
          }
          const removed = removedByClassroom.get(target.classroom_id);
          if (!removed) return target;
          const remaining = target.teachers.filter(
            teacher => !removed.has(teacher.teacher_id),
          );
          // 把來源班的主教搬走之後，剩下的協同要遞補主教——非空編制必須恰有一位，
          // 不補的話這份草稿一定驗證失敗，而使用者不會知道問題出在剛才那一拖。
          if (remaining.length && !remaining.some(teacher => teacher.duty === "lead")) {
            return {
              ...target,
              teachers: remaining.map((teacher, index) => (
                index === 0 ? { ...teacher, duty: "lead" } : teacher
              )),
            };
          }
          return { ...target, teachers: remaining };
        }),
      };
    });
  };

  // 一個班只能有一位主教（DB 唯一鍵擋著，驗證也要求非空編制恰有一位），
  // 所以升主教必然伴隨原主教降為協同——是換人當，不是各自開關。
  const handlePromoteTeacher = (teacherId, classroomId) => {
    markPlanEdited(currentPlan => ({
      ...currentPlan,
      classroom_teacher_targets: currentPlan.classroom_teacher_targets.map(target => {
        if (target.classroom_id !== classroomId) return target;
        if (target.teachers.every(teacher => teacher.teacher_id !== teacherId)) return target;
        return {
          ...target,
          teachers: target.teachers.map(teacher => ({
            ...teacher,
            duty: teacher.teacher_id === teacherId ? "lead" : "co_teacher",
          })),
        };
      }),
    }));
  };

  const handleRemoveTargetClassroom = async (classroomId) => {
    if (isDirty) {
      toast.error("請先儲存草稿，再增減班級。");
      return;
    }
    setIsSubmitting(true);
    try {
      await deleteClassroom(classroomId);
      await loadWorkspace();
      toast.success("已移除新學期班級");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "移除班級失敗"));
    } finally {
      setIsSubmitting(false);
    }
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
    // 記下送出當下的內容；回來後只有在期間沒有新編輯時才採用伺服器版本。
    // 不擋的話，慢回應會把送出後才做的調整覆寫掉，還顯示成「已儲存」。
    const submittedAt = ++saveGenerationRef.current;
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
    if (submittedAt !== saveGenerationRef.current) {
      // 期間又動過：伺服器已存下送出時的版本，但本地還有更新的內容。
      // 保留本地編輯與 dirty 狀態，只把 revision 對齊，讓下一次儲存不會撞 revision。
      setPlan(currentPlan => ({ ...currentPlan, revision: response.data.revision }));
      toast("儲存期間又有新的調整，請再存一次。", { icon: "✏️" });
      return response.data;
    }
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
      const validatedAt = saveGenerationRef.current;
      const response = await validateTermReclassificationPlan(savedPlan.id);
      if (validatedAt !== saveGenerationRef.current) {
        // 驗證期間又動過：驗證結果講的是舊版本，套上去等於丟掉新編輯
        toast("驗證期間又有新的調整，請重新驗證。", { icon: "✏️" });
        return;
      }
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
      // 卡片可能被搜尋或篩選藏起來；先清掉條件，捲動才找得到那張卡片
      setStudentSearchText("");
      setIsShowingChangedStudentsOnly(false);
    }
    setFocusAttempt(0);
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
              <h2 className="font-semibold text-gray-900">會被複製到新學期的班級</h2>
            </div>
            <p className="mb-3 text-xs leading-5 text-gray-500">
              建立草稿時會照目前的分校／部門／班名，在新學期長出對應的班；之後可以在草稿裡增減。
            </p>
            <div className="space-y-2">
              {currentClassrooms.map(classroom => (
                <div key={classroom.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                  <div className="font-medium text-gray-800">{classroom.name}</div>
                  <div className="text-xs text-gray-400">{classroom.campusName}</div>
                </div>
              ))}
              {currentClassrooms.length === 0 && (
                <p className="text-sm text-amber-700">目前學期還沒有班級。</p>
              )}
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

          {classroomDraft !== null && (
            <Surface>
              <h2 className="mb-2 font-semibold text-gray-900">新增新學期班級</h2>
              <form className="space-y-2" onSubmit={handleAddTargetClassroom}>
                <FormField label="所屬分校">
                  <select
                    required
                    value={classroomDraft.campusId}
                    onChange={event => setClassroomDraft(current => ({ ...current, campusId: event.target.value }))}
                    className={fieldControlClass}
                  >
                    {campusOptions.map(campus => (
                      <option key={campus.id} value={campus.id}>{campus.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="部門">
                  <select
                    required
                    value={classroomDraft.department}
                    onChange={event => setClassroomDraft(current => ({ ...current, department: event.target.value }))}
                    className={fieldControlClass}
                  >
                    <option value="infant">嬰幼部</option>
                    <option value="academy">學院部</option>
                  </select>
                </FormField>
                <FormField label="班級名稱">
                  <input
                    autoFocus
                    required
                    value={classroomDraft.name}
                    onChange={event => setClassroomDraft(current => ({ ...current, name: event.target.value }))}
                    className={fieldControlClass}
                  />
                </FormField>
                <div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => setClassroomDraft(null)} disabled={isSubmitting}>
                    取消
                  </Button>
                  <Button size="sm" type="submit" variant="primary" disabled={isSubmitting}>
                    {isSubmitting ? "新增中..." : "新增"}
                  </Button>
                </div>
              </form>
            </Surface>
          )}

          {newStudentDraft !== null && (
            <Surface>
              <h2 className="mb-1 font-semibold text-gray-900">
                編入新生：{newStudentDraft.label}
              </h2>
              <p className="mb-2 text-xs text-gray-500">
                只給名冊裡還沒有的孩子用。續讀的孩子請從原班拖過來，不要在這裡重打一次姓名——
                重打會變成另一個孩子，跟舊相本接不起來。
              </p>
              <form className="space-y-2" onSubmit={handleAddNewStudents}>
                <FormField label="姓名" hint="一行一位，也可以用逗號分隔。">
                  <textarea
                    autoFocus
                    required
                    rows={4}
                    value={newStudentDraft.text}
                    onChange={event => setNewStudentDraft(current => ({ ...current, text: event.target.value }))}
                    className={fieldControlClass}
                  />
                </FormField>
                <div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => setNewStudentDraft(null)} disabled={isSubmitting}>
                    取消
                  </Button>
                  <Button size="sm" type="submit" variant="primary" disabled={isSubmitting}>
                    {isSubmitting ? "編入中..." : "編入"}
                  </Button>
                </div>
              </form>
            </Surface>
          )}

          <Surface>
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900">學生目標班級</h2>
                <p className="mt-0.5 text-xs text-gray-500">拖曳學生卡片到目標班級即完成編班；每位學生都要落在一個班或「離園」欄。</p>
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
            <TermPlacementBoard
              placements={visibleBoardPlacements}
              classrooms={targetClassrooms}
              campuses={campusOptions}
              activeTab={activeCampusTab}
              onActiveTabChange={setActiveCampusTab}
              focusClassroomId={
                pendingValidationTargetId?.startsWith("term-classroom-")
                  ? Number(pendingValidationTargetId.replace("term-classroom-", ""))
                  : null
              }
              teacherTargets={plan.classroom_teacher_targets}
              // 標籤只放姓名：欄寬有限，「・帶班老師」在這裡每一個都一樣，是雜訊
              teacherLabelOf={teacher => (
                teacherOptionById.get(teacher.teacher_id)?.display_name
                  ?? teacher.teacher_name
                  ?? "已刪除老師"
              )}
              onMovePlacements={handleStudentTargetChange}
              onMoveTeachers={handleMoveTeachers}
              onPromoteTeacher={handlePromoteTeacher}
              onRenameClassroom={handleRenameTargetClassroom}
              onRemoveClassroom={handleRemoveTargetClassroom}
              onAddClassroom={(campusId) => {
                // 擋在開表單的當下，不要讓人填完才被告知
                if (isDirty) {
                  toast.error("請先儲存草稿，再增減班級。");
                  return;
                }
                setClassroomDraft({
                  campusId: String(campusId ?? campusOptions[0]?.id ?? ""),
                  department: "infant",
                  name: "",
                });
              }}
              onReorderClassrooms={handleReorderTargetClassrooms}
              onEditTeachers={handleOpenTeacherEditor}
              newStudents={plan.new_students}
              onAddNewStudents={(classroomId) => {
                if (isDirty) {
                  toast.error("請先儲存草稿，再編入新生。");
                  return;
                }
                setNewStudentDraft({
                  classroomId,
                  label: getClassroomName(classroomId),
                  text: "",
                });
              }}
              onRemoveNewStudent={handleRemoveNewStudent}
              isSubmitting={isSubmitting}
            />
            {visibleBoardPlacements.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                沒有符合目前篩選條件的學生
              </div>
            )}
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
