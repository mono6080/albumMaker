// 批次照片分配的純函式配對演算法
// 統一回傳 { assignments: [{studentId, file}], unmatched: studentId[], unused: File[] }

const stem = (file) => file.name.replace(/\.[^.]+$/, "");

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
  };
}

/** 空配對：手動模式起始狀態 */
export function emptyMatch(students, files) {
  return {
    assignments: [],
    unmatched: students.map((s) => s.id),
    unused: [...files],
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
