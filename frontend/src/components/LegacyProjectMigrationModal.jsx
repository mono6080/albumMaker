import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  Search,
  Sparkles,
  UserRoundPlus,
} from "lucide-react";

import {
  assignProjectToClassroom,
  fetchProjectClassroomMigrationPreview,
} from "../api/organizationApi";
import { getApiErrorMessage } from "../utils/apiError";
import {
  applyUniqueTargetNameCandidates,
  candidateEvidenceSummary,
  createUndecidedIdentityDecisions,
  findUniqueTargetNameCandidateId,
  normalizeMigrationIdentityName,
  retainValidIdentityDecisions,
  summarizeIdentityDecisions,
} from "../utils/legacyProjectMigration";
import FormModal from "./FormModal";
import {
  Badge,
  Button,
  FormField,
  fieldControlClass,
} from "./ui";

const PAGE_SIZE = 25;

const DEPARTMENT_LABELS = {
  infant: "嬰幼部",
  academy: "學院部",
};

function decisionSelectValue(decision) {
  if (!decision) return "";
  return decision.action === "create_new"
    ? "create_new"
    : `existing:${decision.roster_child_id}`;
}

function decisionFromSelectValue(value) {
  if (!value) return null;
  if (value === "create_new") return { action: "create_new" };
  return { action: "existing", roster_child_id: Number(value.split(":")[1]) };
}

function StepIndicator({ step }) {
  const labels = ["選擇班級", "核對學生身分", "確認遷移"];
  return (
    <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="舊相本歸班步驟">
      {labels.map((label, index) => {
        const itemStep = index + 1;
        const isCurrent = step === itemStep;
        const isComplete = step > itemStep;
        return (
          <li
            key={label}
            aria-current={isCurrent ? "step" : undefined}
            className={`rounded-lg border px-3 py-2 text-xs font-medium ${
              isCurrent
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : isComplete
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 bg-gray-50 text-gray-400"
            }`}
          >
            <span className="mr-1.5">{isComplete ? "✓" : itemStep}.</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function CandidateEvidence({ candidate }) {
  if (!candidate) return null;
  return (
    <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
      <div className="font-medium">
        已選：{candidate.name}（身分 #{candidate.roster_child_id}）
      </div>
      <div className="text-sky-700">證據：{candidateEvidenceSummary(candidate)}</div>
    </div>
  );
}

function StudentIdentityRow({
  student,
  decision,
  candidatesById,
  establishedCandidates,
  duplicateExistingIds,
  onDecisionChange,
}) {
  const allowedCandidates = (student.allowed_existing_roster_child_ids ?? [])
    .map(candidateId => candidatesById.get(candidateId))
    .filter(Boolean);
  const selectedCandidate = decision?.action === "existing"
    ? candidatesById.get(decision.roster_child_id)
    : null;
  const uniqueTargetCandidateId = findUniqueTargetNameCandidateId(
    student,
    establishedCandidates,
  );
  const uniqueTargetCandidate = uniqueTargetCandidateId === null
    ? null
    : candidatesById.get(uniqueTargetCandidateId);
  const hasDuplicateDecision = decision?.action === "existing"
    && duplicateExistingIds.includes(decision.roster_child_id);

  return (
    <div
      role="group"
      aria-label={`學生身分 ${student.name}`}
      className={`rounded-xl border px-3 py-3 ${
        hasDuplicateDecision ? "border-red-300 bg-red-50/40" : "border-gray-200 bg-white"
      }`}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(18rem,1.4fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900">{student.name}</span>
            <Badge tone="neutral">第 {(student.order_index ?? 0) + 1} 位</Badge>
            {!decision && <Badge tone="warning">未決定</Badge>}
          </div>
          {student.original_roster_child ? (
            <p className="mt-1 text-xs leading-5 text-amber-700">
              舊資料曾依姓名推定身分 #{student.original_roster_child.id}
              （{student.original_roster_child.name}）；本次不會自動沿用。
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-400">舊資料沒有可採信的名冊身分。</p>
          )}
        </div>

        <div className="min-w-0">
          <label className="block text-xs font-medium text-gray-500">
            身分決定
            <select
              value={decisionSelectValue(decision)}
              onChange={event => onDecisionChange(decisionFromSelectValue(event.target.value))}
              className={`${fieldControlClass} mt-1`}
              aria-label={`學生身分決定：${student.name}`}
            >
              <option value="">未決定</option>
              <option value="create_new">建立全新身分（不與舊期自動合併）</option>
              {allowedCandidates.map(candidate => (
                <option
                  key={candidate.roster_child_id}
                  value={`existing:${candidate.roster_child_id}`}
                >
                  {candidate.name}（#{candidate.roster_child_id}；{candidateEvidenceSummary(candidate)}）
                </option>
              ))}
            </select>
          </label>

          {uniqueTargetCandidate && decision?.roster_child_id !== uniqueTargetCandidateId && (
            <Button
              size="xs"
              variant="infoSoft"
              className="mt-2"
              onClick={() => onDecisionChange({
                action: "existing",
                roster_child_id: uniqueTargetCandidateId,
              })}
            >
              <Sparkles className="h-3.5 w-3.5" />
              套用目標班唯一同名：{uniqueTargetCandidate.name}
            </Button>
          )}

          {decision?.action === "create_new" && (
            <p className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-xs leading-5 text-violet-700">
              將建立獨立的孩子身分；不會因同名與其他相本合併。
            </p>
          )}
          <CandidateEvidence candidate={selectedCandidate} />
          {hasDuplicateDecision && (
            <p className="mt-2 text-xs font-medium text-red-700">
              同一本相本有兩位學生選到同一身分，請重新核對。
            </p>
          )}

          {allowedCandidates.length > 0 && (
            <details className="mt-2 text-xs text-gray-500">
              <summary className="cursor-pointer select-none font-medium text-gray-600">
                查看 {allowedCandidates.length} 個既有身分的班級／相本證據
              </summary>
              <div className="mt-2 space-y-2">
                {allowedCandidates.map(candidate => (
                  <div
                    key={candidate.roster_child_id}
                    className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium text-gray-800">
                        {candidate.name}（#{candidate.roster_child_id}）
                      </div>
                      <div className="mt-0.5 leading-5 text-gray-500">
                        {candidateEvidenceSummary(candidate)}
                      </div>
                    </div>
                    <Button
                      size="xs"
                      onClick={() => onDecisionChange({
                        action: "existing",
                        roster_child_id: candidate.roster_child_id,
                      })}
                    >
                      選擇此身分
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LegacyProjectMigrationModal({
  isOpen,
  project,
  classrooms,
  onClose,
  onMigrated,
}) {
  const [step, setStep] = useState(1);
  const [targetClassroomId, setTargetClassroomId] = useState("");
  const [isSeedingCurrentRoster, setIsSeedingCurrentRoster] = useState(false);
  const [preview, setPreview] = useState(null);
  const [identityDecisions, setIdentityDecisions] = useState({});
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showOnlyUndecided, setShowOnlyUndecided] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [isConfirmedAll, setIsConfirmedAll] = useState(false);
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    previewRequestIdRef.current += 1;
    setStep(1);
    setTargetClassroomId("");
    setIsSeedingCurrentRoster(false);
    setPreview(null);
    setIdentityDecisions({});
    setPreviewError("");
    setRefreshNotice("");
    setSearchQuery("");
    setShowOnlyUndecided(false);
    setCurrentPage(1);
    setIsConfirmedAll(false);
  }, [isOpen, project?.id]);

  const migrationClassrooms = useMemo(() => classrooms.filter(classroom => (
    classroom.is_active
    && classroom.campusIsActive
    && (!project?.department || classroom.department === project.department)
  )), [classrooms, project?.department]);

  const establishedCandidates = useMemo(
    () => preview?.established_candidates ?? [],
    [preview],
  );
  const students = useMemo(() => preview?.students ?? [], [preview]);
  const candidatesById = useMemo(() => new Map(
    establishedCandidates.map(candidate => [candidate.roster_child_id, candidate]),
  ), [establishedCandidates]);
  const summary = useMemo(
    () => summarizeIdentityDecisions(students, identityDecisions),
    [identityDecisions, students],
  );

  const loadPreview = async (classroomId, { preserveDecisions = false } = {}) => {
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setIsLoadingPreview(true);
    setPreviewError("");
    try {
      const response = await fetchProjectClassroomMigrationPreview(project.id, Number(classroomId));
      if (previewRequestIdRef.current !== requestId) return null;
      const nextPreview = response.data;
      setPreview(nextPreview);
      setIdentityDecisions(current => (
        preserveDecisions
          ? retainValidIdentityDecisions(nextPreview.students ?? [], current)
          : createUndecidedIdentityDecisions(nextPreview.students ?? [])
      ));
      if (!nextPreview.target_classroom?.seed_allowed) {
        setIsSeedingCurrentRoster(false);
      }
      return nextPreview;
    } catch (error) {
      if (previewRequestIdRef.current === requestId) {
        setPreview(null);
        setPreviewError(getApiErrorMessage(error, "載入學生身分候選失敗"));
      }
      return null;
    } finally {
      if (previewRequestIdRef.current === requestId) setIsLoadingPreview(false);
    }
  };

  const handleTargetClassroomChange = (value) => {
    setTargetClassroomId(value);
    setStep(1);
    setPreview(null);
    setIdentityDecisions({});
    setIsSeedingCurrentRoster(false);
    setIsConfirmedAll(false);
    setRefreshNotice("");
    setCurrentPage(1);
    if (value) void loadPreview(value);
  };

  const handleSeedChange = (isChecked) => {
    setIsSeedingCurrentRoster(isChecked);
    setIsConfirmedAll(false);
  };

  const handleDecisionChange = (studentId, decision) => {
    setIdentityDecisions(current => ({ ...current, [studentId]: decision }));
    setIsConfirmedAll(false);
  };

  const handleCreateNewForAllUndecided = () => {
    setIdentityDecisions(current => Object.fromEntries(students.map(student => [
      student.student_id,
      current[student.student_id] ?? { action: "create_new" },
    ])));
    setIsConfirmedAll(false);
  };

  const handleApplyUniqueTargetMatches = () => {
    const result = applyUniqueTargetNameCandidates(
      students,
      establishedCandidates,
      identityDecisions,
    );
    if (result.appliedCount === 0) {
      toast("沒有可安全批次提出的目標班唯一同名候選");
      return;
    }
    setIdentityDecisions(result.decisions);
    setIsConfirmedAll(false);
    toast.success(`已提出 ${result.appliedCount} 筆同名候選，仍需逐筆核對`);
  };

  const normalizedSearchQuery = normalizeMigrationIdentityName(searchQuery).toLocaleLowerCase("zh-TW");
  const filteredStudents = students.filter(student => {
    if (showOnlyUndecided && identityDecisions[student.student_id]) return false;
    if (!normalizedSearchQuery) return true;
    const searchableNames = [
      student.name,
      student.original_roster_child?.name,
      ...(student.allowed_existing_roster_child_ids ?? [])
        .map(candidateId => candidatesById.get(candidateId)?.name),
    ];
    return searchableNames.some(name => (
      normalizeMigrationIdentityName(name).toLocaleLowerCase("zh-TW")
        .includes(normalizedSearchQuery)
    ));
  });
  const pageCount = Math.max(1, Math.ceil(filteredStudents.length / PAGE_SIZE));
  const effectivePage = Math.min(currentPage, pageCount);
  const pagedStudents = filteredStudents.slice(
    (effectivePage - 1) * PAGE_SIZE,
    effectivePage * PAGE_SIZE,
  );

  const selectedExistingRows = students
    .map(student => ({ student, decision: identityDecisions[student.student_id] }))
    .filter(row => row.decision?.action === "existing");
  const sameNameExistingCount = selectedExistingRows.filter(({ student, decision }) => (
    normalizeMigrationIdentityName(student.name)
      === normalizeMigrationIdentityName(candidatesById.get(decision.roster_child_id)?.name)
  )).length;
  const differentNameExistingCount = summary.existing - sameNameExistingCount;
  const isReadyForConfirmation = summary.undecided === 0
    && summary.duplicateExistingIds.length === 0;

  const handleSubmit = async () => {
    if (!isReadyForConfirmation || !isConfirmedAll) return;
    setIsSubmitting(true);
    try {
      const studentIdentityDecisions = students.map(student => {
        const decision = identityDecisions[student.student_id];
        return decision.action === "create_new"
          ? { student_id: student.student_id, action: "create_new" }
          : {
              student_id: student.student_id,
              action: "existing",
              roster_child_id: decision.roster_child_id,
            };
      });
      const response = await assignProjectToClassroom(project.id, {
        classroom_id: Number(targetClassroomId),
        source_fingerprint: preview.source_fingerprint,
        confirmed_all: true,
        seed_current_roster: isSeedingCurrentRoster,
        student_identity_decisions: studentIdentityDecisions,
      });
      toast.success("舊相本與學生身分已完成歸班遷移");
      await onMigrated(response.data);
    } catch (error) {
      if (error.response?.status === 409) {
        setIsConfirmedAll(false);
        setStep(2);
        const message = getApiErrorMessage(error, "資料已變更，請重新核對");
        setRefreshNotice(`${message} 已重新載入候選，系統沒有自動重送。`);
        await loadPreview(targetClassroomId, { preserveDecisions: true });
      } else {
        toast.error(getApiErrorMessage(error, "舊相本歸班失敗"));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) onClose();
  };

  if (!project) return null;

  return (
    <FormModal
      isOpen={isOpen}
      title={`舊相本歸班：${project?.name ?? ""}`}
      onClose={handleClose}
      maxWidthClass="max-w-5xl"
    >
      <StepIndicator step={step} />

      {step !== 1 && previewError && !preview && (
        <div role="alert" className="space-y-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
          <p>{previewError}</p>
          <Button
            size="sm"
            variant="dangerSoft"
            disabled={isLoadingPreview}
            onClick={() => void loadPreview(targetClassroomId, { preserveDecisions: true })}
          >
            {isLoadingPreview ? "重新載入中…" : "重新載入學生身分候選"}
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm leading-6 text-indigo-700">
            歸班會把這一期相本接上園所的班級與穩定孩子身分；相本學生姓名、內容與目前負責人都不會改寫。
          </p>
          <FormField label="歸入班級">
            <select
              autoFocus
              required
              value={targetClassroomId}
              onChange={event => handleTargetClassroomChange(event.target.value)}
              className={fieldControlClass}
            >
              <option value="">請選擇使用中班級</option>
              {migrationClassrooms.map(classroom => (
                <option key={classroom.id} value={classroom.id}>
                  {classroom.campusName}／{classroom.name}（{DEPARTMENT_LABELS[classroom.department]}）
                </option>
              ))}
            </select>
          </FormField>

          {isLoadingPreview && (
            <div role="status" className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              正在整理學生身分與目標班證據…
            </div>
          )}
          {previewError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
              {previewError}
            </div>
          )}

          {preview && (
            <div className="space-y-3">
              <div className="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm sm:grid-cols-3">
                <div>
                  <span className="block text-xs text-gray-400">目標班級</span>
                  <span className="font-medium text-gray-800">
                    {preview.target_classroom.campus_name}／{preview.target_classroom.name}
                  </span>
                </div>
                <div>
                  <span className="block text-xs text-gray-400">舊相本學生</span>
                  <span className="font-medium text-gray-800">{students.length} 位</span>
                </div>
                <div>
                  <span className="block text-xs text-gray-400">目標班目前名單</span>
                  <span className="font-medium text-gray-800">
                    {preview.target_classroom.active_roster_count} 位
                  </span>
                </div>
              </div>

              <label className={`flex items-start gap-3 rounded-lg border px-3 py-3 text-sm ${
                preview.target_classroom.seed_allowed
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-gray-200 bg-gray-50 text-gray-400"
              }`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isSeedingCurrentRoster}
                  disabled={!preview.target_classroom.seed_allowed}
                  onChange={event => handleSeedChange(event.target.checked)}
                  aria-label="以相本全部學生建立目前名單"
                />
                <span>
                  <span className="block font-medium">以相本全部學生建立目前名單</span>
                  <span className="mt-0.5 block text-xs leading-5">
                    只有當這一本相本的學生正好等於這個班現在的完整名單時才勾選；不確定就不要勾。
                    {!preview.target_classroom.seed_allowed && " 目標班已有目前名單，因此不能使用。"}
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button onClick={handleClose}>取消</Button>
            <Button
              variant="primary"
              disabled={!preview || isLoadingPreview}
              onClick={() => setStep(2)}
            >
              下一步：核對學生身分
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div className="space-y-4">
          {refreshNotice && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
              {refreshNotice}
            </div>
          )}
          <div className="sticky top-0 z-10 rounded-xl border border-gray-200 bg-white/95 p-3 shadow-sm backdrop-blur">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge tone={summary.undecided > 0 ? "warning" : "success"}>
                  未決定 {summary.undecided}
                </Badge>
                <Badge tone="review">新身分 {summary.createNew}</Badge>
                <Badge tone="info">既有身分 {summary.existing}</Badge>
                {summary.duplicateExistingIds.length > 0 && (
                  <Badge tone="danger">重複身分 {summary.duplicateExistingIds.length}</Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="xs" onClick={handleCreateNewForAllUndecided}>
                  <UserRoundPlus className="h-3.5 w-3.5" />
                  全部未決定設為建立新身分
                </Button>
                <Button size="xs" variant="infoSoft" onClick={handleApplyUniqueTargetMatches}>
                  <Sparkles className="h-3.5 w-3.5" />
                  套用目標班唯一同名候選
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-500">
              批次按鈕只提出決定，不代表已核對，也不會覆寫你已手動選擇的學生。
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                value={searchQuery}
                onChange={event => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className={`${fieldControlClass} pl-9`}
                placeholder="搜尋相本姓名或候選姓名"
                aria-label="搜尋學生身分"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={showOnlyUndecided}
                onChange={event => {
                  setShowOnlyUndecided(event.target.checked);
                  setCurrentPage(1);
                }}
              />
              只看未決定
            </label>
          </div>

          <div className="max-h-[52vh] space-y-3 overflow-y-auto rounded-xl bg-gray-50 p-2 sm:p-3">
            {pagedStudents.map(student => (
              <StudentIdentityRow
                key={student.student_id}
                student={student}
                decision={identityDecisions[student.student_id]}
                candidatesById={candidatesById}
                establishedCandidates={establishedCandidates}
                duplicateExistingIds={summary.duplicateExistingIds}
                onDecisionChange={decision => handleDecisionChange(student.student_id, decision)}
              />
            ))}
            {pagedStudents.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-gray-400">
                沒有符合目前篩選的學生。
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Button
                size="xs"
                disabled={effectivePage <= 1}
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
              >
                上一頁
              </Button>
              第 {effectivePage}／{pageCount} 頁，共 {filteredStudents.length} 位
              <Button
                size="xs"
                disabled={effectivePage >= pageCount}
                onClick={() => setCurrentPage(page => Math.min(pageCount, page + 1))}
              >
                下一頁
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4" />
                上一步
              </Button>
              <Button
                variant="primary"
                disabled={!isReadyForConfirmation}
                onClick={() => {
                  setIsConfirmedAll(false);
                  setStep(3);
                }}
              >
                下一步：確認遷移
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
              <div className="text-xs text-gray-400">歸入班級</div>
              <div className="mt-1 text-sm font-medium text-gray-800">
                {preview.target_classroom.campus_name}／{preview.target_classroom.name}
              </div>
            </div>
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-3">
              <div className="text-xs text-violet-500">建立全新身分</div>
              <div className="mt-1 text-lg font-bold text-violet-800">{summary.createNew} 位</div>
            </div>
            <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-3">
              <div className="text-xs text-sky-500">連結既有身分</div>
              <div className="mt-1 text-lg font-bold text-sky-800">{summary.existing} 位</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <div className="text-xs text-amber-600">建立目前名單</div>
              <div className="mt-1 text-lg font-bold text-amber-800">
                {isSeedingCurrentRoster ? `${students.length} 位` : "不建立"}
              </div>
            </div>
          </div>

          {(sameNameExistingCount > 0 || differentNameExistingCount > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-800">
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-1 h-4 w-4 flex-shrink-0" />
                既有身分仍需人工判斷
              </div>
              <p className="mt-1 text-xs">
                {sameNameExistingCount > 0 && `${sameNameExistingCount} 筆姓名相同；同名本身不能證明是同一人。`}
                {differentNameExistingCount > 0 && ` ${differentNameExistingCount} 筆目前姓名不同，請確認是否為改名或同一位孩子。`}
              </p>
            </div>
          )}

          {summary.createNew > 0 && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-3 text-sm leading-6 text-violet-800">
              將建立 {summary.createNew} 個獨立身分；這些學生不會與其他舊期相本自動合併匯出。
            </div>
          )}

          <div className="max-h-[36vh] overflow-y-auto rounded-xl border border-gray-200">
            <div className="divide-y divide-gray-100">
              {students.map(student => {
                const decision = identityDecisions[student.student_id];
                const candidate = decision.action === "existing"
                  ? candidatesById.get(decision.roster_child_id)
                  : null;
                return (
                  <div key={student.student_id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-medium text-gray-800">{student.name}</span>
                    <span className="text-right text-xs leading-5 text-gray-500">
                      {decision.action === "create_new"
                        ? "建立全新身分"
                        : `${candidate?.name ?? "既有身分"}（#${decision.roster_child_id}）`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-3 text-sm text-indigo-900">
            <input
              type="checkbox"
              className="mt-1"
              checked={isConfirmedAll}
              onChange={event => setIsConfirmedAll(event.target.checked)}
            />
            <span>
              <span className="block font-medium">我已逐筆核對全部學生；同名不代表同一人</span>
              <span className="mt-0.5 block text-xs leading-5 text-indigo-700">
                送出後會固定這一期相本的名冊身分；正常相本流程不提供重新配對入口。
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button
              disabled={isSubmitting}
              onClick={() => {
                setIsConfirmedAll(false);
                setStep(2);
              }}
            >
              <ArrowLeft className="h-4 w-4" />
              返回修訂
            </Button>
            <Button
              variant="primary"
              disabled={isSubmitting || !isConfirmedAll}
              onClick={() => void handleSubmit()}
            >
              {isSubmitting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {isSubmitting ? "遷移中…" : `確認遷移 ${students.length} 位學生`}
            </Button>
          </div>
        </div>
      )}
    </FormModal>
  );
}
