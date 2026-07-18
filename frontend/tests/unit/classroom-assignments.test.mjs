import assert from "node:assert/strict";

import {
  buildClassroomOwnerOptions,
  findCurrentTeacherAssignment,
  getProjectsOutsideClassrooms,
  getTeacherAssignedClassrooms,
} from "../../src/utils/classroomAssignments.js";
import { test } from "./harness.mjs";


const classrooms = [
  {
    id: 10,
    current_teachers: [
      { teacher_id: 8, duty: "lead" },
      { teacher_id: 9, duty: "co_teacher" },
    ],
  },
  {
    id: 11,
    current_teachers: [{ teacher_id: 12, duty: "lead" }],
  },
];


test("teacher class workflow follows current assignment instead of base account role", () => {
  assert.deepEqual(findCurrentTeacherAssignment(classrooms[0], 8), {
    teacher_id: 8,
    duty: "lead",
  });
  assert.deepEqual(getTeacherAssignedClassrooms(classrooms, 8), [classrooms[0]]);
  assert.deepEqual(getTeacherAssignedClassrooms(classrooms, 99), []);
});


test("supervisor-only projects stay outside assigned teacher classroom cards", () => {
  const projects = [
    { id: 101, classroom_id: 10 },
    { id: 102, classroom_id: 11 },
    { id: 103, classroom_id: 12 },
  ];
  assert.deepEqual(getProjectsOutsideClassrooms(projects, [classrooms[0]]), [
    projects[1],
    projects[2],
  ]);
});


test("owner transfer options preserve each assigned teacher's actual base role", () => {
  const currentTeachers = [
    { teacher_id: 8, teacher_name: "林主任", duty: "lead" },
    { teacher_id: 9, teacher_name: "王老師", duty: "co_teacher" },
  ];
  const teacherOptions = [
    { id: 8, role: "supervisor" },
    { id: 9, role: "teacher" },
  ];

  assert.deepEqual(buildClassroomOwnerOptions(currentTeachers, teacherOptions), [
    { id: 8, display_name: "林主任", role: "supervisor" },
    { id: 9, display_name: "王老師", role: "teacher" },
  ]);
});
