const TARGET_EVIDENCE_KINDS = new Set(["target_membership", "target_project"]);

const DEPARTMENT_LABELS = {
  infant: "嬰幼部",
  academy: "學院部",
};

function evidenceLocationLabel(evidence) {
  return [
    evidence.campus_name,
    DEPARTMENT_LABELS[evidence.department] ?? evidence.department,
    evidence.classroom_name,
  ].filter(Boolean).join("／") || "未標示班級";
}

export function formatCandidateEvidenceLabel(evidence) {
  const locationLabel = evidenceLocationLabel(evidence);
  if (evidence.kind === "target_membership") {
    const statusLabel = evidence.status === "ended" ? "已結束" : "目前在班";
    return `目標班名單｜${locationLabel}｜${statusLabel}`;
  }
  if (evidence.kind === "same_name_membership") {
    const statusLabel = evidence.status === "ended" ? "已結束" : "目前在班";
    return `歷史名單｜${locationLabel}｜${statusLabel}`;
  }
  if (evidence.kind === "target_project" || evidence.kind === "same_name_project") {
    const sourceLabel = evidence.kind === "target_project" ? "目標班相本" : "歷史相本";
    const projectLabel = evidence.project_name
      ? `「${evidence.project_name}」`
      : "未命名相本";
    const projectIdLabel = evidence.project_id ? ` #${evidence.project_id}` : "";
    const periodLabel = evidence.period_name ? `｜期別：${evidence.period_name}` : "";
    const archivedLabel = evidence.status === "archived" ? "｜已封存" : "";
    return `${sourceLabel}｜${locationLabel}｜${projectLabel}${projectIdLabel}${periodLabel}${archivedLabel}`;
  }
  if (evidence.kind === "same_name_established") {
    return "與本相本學生同名（仍須人工確認）";
  }
  return "既有穩定身分";
}

export function candidateEvidenceSummary(candidate) {
  const labels = [
    ...new Set((candidate?.evidence ?? []).map(formatCandidateEvidenceLabel)),
  ];
  return labels.length > 0 ? labels.join("；") : "既有穩定身分";
}

export function normalizeMigrationIdentityName(value) {
  return (value ?? "").replace(/[\s\u3000]+/g, "");
}

export function createUndecidedIdentityDecisions(students) {
  return Object.fromEntries(students.map(student => [student.student_id, null]));
}

export function findUniqueTargetNameCandidateId(student, establishedCandidates) {
  const allowedIds = new Set(student.allowed_existing_roster_child_ids ?? []);
  const normalizedStudentName = normalizeMigrationIdentityName(student.name);
  const candidateIds = establishedCandidates
    .filter(candidate => (
      allowedIds.has(candidate.roster_child_id)
      && normalizeMigrationIdentityName(candidate.name) === normalizedStudentName
      && candidate.evidence?.some(evidence => TARGET_EVIDENCE_KINDS.has(evidence.kind))
    ))
    .map(candidate => candidate.roster_child_id);
  const uniqueCandidateIds = [...new Set(candidateIds)];
  return uniqueCandidateIds.length === 1 ? uniqueCandidateIds[0] : null;
}

export function applyUniqueTargetNameCandidates(
  students,
  establishedCandidates,
  currentDecisions,
) {
  const proposedCandidateByStudentId = new Map();
  const proposalCountByCandidateId = new Map();
  const alreadyUsedCandidateIds = new Set(
    Object.values(currentDecisions)
      .filter(decision => decision?.action === "existing")
      .map(decision => decision.roster_child_id),
  );

  for (const student of students) {
    if (currentDecisions[student.student_id]) continue;
    const candidateId = findUniqueTargetNameCandidateId(student, establishedCandidates);
    if (candidateId === null) continue;
    proposedCandidateByStudentId.set(student.student_id, candidateId);
    proposalCountByCandidateId.set(
      candidateId,
      (proposalCountByCandidateId.get(candidateId) ?? 0) + 1,
    );
  }

  let appliedCount = 0;
  const decisions = { ...currentDecisions };
  for (const [studentId, candidateId] of proposedCandidateByStudentId) {
    if (proposalCountByCandidateId.get(candidateId) !== 1) continue;
    if (alreadyUsedCandidateIds.has(candidateId)) continue;
    decisions[studentId] = { action: "existing", roster_child_id: candidateId };
    alreadyUsedCandidateIds.add(candidateId);
    appliedCount += 1;
  }
  return { decisions, appliedCount };
}

export function retainValidIdentityDecisions(students, currentDecisions) {
  return Object.fromEntries(students.map(student => {
    const decision = currentDecisions[student.student_id];
    if (decision?.action === "create_new") return [student.student_id, decision];
    if (
      decision?.action === "existing"
      && student.allowed_existing_roster_child_ids?.includes(decision.roster_child_id)
    ) {
      return [student.student_id, decision];
    }
    return [student.student_id, null];
  }));
}

export function summarizeIdentityDecisions(students, decisions) {
  const summary = {
    total: students.length,
    undecided: 0,
    createNew: 0,
    existing: 0,
    duplicateExistingIds: [],
  };
  const studentIdsByRosterChildId = new Map();

  for (const student of students) {
    const decision = decisions[student.student_id];
    if (!decision) {
      summary.undecided += 1;
    } else if (decision.action === "create_new") {
      summary.createNew += 1;
    } else {
      summary.existing += 1;
      const studentIds = studentIdsByRosterChildId.get(decision.roster_child_id) ?? [];
      studentIds.push(student.student_id);
      studentIdsByRosterChildId.set(decision.roster_child_id, studentIds);
    }
  }

  summary.duplicateExistingIds = [...studentIdsByRosterChildId.entries()]
    .filter(([, studentIds]) => studentIds.length > 1)
    .map(([rosterChildId]) => rosterChildId);
  return summary;
}
