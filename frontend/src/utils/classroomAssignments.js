// 班級工作入口只依目前老師編制判斷，不從帳號的基礎角色推測。

export function findCurrentTeacherAssignment(classroom, userId) {
  return classroom.current_teachers.find(teacher => teacher.teacher_id === userId);
}

export function getTeacherAssignedClassrooms(classrooms, userId) {
  return classrooms.filter(classroom => findCurrentTeacherAssignment(classroom, userId));
}

export function getProjectsOutsideClassrooms(projects, classrooms) {
  const classroomIds = new Set(classrooms.map(classroom => classroom.id));
  return projects.filter(project => !classroomIds.has(project.classroom_id));
}

export function buildClassroomOwnerOptions(currentTeachers, teacherOptions) {
  const roleByTeacherId = new Map(teacherOptions.map(teacher => [teacher.id, teacher.role]));
  return currentTeachers.map(teacher => ({
    id: teacher.teacher_id,
    display_name: teacher.teacher_name,
    role: roleByTeacherId.get(teacher.teacher_id),
  }));
}
