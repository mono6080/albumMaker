import assert from "node:assert/strict";

import {
  applyUniqueTargetNameCandidates,
  candidateEvidenceSummary,
  createUndecidedIdentityDecisions,
  formatCandidateEvidenceLabel,
  retainValidIdentityDecisions,
  summarizeIdentityDecisions,
} from "../../src/utils/legacyProjectMigration.js";
import { test } from "./harness.mjs";


const candidates = [
  {
    roster_child_id: 101,
    name: "王小明",
    evidence: [{
      kind: "target_membership",
      campus_name: "總校",
      department: "infant",
      classroom_id: 7,
      classroom_name: "彩虹班",
      status: "active",
    }],
  },
  {
    roster_child_id: 102,
    name: "李小華",
    evidence: [{
      kind: "target_project",
      campus_name: "總校",
      department: "infant",
      classroom_id: 7,
      classroom_name: "彩虹班",
      project_id: 20,
      project_name: "春季成長相本",
      period_name: "2025 下學期",
      status: "active",
    }],
  },
  {
    roster_child_id: 103,
    name: "陳小星",
    evidence: [{
      kind: "same_name_membership",
      campus_name: "東區分校",
      department: "academy",
      classroom_name: "星星班",
      status: "ended",
    }],
  },
];


test("candidate provenance labels distinguish class history and project period", () => {
  assert.equal(
    formatCandidateEvidenceLabel(candidates[0].evidence[0]),
    "目標班名單｜總校／嬰幼部／彩虹班｜目前在班",
  );
  assert.equal(
    formatCandidateEvidenceLabel(candidates[2].evidence[0]),
    "歷史名單｜東區分校／學院部／星星班｜已結束",
  );
  assert.equal(
    candidateEvidenceSummary(candidates[1]),
    "目標班相本｜總校／嬰幼部／彩虹班｜「春季成長相本」 #20｜期別：2025 下學期",
  );
  assert.equal(
    candidateEvidenceSummary({
      evidence: [{
        kind: "same_name_project",
        campus_name: "西區分校",
        department: "infant",
        classroom_name: "太陽班",
        project_id: 88,
        project_name: "畢業相本",
        period_name: "2024 下學期",
        status: "archived",
      }],
    }),
    "歷史相本｜西區分校／嬰幼部／太陽班｜「畢業相本」 #88｜期別：2024 下學期｜已封存",
  );
});


test("legacy migration decisions start unresolved and summarize duplicate identities", () => {
  const students = [
    { student_id: 1, name: "王小明", allowed_existing_roster_child_ids: [101] },
    { student_id: 2, name: "李小華", allowed_existing_roster_child_ids: [101, 102] },
    { student_id: 3, name: "陳小星", allowed_existing_roster_child_ids: [103] },
  ];
  const initial = createUndecidedIdentityDecisions(students);
  assert.deepEqual(initial, { 1: null, 2: null, 3: null });
  assert.deepEqual(summarizeIdentityDecisions(students, initial), {
    total: 3,
    undecided: 3,
    createNew: 0,
    existing: 0,
    duplicateExistingIds: [],
  });

  const duplicate = {
    1: { action: "existing", roster_child_id: 101 },
    2: { action: "existing", roster_child_id: 101 },
    3: { action: "create_new" },
  };
  assert.deepEqual(summarizeIdentityDecisions(students, duplicate), {
    total: 3,
    undecided: 0,
    createNew: 1,
    existing: 2,
    duplicateExistingIds: [101],
  });
});


test("unique target-name bulk proposal skips global-only and identity collisions", () => {
  const students = [
    { student_id: 1, name: "王 小明", allowed_existing_roster_child_ids: [101] },
    { student_id: 2, name: "李小華", allowed_existing_roster_child_ids: [102] },
    { student_id: 3, name: "陳小星", allowed_existing_roster_child_ids: [103] },
  ];
  const result = applyUniqueTargetNameCandidates(
    students,
    candidates,
    createUndecidedIdentityDecisions(students),
  );
  assert.equal(result.appliedCount, 2);
  assert.deepEqual(result.decisions, {
    1: { action: "existing", roster_child_id: 101 },
    2: { action: "existing", roster_child_id: 102 },
    3: null,
  });

  const duplicateStudents = [
    { student_id: 4, name: "王小明", allowed_existing_roster_child_ids: [101] },
    { student_id: 5, name: "王小明", allowed_existing_roster_child_ids: [101] },
  ];
  const duplicateResult = applyUniqueTargetNameCandidates(
    duplicateStudents,
    candidates,
    createUndecidedIdentityDecisions(duplicateStudents),
  );
  assert.equal(duplicateResult.appliedCount, 0);
  assert.deepEqual(duplicateResult.decisions, { 4: null, 5: null });
});


test("stale preview retains only decisions allowed by the refreshed rows", () => {
  const refreshedStudents = [
    { student_id: 1, name: "王小明", allowed_existing_roster_child_ids: [] },
    { student_id: 2, name: "李小華", allowed_existing_roster_child_ids: [102] },
    { student_id: 4, name: "新出現", allowed_existing_roster_child_ids: [] },
  ];
  const retained = retainValidIdentityDecisions(refreshedStudents, {
    1: { action: "existing", roster_child_id: 101 },
    2: { action: "existing", roster_child_id: 102 },
    3: { action: "create_new" },
  });
  assert.deepEqual(retained, {
    1: null,
    2: { action: "existing", roster_child_id: 102 },
    4: null,
  });
});
