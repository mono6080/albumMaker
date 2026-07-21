// 班級總覽的派生狀態:進度統計、工作階段、學生篩選。
// 全部由 project/template 純推導,集中一處,render body 不再散落計算式。

import { useMemo } from "react";

import {
  isProjectDeliverableUnlocked,
  isStudentContentComplete,
  isStudentDeliverableUnlocked,
} from "../utils/reviewCompletion";
import { computeStudentPhotoProgress } from "../utils/photoProgress";
import { computeStudentTextProgress } from "../utils/textProgress";

export default function useProjectReviewDerivedState({
  project,
  template,
  studentStatusFilter,
  studentSearch,
}) {
  return useMemo(() => {
    if (!project || !template) return null;

    const photoProgressByStudentId = new Map(
      project.students.map(student => [
        student.id,
        computeStudentPhotoProgress(student.pages_data, template.pages),
      ]),
    );
    const textProgressByStudentId = new Map(
      project.students.map(student => [
        student.id,
        computeStudentTextProgress(
          student.pages_data,
          template.pages,
          project.label_texts,
        ),
      ]),
    );
    const sumFilled = progressMap =>
      [...progressMap.values()].reduce((sum, progress) => sum + progress.filled, 0);
    const sumTotal = progressMap =>
      [...progressMap.values()].reduce((sum, progress) => sum + progress.total, 0);

    const isContentCompleteByStudentId = new Map(
      project.students.map(student => [
        student.id,
        isStudentContentComplete(
          photoProgressByStudentId.get(student.id),
          textProgressByStudentId.get(student.id),
        ),
      ]),
    );
    const contentIncompleteStudents = project.students.filter(
      student => !isContentCompleteByStudentId.get(student.id),
    );

    const isProjectCompleted = isProjectDeliverableUnlocked(project);
    // 工作階段:1 製作(內容未填齊)→ 2 標記完成(內容齊、待老師標記)→ 3 交件(已標記全班完成)
    const workStage = isProjectCompleted
      ? 3
      : contentIncompleteStudents.length === 0
        ? 2
        : 1;

    // 標記完成 n/N:用「有效完成」predicate 計數(該生標記或全班標記任一成立),
    // 與學生卡 badge 同語意——直接標記全班完成時不會逐生寫 completed_at,
    // 若只數學生自身標記會出現「✓ 全班完成」卻顯示 0/N 的矛盾。
    const completedStudentCount = project.students.filter(
      student => isStudentDeliverableUnlocked(project, student),
    ).length;
    const hasRenderedStudents =
      project.students.some(student => student.output_filename);

    const trimmedStudentSearch = studentSearch.trim().toLowerCase();
    const visibleStudents = project.students.filter(student => {
      const isContentComplete = isContentCompleteByStudentId.get(student.id);
      const matchesStatus =
        studentStatusFilter === "all" ||
        (studentStatusFilter === "incomplete" && !isContentComplete) ||
        (studentStatusFilter === "complete" && isContentComplete);
      const matchesSearch =
        !trimmedStudentSearch ||
        (student.name ?? "").toLowerCase().includes(trimmedStudentSearch);
      return matchesStatus && matchesSearch;
    });
    const emptyFilteredStudentMessage = trimmedStudentSearch
      ? `沒有符合「${studentSearch.trim()}」的學生`
      : "目前篩選沒有學生";

    return {
      photoProgressByStudentId,
      textProgressByStudentId,
      classPhotoFilled: sumFilled(photoProgressByStudentId),
      classPhotoTotal: sumTotal(photoProgressByStudentId),
      classTextFilled: sumFilled(textProgressByStudentId),
      classTextTotal: sumTotal(textProgressByStudentId),
      contentIncompleteStudentCount: contentIncompleteStudents.length,
      completedStudentCount,
      isProjectCompleted,
      workStage,
      hasRenderedStudents,
      visibleStudents,
      emptyFilteredStudentMessage,
    };
  }, [project, template, studentStatusFilter, studentSearch]);
}
