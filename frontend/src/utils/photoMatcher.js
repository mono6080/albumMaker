// 批次照片分配的純函式配對演算法
// 統一回傳 { assignments: [{studentId, file}], unmatched: studentId[], unused: File[] }

import { getVisibleLayoutElements } from "./layoutLayerState.js";

const stem = (file) => file.name.replace(/\.[^.]+$/, "");
const normalizeSlotSuffix = (value) => value.trim().replace(/^[\s_-]+/, "");

function normalizePositiveInteger(value) {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? String(number) : null;
}

function normalizePageSlotKey(value) {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) return null;
  const page = normalizePositiveInteger(match[1]);
  const slot = normalizePositiveInteger(match[2]);
  return page && slot ? `${page}-${slot}` : null;
}

function buildSlotLookups(pages) {
  const byPageSlot = new Map();
  const bySequence = new Map();
  let sequence = 1;

  pages.forEach((page, pageIndex) => {
    const slots = getVisibleLayoutElements(page?.layout, "photo");
    slots.forEach((slot, slotIndex) => {
      const target = { pageIndex, slotId: slot.id, slotIndex };
      byPageSlot.set(`${pageIndex + 1}-${slotIndex + 1}`, target);
      bySequence.set(String(sequence), target);
      sequence += 1;
    });
  });

  return { byPageSlot, bySequence };
}

function findNamedSuffix(fileStem, students) {
  const sortedStudents = [...students].sort(
    (a, b) => (b.name?.length || 0) - (a.name?.length || 0),
  );
  for (const student of sortedStudents) {
    if (!student?.name) continue;
    if (fileStem.startsWith(student.name)) {
      return {
        student,
        suffix: normalizeSlotSuffix(fileStem.slice(student.name.length)),
      };
    }
  }
  return null;
}

function matchByNamedSlot(students, files, pages, mode) {
  const { byPageSlot, bySequence } = buildSlotLookups(pages);
  const assignments = [];
  const invalid = [];
  const usedTargets = new Set();
  const usedFiles = new Set();

  files.forEach((file) => {
    const fileStem = stem(file);
    const parsedName = findNamedSuffix(fileStem, students);
    if (!parsedName) {
      invalid.push({ file, reason: "找不到學生姓名" });
      return;
    }

    const suffix = parsedName.suffix;
    const isValidSuffix = mode === "page-slot"
      ? /^\d+-\d+$/.test(suffix)
      : /^\d+$/.test(suffix);
    if (!isValidSuffix) {
      invalid.push({ file, reason: "檔名尾碼格式不符合" });
      return;
    }

    const lookupKey = mode === "page-slot"
      ? normalizePageSlotKey(suffix)
      : normalizePositiveInteger(suffix);
    const target = mode === "page-slot"
      ? byPageSlot.get(lookupKey)
      : bySequence.get(lookupKey);
    if (!target) {
      invalid.push({ file, reason: "找不到對應照片格" });
      return;
    }

    const targetKey = `${parsedName.student.id}:${target.pageIndex}:${target.slotId}`;
    if (usedTargets.has(targetKey)) {
      invalid.push({ file, reason: "同一學生同一格重複配對" });
      return;
    }

    assignments.push({
      studentId: parsedName.student.id,
      pageIndex: target.pageIndex,
      slotId: target.slotId,
      slotIndex: target.slotIndex,
      file,
    });
    usedTargets.add(targetKey);
    usedFiles.add(file);
  });

  const matchedIds = new Set(assignments.map((a) => a.studentId));
  return {
    assignments,
    unmatched: students.filter((s) => !matchedIds.has(s.id)).map((s) => s.id),
    unused: files.filter((file) => !usedFiles.has(file)),
    invalid,
  };
}

/**
 * 依檔名是否包含學生姓名子字串配對。
 * 學生姓名按長度降冪排序，避免「王小明」被「小明」搶走。
 * 同學生姓名只配第一個未被使用的檔案。
 */
export function matchByName(students, files) {
  const usedFiles = new Set();
  const assignments = [];

  const sortedStudents = [...students].sort(
    (a, b) => (b.name?.length || 0) - (a.name?.length || 0),
  );

  for (const student of sortedStudents) {
    if (!student?.name) continue;
    const match = files.find(
      (file) => !usedFiles.has(file) && stem(file).includes(student.name),
    );
    if (match) {
      assignments.push({ studentId: student.id, file: match });
      usedFiles.add(match);
    }
  }

  const matchedIds = new Set(assignments.map((a) => a.studentId));
  return {
    assignments,
    unmatched: students.filter((s) => !matchedIds.has(s.id)).map((s) => s.id),
    unused: files.filter((file) => !usedFiles.has(file)),
    invalid: [],
  };
}

/**
 * 依檔名字典序對學生 order_index 順序 1 對 1 配對。
 * 適合「IMG_001、IMG_002」這類流水號命名。
 */
export function matchBySequence(students, files) {
  const sortedFiles = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const sortedStudents = [...students].sort(
    (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0),
  );

  const pairs = Math.min(sortedStudents.length, sortedFiles.length);
  const assignments = [];
  for (let i = 0; i < pairs; i += 1) {
    assignments.push({ studentId: sortedStudents[i].id, file: sortedFiles[i] });
  }

  const matchedIds = new Set(assignments.map((a) => a.studentId));
  const usedFiles = new Set(assignments.map((a) => a.file));
  return {
    assignments,
    unmatched: sortedStudents.filter((s) => !matchedIds.has(s.id)).map((s) => s.id),
    unused: sortedFiles.filter((f) => !usedFiles.has(f)),
    invalid: [],
  };
}

/**
 * 依「姓名 + 頁-格」解析檔名。
 * 例：王小明1-2.jpg → 王小明，第 1 頁第 2 個照片格。
 */
export function matchByNamePageSlot(students, files, pages) {
  return matchByNamedSlot(students, files, pages, "page-slot");
}

/**
 * 依「姓名 + 全書照片格流水號」解析檔名。
 * 例：王小明3.jpg → 王小明，整本相本第 3 個照片格。
 */
export function matchByNameSlotSequence(students, files, pages) {
  return matchByNamedSlot(students, files, pages, "sequence");
}

/**
 * 個人多選上傳用：只看檔名尾端數字。
 * 支援尾端「頁-格」或「流水格」，例如 1-2.jpg、生活照3.jpg。
 * 無法解析的檔案放進 unused 供順序補位。
 */
export function matchPersonalFilesToSlots(files, pages) {
  const { byPageSlot, bySequence } = buildSlotLookups(pages);
  const assignments = [];
  const invalid = [];
  const usedTargets = new Set();
  const usedFiles = new Set();

  files.forEach((file) => {
    const fileStem = stem(file);
    const suffix = fileStem.match(/(\d+-\d+|\d+)$/)?.[1] ?? "";

    const pageSlotKey = normalizePageSlotKey(suffix);
    const sequenceKey = pageSlotKey ? null : normalizePositiveInteger(suffix);
    const target = pageSlotKey
      ? byPageSlot.get(pageSlotKey)
      : sequenceKey
        ? bySequence.get(sequenceKey)
        : null;

    if (!pageSlotKey && !sequenceKey) return;

    if (!target) {
      invalid.push({ file, reason: "找不到對應照片格" });
      return;
    }

    const targetKey = `${target.pageIndex}:${target.slotId}`;
    if (usedTargets.has(targetKey)) {
      invalid.push({ file, reason: "同一格重複配對" });
      return;
    }

    assignments.push({
      pageIndex: target.pageIndex,
      slotId: target.slotId,
      slotIndex: target.slotIndex,
      file,
    });
    usedTargets.add(targetKey);
    usedFiles.add(file);
  });

  const invalidFiles = new Set(invalid.map((item) => item.file));
  return {
    assignments,
    unmatched: [],
    unused: files.filter((file) => !usedFiles.has(file) && !invalidFiles.has(file)),
    invalid,
  };
}

/** 空配對：手動模式起始狀態 */
export function emptyMatch(students, files) {
  return {
    assignments: [],
    unmatched: students.map((s) => s.id),
    unused: [...files],
    invalid: [],
  };
}

/**
 * 在現有 result 中為 studentId 指派 file。
 * 若 file 已被別人使用，會先把舊配對移除。
 * 若 studentId 已有配對，會先釋放舊檔案到 unused。
 */
export function assignFile(result, studentId, file) {
  const next = {
    assignments: result.assignments.filter(
      (a) => a.studentId !== studentId && a.file !== file,
    ),
    unmatched: [...result.unmatched],
    unused: [...result.unused],
  };

  // 釋放此學生原本的檔案 → 加回 unused
  const prevForStudent = result.assignments.find((a) => a.studentId === studentId);
  if (prevForStudent && prevForStudent.file !== file && !next.unused.includes(prevForStudent.file)) {
    next.unused.push(prevForStudent.file);
  }

  // 釋放此檔案原本的學生 → 加回 unmatched
  const prevForFile = result.assignments.find((a) => a.file === file);
  if (prevForFile && prevForFile.studentId !== studentId && !next.unmatched.includes(prevForFile.studentId)) {
    next.unmatched.push(prevForFile.studentId);
  }

  next.assignments.push({ studentId, file });
  next.unmatched = next.unmatched.filter((id) => id !== studentId);
  next.unused = next.unused.filter((f) => f !== file);
  return next;
}

/** 交換兩位學生的照片配對；任一方為空也支援（等於把照片搬過去） */
export function swapAssignments(result, studentIdA, studentIdB) {
  if (studentIdA === studentIdB) return result;
  const fileA = result.assignments.find((a) => a.studentId === studentIdA)?.file ?? null;
  const fileB = result.assignments.find((a) => a.studentId === studentIdB)?.file ?? null;
  let next = result;
  if (fileA) next = clearAssignment(next, studentIdA);
  if (fileB) next = clearAssignment(next, studentIdB);
  if (fileB) next = assignFile(next, studentIdA, fileB);
  if (fileA) next = assignFile(next, studentIdB, fileA);
  return next;
}

/** 移除 studentId 的配對 */
export function clearAssignment(result, studentId) {
  const removed = result.assignments.find((a) => a.studentId === studentId);
  if (!removed) return result;
  return {
    assignments: result.assignments.filter((a) => a.studentId !== studentId),
    unmatched: result.unmatched.includes(studentId)
      ? result.unmatched
      : [...result.unmatched, studentId],
    unused: result.unused.includes(removed.file)
      ? result.unused
      : [...result.unused, removed.file],
  };
}
