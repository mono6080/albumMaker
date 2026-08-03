"""班級老師編制與新學期整園重新編班契約。"""

from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from database import (
    Semester,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacher,
    ClassroomMember,
    Project,
    Student,
    SessionLocal,
    ProjectStudent,
    TermReclassificationPlan,
)
from tests.helpers import (
    assert_status,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _create_active_template(client, department: str = "infant") -> int:
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("semester_period"),
            "department": department,
            "status": "active",
        },
    )
    assert_status(period_response, 200)
    template_id, _ = create_template_with_page(
        client,
        period_id=period_response.json()["id"],
    )
    return template_id


def _create_campus(client) -> int:
    response = client.post(
        "/api/organization/campuses",
        json={"name": unique_name("term_campus")},
    )
    assert_status(response, 201)
    return response.json()["id"]


def _create_classroom(client, campus_id: int, name: str) -> int:
    response = client.post(
        "/api/organization/classrooms",
        json={
            "campus_id": campus_id,
            "department": "infant",
            "name": name,
        },
    )
    assert_status(response, 201)
    return response.json()["id"]


def _create_teacher(client, _supervisor_id: int) -> tuple[dict, str]:
    return create_user(client, "teacher")


def _replace_teachers(client, classroom_id: int, teachers: list[dict]) -> dict:
    response = client.put(
        f"/api/organization/classrooms/{classroom_id}/teachers",
        json={"teachers": teachers},
    )
    assert_status(response, 200)
    return response.json()


def _add_members(client, classroom_id: int, names: list[str]) -> list[dict]:
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/members/batch",
        json={"members": [{"name": name} for name in names]},
    )
    assert_status(response, 201)
    return response.json()["created"]


def _create_classroom_project(
    client,
    classroom_id: int,
    template_id: int,
    owner_id: int | None = None,
) -> dict:
    overview_response = client.get("/api/organization/overview")
    if overview_response.status_code == 200:
        work_slots = overview_response.json()["work_slots"]
    else:
        assert_status(overview_response, 403)
        classrooms_response = client.get("/api/organization/my-classrooms")
        assert_status(classrooms_response, 200)
        work_slots = next(
            classroom["work_slots"]
            for classroom in classrooms_response.json()["classrooms"]
            if classroom["id"] == classroom_id
        )
    work_slot_id = next(
        work_slot["id"]
        for work_slot in work_slots
        if work_slot["classroom_id"] == classroom_id
        and template_id in work_slot["template_ids"]
        and work_slot["can_create_project"]
    )
    body = {
        "name": unique_name("term_project"),
        "template_id": template_id,
        "work_slot_id": work_slot_id,
    }
    if owner_id is not None:
        body["owner_id"] = owner_id
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json=body,
    )
    assert_status(response, 201)
    return response.json()


def _create_plan(client, label: str = "2026 新學期") -> dict:
    response = client.post(
        "/api/organization/term-reclassification-plans",
        json={"label": label},
    )
    assert_status(response, 201)
    plan = response.json()
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("target_semester_period"),
            "department": "infant",
            "status": "active",
        },
    )
    assert_status(period_response, 200)
    template_id, _ = create_template_with_page(
        client,
        period_id=period_response.json()["id"],
    )
    refreshed_response = client.get(
        f"/api/organization/term-reclassification-plans/{plan['id']}"
    )
    assert_status(refreshed_response, 200)
    refreshed_plan = refreshed_response.json()
    refreshed_plan["target_template_id"] = template_id
    return refreshed_plan


def _stable_project_snapshot(project: dict) -> dict:
    return {
        "owner_id": project["owner_id"],
        "students": [
            {
                key: student.get(key)
                for key in ("id", "name", "album_name", "order_index")
            }
            for student in project["students"]
        ],
        "campus_name": project["campus_name"],
        "classroom_name": project["classroom_name"],
    }


def _plan_update_body(
    plan: dict,
    *,
    expected_revision: int,
    placement_overrides: dict[int, dict] | None = None,
    teacher_overrides: dict[int, list[dict]] | None = None,
) -> dict:
    placement_overrides = placement_overrides or {}
    teacher_overrides = teacher_overrides or {}
    return {
        "expected_revision": expected_revision,
        "student_placements": [
            {
                "source_member_id": placement["source_member_id"],
                "outcome": placement_overrides.get(
                    placement["source_member_id"], placement
                )["outcome"],
                "target_classroom_id": placement_overrides.get(
                    placement["source_member_id"], placement
                )["target_classroom_id"],
            }
            for placement in plan["student_placements"]
        ],
        "classroom_teacher_targets": [
            {
                "classroom_id": classroom_target["classroom_id"],
                "teachers": teacher_overrides.get(
                    classroom_target["classroom_id"],
                    [
                        {
                            "teacher_id": teacher["teacher_id"],
                            "duty": teacher["duty"],
                        }
                        for teacher in classroom_target["teachers"]
                    ],
                ),
            }
            for classroom_target in plan["classroom_teacher_targets"]
        ],
    }


def test_teacher_scope_and_classroom_project_snapshot():
    with started_client() as client:
        login(client)
        supervisor, supervisor_password = create_user(client, "supervisor")
        lead_teacher, lead_password = _create_teacher(client, supervisor["id"])
        co_teacher, co_password = _create_teacher(client, supervisor["id"])
        outsider_teacher, outsider_password = _create_teacher(client, supervisor["id"])
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("scope_class"))
        template_id = _create_active_template(client)
        _add_members(client, classroom_id, [unique_name("snapshot_child")])

        first_replace = _replace_teachers(
            client,
            classroom_id,
            [
                {"teacher_id": lead_teacher["id"], "duty": "lead"},
                {"teacher_id": co_teacher["id"], "duty": "co_teacher"},
            ],
        )
        first_assignment_ids = {
            row["teacher_id"]: row["id"]
            for row in first_replace["current_teachers"]
        }
        same_replace = _replace_teachers(
            client,
            classroom_id,
            [
                {"teacher_id": lead_teacher["id"], "duty": "lead"},
                {"teacher_id": co_teacher["id"], "duty": "co_teacher"},
            ],
        )
        assert {
            row["teacher_id"]: row["id"]
            for row in same_replace["current_teachers"]
        } == first_assignment_ids

        project = _create_classroom_project(client, classroom_id, template_id)
        assert project["owner_id"] == lead_teacher["id"]
        assert project["campus_name"]
        assert project["classroom_name"]
        assert "editors" not in project

        client.cookies.clear()
        login(client, co_teacher["username"], co_password)
        scoped_response = client.get("/api/organization/my-classrooms")
        assert_status(scoped_response, 200)
        assert [row["id"] for row in scoped_response.json()["classrooms"]] == [
            classroom_id
        ]
        forbidden_project = client.post(
            f"/api/organization/classrooms/{classroom_id}/projects",
            json={
                "name": unique_name("co_forbidden"),
                "template_id": template_id,
                "work_slot_id": project["class_period_work_slot_id"],
            },
        )
        assert_status(forbidden_project, 403)

        client.cookies.clear()
        login(client)
        second_template_id = _create_active_template(client)
        client.cookies.clear()
        login(client, lead_teacher["username"], lead_password)
        lead_project = _create_classroom_project(
            client,
            classroom_id,
            second_template_id,
        )
        assert lead_project["created_by_id"] == lead_teacher["id"]

        client.cookies.clear()
        login(client)
        supervisor_replace = client.put(
            f"/api/organization/campuses/{campus_id}/supervisors",
            json={
                "campus_supervisor_ids": [supervisor["id"]],
                "department_supervisors": [
                    {"department": "infant", "supervisor_ids": []},
                    {"department": "academy", "supervisor_ids": []},
                ],
            },
        )
        assert_status(supervisor_replace, 200)

        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        supervisor_scope = client.get("/api/organization/my-classrooms")
        assert_status(supervisor_scope, 200)
        assert [row["id"] for row in supervisor_scope.json()["classrooms"]] == [
            classroom_id
        ]

        client.cookies.clear()
        login(client, outsider_teacher["username"], outsider_password)
        outsider_scope = client.get("/api/organization/my-classrooms")
        assert_status(outsider_scope, 200)
        assert outsider_scope.json() == {
            "classrooms": [],
            "permissions": {"can_view_supervisor_reports": False},
        }


def test_active_term_roster_tracks_final_placement_and_closed_term_freezes():
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        classroom_a_id = _create_classroom(
            client,
            campus_id,
            unique_name("snapshot_a"),
        )
        classroom_b_id = _create_classroom(
            client,
            campus_id,
            unique_name("snapshot_b"),
        )
        member = _add_members(client, classroom_a_id, ["快照原名"])[0]

        db = SessionLocal()
        try:
            current_term = db.query(Semester).filter(
                Semester.status.in_(("imported", "active"))
            ).one()
            original_status = current_term.status
            current_term.status = "active"
            db.commit()
            term_id = current_term.id
        finally:
            db.close()

        rename_response = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{member['id']}",
            json={"name": "快照新名"},
        )
        assert_status(rename_response, 200)
        transfer_response = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{member['id']}",
            json={"target_classroom_id": classroom_b_id},
        )
        assert_status(transfer_response, 200)
        transferred_member = transfer_response.json()["transferred_member"]

        db = SessionLocal()
        try:
            active = db.query(ClassroomMember).filter(
                ClassroomMember.roster_child_id == member["roster_child_id"],
                ClassroomMember.ended_at.is_(None),
            ).all()
            assert len(active) == 1
            assert active[0].classroom_id == classroom_b_id
            assert active[0].id == transferred_member["id"]
            assert active[0].roster_child.name == "快照新名"
        finally:
            db.close()

        depart_response = client.patch(
            f"/api/organization/classrooms/{classroom_b_id}/members/"
            f"{transferred_member['id']}",
            json={"status": "ended", "end_reason": "departed"},
        )
        assert_status(depart_response, 200)

        db = SessionLocal()
        try:
            ended = db.query(ClassroomMember).filter(
                ClassroomMember.roster_child_id == member["roster_child_id"],
            ).order_by(ClassroomMember.id.desc()).first()
            assert ended.classroom_id == classroom_b_id
            assert ended.id == transferred_member["id"]
            assert ended.ended_at is not None

            # 學期一關，那學期的名冊就是歷史：沒有快照表接手，改為由 trigger 擋。
            current_term = db.get(Semester, term_id)
            current_term.status = "closed"
            db.commit()
            ended.end_reason = "不可改寫"
            with pytest.raises(IntegrityError):
                db.commit()
            db.rollback()
        finally:
            db.rollback()
            restored_term = db.get(Semester, term_id)
            if restored_term.status != original_status:
                restored_term.status = original_status
                db.commit()
            db.close()


def test_term_plan_rejects_active_rows_under_inactive_organization_structure():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, _ = _create_teacher(client, supervisor["id"])
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("legacy_inactive"))
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": teacher["id"], "duty": "lead"}],
        )
        _add_members(client, classroom_id, [unique_name("legacy_active_child")])

        db = SessionLocal()
        try:
            db.get(Campus, campus_id).is_active = False
            db.commit()
        finally:
            db.close()
        inactive_campus_response = client.post(
            "/api/organization/term-reclassification-plans",
            json={"label": "異常資料不可建草稿"},
        )
        assert_status(inactive_campus_response, 409)
        assert inactive_campus_response.json()["detail"]["code"] == (
            "inactive_organization_has_active_roster_or_teachers"
        )
        assert inactive_campus_response.json()["detail"]["classroom_ids"] == [
            classroom_id
        ]

        # 班級沒有自己的停用旗標，等價的異常是班級落在已結束的學期卻還有在籍學生
        db = SessionLocal()
        try:
            db.get(Campus, campus_id).is_active = True
            classroom = db.get(Classroom, classroom_id)
            current_term_id = classroom.semester_id
            closed_term = Semester(
                label=unique_name("closed_term"),
                status="closed",
                created_by_name_snapshot="系統管理員",
            )
            db.add(closed_term)
            db.flush()
            classroom.semester_id = closed_term.id
            db.commit()
        finally:
            db.close()
        closed_term_classroom_response = client.post(
            "/api/organization/term-reclassification-plans",
            json={"label": "異常班級不可建草稿"},
        )
        assert_status(closed_term_classroom_response, 409)
        assert closed_term_classroom_response.json()["detail"]["code"] == (
            "inactive_organization_has_active_roster_or_teachers"
        )
        assert closed_term_classroom_response.json()["detail"]["classroom_ids"] == [
            classroom_id
        ]

        db = SessionLocal()
        try:
            db.get(Classroom, classroom_id).semester_id = current_term_id
            db.commit()
            assert db.query(TermReclassificationPlan).filter(
                TermReclassificationPlan.status == "draft"
            ).count() == 0
        finally:
            db.close()


def test_term_plan_applies_students_and_teachers_without_rewriting_old_project():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher_a, _ = _create_teacher(client, supervisor["id"])
        teacher_b, _ = _create_teacher(client, supervisor["id"])
        teacher_c, _ = _create_teacher(client, supervisor["id"])
        campus_id = _create_campus(client)
        classroom_a_id = _create_classroom(client, campus_id, unique_name("old_a"))
        classroom_b_id = _create_classroom(client, campus_id, unique_name("new_b"))
        _replace_teachers(
            client,
            classroom_a_id,
            [
                {"teacher_id": teacher_a["id"], "duty": "lead"},
                {"teacher_id": teacher_b["id"], "duty": "co_teacher"},
            ],
        )
        classroom_b_teachers = _replace_teachers(
            client,
            classroom_b_id,
            [{"teacher_id": teacher_c["id"], "duty": "lead"}],
        )
        members_a = _add_members(client, classroom_a_id, ["編班王小明", "編班李小華"])
        members_b = _add_members(client, classroom_b_id, ["編班陳小安"])
        template_id = _create_active_template(client)
        old_project = _create_classroom_project(
            client,
            classroom_a_id,
            template_id,
            teacher_a["id"],
        )
        old_project_snapshot = _stable_project_snapshot(old_project)
        db = SessionLocal()
        try:
            old_student_rows = [
                (
                    student.id,
                    student.project_id,
                    student.name,
                    student.album_name,
                    student.order_index,
                    student.pages_data_json,
                    student.output_filename,
                    student.roster_child_id,
                )
                for student in db.query(ProjectStudent)
                .filter(ProjectStudent.project_id == old_project["id"])
                .order_by(ProjectStudent.id)
            ]
        finally:
            db.close()

        plan = _create_plan(client)
        assert plan["revision"] == 1
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        assert overview.json()["draft_term_plan_id"] == plan["id"]
        placement_by_name = {
            placement["student_name"]: placement
            for placement in plan["student_placements"]
        }
        # 目標學期的班是新建的，計畫裡一律以新班 id 表示；舊班 id 只出現在來源欄位。
        target_classroom_id_by_source = {
            placement["source_classroom_id"]: placement["target_classroom_id"]
            for placement in plan["student_placements"]
        }
        target_a_id = target_classroom_id_by_source[classroom_a_id]
        target_b_id = target_classroom_id_by_source[classroom_b_id]
        update_body = _plan_update_body(
            plan,
            expected_revision=1,
            placement_overrides={
                placement_by_name["編班李小華"]["source_member_id"]: {
                    "outcome": "classroom",
                    "target_classroom_id": target_b_id,
                },
                placement_by_name["編班陳小安"]["source_member_id"]: {
                    "outcome": "departed",
                    "target_classroom_id": None,
                },
            },
            teacher_overrides={
                target_a_id: [
                    {"teacher_id": teacher_b["id"], "duty": "lead"}
                ],
                target_b_id: [
                    {"teacher_id": teacher_c["id"], "duty": "lead"},
                    {"teacher_id": teacher_a["id"], "duty": "co_teacher"},
                ],
            },
        )
        update_response = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=update_body,
        )
        assert_status(update_response, 200)
        updated_plan = update_response.json()
        assert updated_plan["revision"] == 2
        assert "編班王小明" in {
            row["student_name"]
            for row in updated_plan["diff"]["students"]["stay"]
        }
        assert {
            row["student_name"]
            for row in updated_plan["diff"]["students"]["move"]
        } == {"編班李小華"}
        assert {
            row["student_name"]
            for row in updated_plan["diff"]["students"]["departed"]
        } == {"編班陳小安"}
        classroom_counts = {
            row["classroom_id"]: row
            for row in updated_plan["diff"]["students"]["classroom_counts"]
        }
        assert classroom_counts[target_a_id] == {
            "classroom_id": target_a_id,
            "before": 2,
            "after": 1,
            "change": -1,
        }
        assert classroom_counts[target_b_id] == {
            "classroom_id": target_b_id,
            "before": 1,
            "after": 1,
            "change": 0,
        }
        assert updated_plan["validation"]["is_valid"] is True

        validation_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/validate"
        )
        assert_status(validation_response, 200)
        assert validation_response.json()["validation"]["is_valid"] is True

        db = SessionLocal()
        try:
            active_member_ids_before = {
                row.id
                for row in db.query(ClassroomMember)
                .filter(
                    ClassroomMember.classroom_id.in_([
                        classroom_a_id,
                        classroom_b_id,
                    ]),
                    ClassroomMember.ended_at.is_(None),
                )
                .all()
            }
            active_assignment_ids_before = {
                row.id
                for row in db.query(ClassroomTeacher)
                .filter(ClassroomTeacher.ended_at.is_(None))
                .all()
            }
            unchanged_b_lead_id = next(
                row["id"]
                for row in classroom_b_teachers["current_teachers"]
                if row["teacher_id"] == teacher_c["id"]
            )
        finally:
            db.close()
        assert active_member_ids_before == {
            row["id"] for row in [*members_a, *members_b]
        }

        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": 2},
        )
        assert_status(apply_response, 200)
        applied_plan = apply_response.json()
        assert applied_plan["status"] == "applied"
        assert {
            row["classroom_id"]: row
            for row in applied_plan["diff"]["students"]["classroom_counts"]
            if row["classroom_id"] in {target_a_id, target_b_id}
        } == {
            target_a_id: classroom_counts[target_a_id],
            target_b_id: classroom_counts[target_b_id],
        }
        applied_at = datetime.fromisoformat(applied_plan["applied_at"])

        db = SessionLocal()
        try:
            # 舊學期的班隨學期結束，在籍成員全部落在新學期的班
            assert (
                db.query(ClassroomMember)
                .filter(
                    ClassroomMember.classroom_id.in_([
                        classroom_a_id,
                        classroom_b_id,
                    ]),
                    ClassroomMember.ended_at.is_(None),
                )
                .count()
            ) == 0
            target_term_id = applied_plan["target_semester_id"]
            active_members = (
                db.query(ClassroomMember)
                .join(Student, Student.id == ClassroomMember.roster_child_id)
                .join(Classroom, Classroom.id == ClassroomMember.classroom_id)
                .filter(
                    Classroom.semester_id == target_term_id,
                    ClassroomMember.ended_at.is_(None),
                )
                .all()
            )
            assert {
                member.roster_child.name: member.classroom_id
                for member in active_members
            } == {
                "編班王小明": target_a_id,
                "編班李小華": target_b_id,
            }
            assert (
                db.query(Project)
                .join(
                    ClassPeriodWorkSlot,
                    ClassPeriodWorkSlot.id == Project.class_period_work_slot_id,
                )
                .join(
                    Classroom,
                    Classroom.id
                    == ClassPeriodWorkSlot.classroom_id,
                )
                .filter(
                    Classroom.semester_id == target_term_id
                )
                .count()
            ) == 0
            moved_old = db.get(
                ClassroomMember,
                placement_by_name["編班李小華"]["source_member_id"],
            )
            departed_old = db.get(
                ClassroomMember,
                placement_by_name["編班陳小安"]["source_member_id"],
            )
            assert moved_old.end_reason == "term_reassignment"
            assert moved_old.ended_at == applied_at
            assert departed_old.end_reason == "term_departed"
            assert departed_old.ended_at == applied_at
            moved_new = next(
                member
                for member in active_members
                if member.roster_child.name == "編班李小華"
            )
            assert moved_new.started_at == applied_at

            active_assignments = db.query(ClassroomTeacher).filter(
                ClassroomTeacher.ended_at.is_(None)
            ).all()
            active_teacher_state = {
                (assignment.classroom_id, assignment.teacher_id): assignment
                for assignment in active_assignments
            }
            assert active_teacher_state[(target_a_id, teacher_b["id"])].duty == "lead"
            # 舊班的編制隨學期結束，留任的主教在新班是另一筆指派
            assert (
                active_teacher_state[(target_b_id, teacher_c["id"])].id
                != unchanged_b_lead_id
            )
            assert active_teacher_state[(target_b_id, teacher_c["id"])].duty == "lead"
            assert active_teacher_state[(target_b_id, teacher_a["id"])].duty == "co_teacher"
            changed_assignments = [
                assignment
                for assignment in db.query(ClassroomTeacher).all()
                if assignment.ended_at == applied_at or assignment.started_at == applied_at
            ]
            assert changed_assignments
            assert all(
                assignment.ended_at in {None, applied_at}
                and assignment.started_at <= applied_at
                for assignment in changed_assignments
            )
            project_count_before_retry = db.query(Project).count()
            membership_count_before_retry = db.query(ClassroomMember).count()
            assignment_count_before_retry = db.query(ClassroomTeacher).count()
            assert old_student_rows == [
                (
                    student.id,
                    student.project_id,
                    student.name,
                    student.album_name,
                    student.order_index,
                    student.pages_data_json,
                    student.output_filename,
                    student.roster_child_id,
                )
                for student in db.query(ProjectStudent)
                .filter(ProjectStudent.project_id == old_project["id"])
                .order_by(ProjectStudent.id)
            ]
        finally:
            db.close()

        old_detail = client.get(f"/api/projects/{old_project['id']}")
        assert_status(old_detail, 200)
        assert _stable_project_snapshot(old_detail.json()) == old_project_snapshot

        target_template_id = plan["target_template_id"]
        future_a = _create_classroom_project(
            client,
            target_a_id,
            target_template_id,
        )
        future_b = _create_classroom_project(
            client,
            target_b_id,
            target_template_id,
        )
        assert [student["name"] for student in future_a["students"]] == [
            "編班王小明"
        ]
        assert future_a["owner_id"] == teacher_b["id"]
        assert [student["name"] for student in future_b["students"]] == [
            "編班李小華"
        ]
        assert future_b["owner_id"] == teacher_c["id"]
        assert "editors" not in future_b

        retry_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": 2},
        )
        assert_status(retry_response, 200)
        assert retry_response.json()["status"] == "applied"
        db = SessionLocal()
        try:
            assert db.query(Project).count() == project_count_before_retry + 2
            assert db.query(ClassroomMember).count() == membership_count_before_retry
            assert (
                db.query(ClassroomTeacher).count()
                == assignment_count_before_retry
            )
            assert active_assignment_ids_before
        finally:
            db.close()


def test_term_plan_stale_guard_and_admin_only_access_leave_current_state_untouched():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, teacher_password = _create_teacher(client, supervisor["id"])
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("stale_class"))
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": teacher["id"], "duty": "lead"}],
        )
        _add_members(client, classroom_id, ["周小樂"])
        plan = _create_plan(client, "2027 新學期")

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        assert_status(
            client.get(f"/api/organization/term-reclassification-plans/{plan['id']}"),
            403,
        )
        client.cookies.clear()
        login(client)
        _add_members(client, classroom_id, ["林小安"])

        db = SessionLocal()
        try:
            memberships_before = [
                (row.id, row.classroom_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomMember).order_by(ClassroomMember.id)
            ]
            assignments_before = [
                (row.id, row.classroom_id, row.teacher_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomTeacher).order_by(
                    ClassroomTeacher.id
                )
            ]
        finally:
            db.close()

        validate_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/validate"
        )
        assert_status(validate_response, 409)
        assert validate_response.json()["detail"]["code"] == "stale_reclassification_plan"
        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": 1},
        )
        assert_status(apply_response, 409)
        assert apply_response.json()["detail"]["code"] == "stale_reclassification_plan"

        db = SessionLocal()
        try:
            assert memberships_before == [
                (row.id, row.classroom_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomMember).order_by(ClassroomMember.id)
            ]
            assert assignments_before == [
                (row.id, row.classroom_id, row.teacher_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomTeacher).order_by(
                    ClassroomTeacher.id
                )
            ]
            stored_plan = db.get(TermReclassificationPlan, plan["id"])
            assert stored_plan.status == "draft"
        finally:
            db.close()
        cancel_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/cancel"
        )
        assert_status(cancel_response, 200)
        assert cancel_response.json()["status"] == "cancelled"


def test_term_plan_revision_and_business_validation_are_separate():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        art_user, _ = create_user(client, "art_team")
        teacher, _ = _create_teacher(client, supervisor["id"])
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("invalid_class"))
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": teacher["id"], "duty": "lead"}],
        )
        plan = _create_plan(client, "2028 新學期")
        # 編制設定的對象是目標學期新建的班，不是這個班在目前學期的樣子
        target_classroom_id = next(
            classroom_target["classroom_id"]
            for classroom_target in plan["classroom_teacher_targets"]
        )
        assert target_classroom_id != classroom_id
        invalid_update_body = _plan_update_body(
            plan,
            expected_revision=99,
            teacher_overrides={
                target_classroom_id: [
                    {"teacher_id": art_user["id"], "duty": "lead"},
                    {"teacher_id": teacher["id"], "duty": "lead"},
                ]
            },
        )
        conflict_response = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=invalid_update_body,
        )
        assert_status(conflict_response, 409)
        assert conflict_response.json()["detail"]["code"] == (
            "term_plan_revision_conflict"
        )

        invalid_update_body["expected_revision"] = 1
        update_response = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=invalid_update_body,
        )
        assert_status(update_response, 200)
        assert update_response.json()["revision"] == 2
        assert update_response.json()["validation"]["is_valid"] is False
        assert {
            error["code"] for error in update_response.json()["validation"]["errors"]
        } == {"invalid_lead_count", "invalid_teacher_role"}
        validation_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/validate"
        )
        assert_status(validation_response, 200)
        assert validation_response.json()["validation"]["is_valid"] is False
        assert {
            error["code"]
            for error in validation_response.json()["validation"]["errors"]
        } == {"invalid_lead_count", "invalid_teacher_role"}

        db = SessionLocal()
        try:
            active_assignment_ids = {
                row.id
                for row in db.query(ClassroomTeacher)
                .filter(ClassroomTeacher.ended_at.is_(None))
                .all()
            }
        finally:
            db.close()
        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": 2},
        )
        assert_status(apply_response, 422)
        assert apply_response.json()["detail"]["code"] == "invalid_target_state"
        db = SessionLocal()
        try:
            assert active_assignment_ids == {
                row.id
                for row in db.query(ClassroomTeacher)
                .filter(ClassroomTeacher.ended_at.is_(None))
                .all()
            }
        finally:
            db.close()
        assert_status(
            client.post(
                f"/api/organization/term-reclassification-plans/{plan['id']}/cancel"
            ),
            200,
        )


def test_overview_lists_only_current_semester_classrooms_while_draft_exists():
    """建了編班草稿之後，園所設定不能同時列出兩個學期的同名班。

    班級不跨學期，草稿會先把下學期的班長出來；不過濾的話同一個班名會出現兩次，
    一個標「本學期」一個標「已結束」。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        classroom_name = unique_name("草稿期間唯一班名")
        classroom_id = _create_classroom(client, campus_id, classroom_name)
        _add_members(client, classroom_id, [unique_name("草稿期間學生")])

        def campus_classrooms() -> list[dict]:
            overview = client.get("/api/organization/overview")
            assert_status(overview, 200)
            return next(
                campus["classrooms"]
                for campus in overview.json()["campuses"]
                if campus["id"] == campus_id
            )

        assert [row["name"] for row in campus_classrooms()] == [classroom_name]

        plan = _create_plan(client)
        target_classroom_ids = {
            row["classroom_id"] for row in plan["target_classrooms"]
        }
        assert target_classroom_ids and classroom_id not in target_classroom_ids

        after_draft = campus_classrooms()
        assert [row["name"] for row in after_draft] == [classroom_name]
        assert [row["id"] for row in after_draft] == [classroom_id]
        assert all(row["is_current"] for row in after_draft)


def test_apply_ends_teachers_of_classrooms_without_students():
    """空班的老師編制也要隨學期結束。

    只結束「有學生的班」的話，空班的老師會留在已結束的學期裡；下一次建草稿就會被
    inactive_organization_has_active_roster_or_teachers 擋住，而且訊息指向一個
    使用者根本沒動過的班。
    """
    with started_client() as client:
        login(client)
        teacher, _ = _create_teacher(client, None)
        empty_class_teacher, _ = _create_teacher(client, None)
        campus_id = _create_campus(client)
        staffed_classroom_id = _create_classroom(client, campus_id, unique_name("有學生的班"))
        empty_classroom_id = _create_classroom(client, campus_id, unique_name("沒有學生的班"))
        _replace_teachers(
            client,
            staffed_classroom_id,
            [{"teacher_id": teacher["id"], "duty": "lead"}],
        )
        _replace_teachers(
            client,
            empty_classroom_id,
            [{"teacher_id": empty_class_teacher["id"], "duty": "lead"}],
        )
        _add_members(client, staffed_classroom_id, [unique_name("唯一的學生")])

        plan = _create_plan(client)
        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": plan["revision"]},
        )
        assert_status(apply_response, 200)

        db = SessionLocal()
        try:
            lingering = (
                db.query(ClassroomTeacher)
                .filter(
                    ClassroomTeacher.classroom_id.in_(
                        [staffed_classroom_id, empty_classroom_id]
                    ),
                    ClassroomTeacher.ended_at.is_(None),
                )
                .all()
            )
            assert lingering == []
        finally:
            db.close()

        # 舊學期沒有殘留的在職編制，才建得起下一份草稿
        next_plan = client.post(
            "/api/organization/term-reclassification-plans",
            json={"label": unique_name("再下一個學期")},
        )
        assert_status(next_plan, 201)


def test_closed_term_freeze_blocks_moving_active_rows_into_history():
    """不能把在籍成員或在職編制「更新」到已結束學期的班。

    UPDATE trigger 只檢查 OLD 的話，來源是 active 班就一路放行，等於繞過凍結
    把資料塞進歷史。
    """
    with started_client() as client:
        login(client)
        teacher, _ = _create_teacher(client, None)
        campus_id = _create_campus(client)
        active_classroom_id = _create_classroom(client, campus_id, unique_name("在籍班"))
        _replace_teachers(
            client,
            active_classroom_id,
            [{"teacher_id": teacher["id"], "duty": "lead"}],
        )
        _add_members(client, active_classroom_id, [unique_name("在籍學生")])

        db = SessionLocal()
        try:
            closed_semester = Semester(
                label=unique_name("已結束學期"),
                status="closed",
                created_by_name_snapshot="系統管理員",
            )
            db.add(closed_semester)
            db.flush()
            closed_classroom = Classroom(
                semester_id=closed_semester.id,
                campus_id=campus_id,
                department="infant",
                name=unique_name("歷史班"),
            )
            db.add(closed_classroom)
            db.commit()
            closed_classroom_id = closed_classroom.id
        finally:
            db.close()

        db = SessionLocal()
        try:
            member = (
                db.query(ClassroomMember)
                .filter(
                    ClassroomMember.classroom_id == active_classroom_id,
                    ClassroomMember.ended_at.is_(None),
                )
                .one()
            )
            member.classroom_id = closed_classroom_id
            with pytest.raises(IntegrityError):
                db.commit()
            db.rollback()
        finally:
            db.close()

        db = SessionLocal()
        try:
            assignment = (
                db.query(ClassroomTeacher)
                .filter(
                    ClassroomTeacher.classroom_id == active_classroom_id,
                    ClassroomTeacher.ended_at.is_(None),
                )
                .one()
            )
            assignment.classroom_id = closed_classroom_id
            with pytest.raises(IntegrityError):
                db.commit()
            db.rollback()
        finally:
            db.close()

        # 兩筆都還留在原本的在籍班
        db = SessionLocal()
        try:
            assert db.query(ClassroomMember).filter(
                ClassroomMember.classroom_id == active_classroom_id,
                ClassroomMember.ended_at.is_(None),
            ).count() == 1
            assert db.query(ClassroomTeacher).filter(
                ClassroomTeacher.classroom_id == active_classroom_id,
                ClassroomTeacher.ended_at.is_(None),
            ).count() == 1
        finally:
            db.close()


def test_placement_stay_target_survives_moving_a_student_away():
    """搬走再改回原班，仍要認得出「沒有變更」。

    stay_classroom_id 是「來源班在目標學期的對應班」，與使用者目前選了什麼無關；
    若它只在目前是 stay 時才有值，搬走並儲存後就永遠回不到未變更狀態。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        source_classroom_id = _create_classroom(client, campus_id, unique_name("原班"))
        _create_classroom(client, campus_id, unique_name("別班"))
        _add_members(client, source_classroom_id, [unique_name("被搬來搬去的學生")])

        plan = _create_plan(client)
        placement = plan["student_placements"][0]
        stay_classroom_id = placement["stay_classroom_id"]
        assert stay_classroom_id == placement["target_classroom_id"]
        assert placement["keeps_source_classroom"] is True

        target_by_source = {
            row["source_classroom_id"]: row["target_classroom_id"]
            for row in plan["student_placements"]
        }
        other_target_id = next(
            row["classroom_id"]
            for row in plan["target_classrooms"]
            if row["classroom_id"] not in target_by_source.values()
        )

        moved = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=_plan_update_body(
                plan,
                expected_revision=plan["revision"],
                placement_overrides={
                    placement["source_member_id"]: {
                        "outcome": "classroom",
                        "target_classroom_id": other_target_id,
                    },
                },
            ),
        )
        assert_status(moved, 200)
        moved_placement = moved.json()["student_placements"][0]
        assert moved_placement["keeps_source_classroom"] is False
        # 搬走之後 stay 目標仍在，前端才判斷得出「改回來就是沒變更」
        assert moved_placement["stay_classroom_id"] == stay_classroom_id

        restored = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=_plan_update_body(
                moved.json(),
                expected_revision=moved.json()["revision"],
                placement_overrides={
                    placement["source_member_id"]: {
                        "outcome": "classroom",
                        "target_classroom_id": stay_classroom_id,
                    },
                },
            ),
        )
        assert_status(restored, 200)
        restored_placement = restored.json()["student_placements"][0]
        assert restored_placement["keeps_source_classroom"] is True
        assert restored_placement["stay_classroom_id"] == stay_classroom_id
        assert restored.json()["diff"]["students"]["move"] == []


def test_draft_classroom_rename_scopes_uniqueness_to_its_own_semester():
    """草稿學期的班改名，唯一性只看它自己那個學期。

    固定查目前學期會兩頭錯：草稿裡的合法改名被目前學期的同名班擋掉，草稿內真正的
    衝突反而漏過檢查、最後撞 DB 約束變成 500。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        first_name = unique_name("甲班")
        second_name = unique_name("乙班")
        first_classroom_id = _create_classroom(client, campus_id, first_name)
        _create_classroom(client, campus_id, second_name)
        _add_members(client, first_classroom_id, [unique_name("草稿改名學生")])

        plan = _create_plan(client)
        draft_by_name = {
            row["name"]: row["classroom_id"] for row in plan["target_classrooms"]
        }
        draft_first_id = draft_by_name[first_name]

        # 草稿建立之後才出現在目前學期的班名——草稿學期沒有它
        current_only_name = unique_name("只在目前學期")
        _create_classroom(client, campus_id, current_only_name)

        allowed = client.patch(
            f"/api/organization/classrooms/{draft_first_id}",
            json={"name": current_only_name},
        )
        assert_status(allowed, 200)
        assert allowed.json()["name"] == current_only_name

        # 同一個草稿學期內撞名要在 preflight 就擋下
        conflict = client.patch(
            f"/api/organization/classrooms/{draft_first_id}",
            json={"name": second_name},
        )
        assert_status(conflict, 409)
        assert conflict.json()["detail"] == "同分校與部門已有同名班級"


def test_draft_semester_accepts_new_classroom_and_removal_of_empty_ones():
    """編班草稿要能多開一個班，也要能把多開錯的班移除。

    草稿只會照目前的班一對一複製；新學期真的要多開一個班時，這是唯一的入口。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        source_classroom_id = _create_classroom(client, campus_id, unique_name("既有班"))
        _add_members(client, source_classroom_id, [unique_name("既有班學生")])

        plan = _create_plan(client)
        target_semester_id = plan["target_semester_id"]
        assert len(plan["target_classrooms"]) == 1

        added = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("新學期多開的班"),
                "semester_id": target_semester_id,
            },
        )
        assert_status(added, 201)
        added_classroom_id = added.json()["id"]
        assert added.json()["semester_id"] == target_semester_id
        assert added.json()["is_current"] is False

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan['id']}"
        )
        assert_status(refreshed, 200)
        assert added_classroom_id in {
            row["classroom_id"] for row in refreshed.json()["target_classrooms"]
        }

        # 學生可以被編進這個新班
        placement = refreshed.json()["student_placements"][0]
        moved = client.put(
            f"/api/organization/term-reclassification-plans/{plan['id']}",
            json=_plan_update_body(
                refreshed.json(),
                expected_revision=refreshed.json()["revision"],
                placement_overrides={
                    placement["source_member_id"]: {
                        "outcome": "classroom",
                        "target_classroom_id": added_classroom_id,
                    },
                },
            ),
        )
        assert_status(moved, 200)
        assert [row["student_name"] for row in moved.json()["diff"]["students"]["move"]] == [
            placement["student_name"]
        ]

        # 已被指到的班不可移除
        occupied = client.delete(f"/api/organization/classrooms/{added_classroom_id}")
        assert_status(occupied, 409)
        assert occupied.json()["detail"]["code"] == "classroom_not_empty"

        spare = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("多開錯的班"),
                "semester_id": target_semester_id,
            },
        )
        assert_status(spare, 201)
        removed = client.delete(
            f"/api/organization/classrooms/{spare.json()['id']}"
        )
        assert_status(removed, 200)

        # 目前學期的班不可移除——那是歷史的一部分
        current_removal = client.delete(
            f"/api/organization/classrooms/{source_classroom_id}"
        )
        assert_status(current_removal, 409)
        assert current_removal.json()["detail"]["code"] == (
            "classroom_not_in_draft_semester"
        )


def test_draft_classroom_addition_does_not_invalidate_the_plan():
    """在草稿學期多開一個班，不該讓草稿變成 stale。

    source fingerprint 是「目前學期的狀態」的快照；草稿學期的班不屬於它。
    這條沒守住的話，新增班級的功能等於不能用——加完就套用不了。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("既有班"))
        _add_members(client, classroom_id, [unique_name("既有學生")])

        plan = _create_plan(client)
        added = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("草稿多開的班"),
                "semester_id": plan["target_semester_id"],
            },
        )
        assert_status(added, 201)

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan['id']}"
        ).json()
        assert refreshed["validation"]["is_valid"] is True
        applied = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": refreshed["revision"]},
        )
        assert_status(applied, 200)


def test_current_semester_classroom_addition_marks_the_plan_stale():
    """反過來：目前學期多了一個班，草稿就是過期的，即使那個班是空的。

    fingerprint 涵蓋目前學期的班級清單，這是刻意的保守——草稿是整園狀態的快照，
    狀態變了就重建，不去猜哪些變動「其實不影響」。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("既有班"))
        _add_members(client, classroom_id, [unique_name("既有學生")])

        plan = _create_plan(client)
        unrelated = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("目前學期新開的空班"),
            },
        )
        assert_status(unrelated, 201)

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan['id']}"
        ).json()
        assert [
            error["code"] for error in refreshed["validation"]["errors"]
        ] == ["stale_reclassification_plan"]
        applied = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": refreshed["revision"]},
        )
        assert_status(applied, 409)
        assert applied.json()["detail"]["code"] == "stale_reclassification_plan"


def test_fingerprint_ignores_rows_outside_the_current_semester():
    """fingerprint 只涵蓋目前學期的名冊與編制。

    少了學期條件時，草稿學期班上的任何一筆 active 列都會讓草稿變 stale——而那些列
    正是套用當下要建立的東西。之前不會出錯只是因為別處擋住了寫入。
    """
    with started_client() as client:
        login(client)
        teacher, _ = _create_teacher(client, None)
        campus_id = _create_campus(client)
        classroom_id = _create_classroom(client, campus_id, unique_name("既有班"))
        _add_members(client, classroom_id, [unique_name("既有學生")])

        plan = _create_plan(client)
        draft_classroom_id = plan["target_classrooms"][0]["classroom_id"]

        # 直接寫進草稿學期的班（API 會擋，但 fingerprint 的定義不該依賴那道檢查）
        db = SessionLocal()
        try:
            # 全園唯一鍵擋住「同一個孩子同時在兩個班」，所以另建一個沒有在籍紀錄的
            roster_child = Student(name=unique_name("只在草稿班的孩子"))
            db.add(roster_child)
            db.flush()
            db.add(ClassroomMember(
                classroom_id=draft_classroom_id,
                roster_child_id=roster_child.id,
            ))
            db.add(ClassroomTeacher(
                classroom_id=draft_classroom_id,
                teacher_id=teacher["id"],
                teacher_name_snapshot=teacher["display_name"],
                duty="lead",
                started_by_name_snapshot="系統管理員",
            ))
            db.commit()
        finally:
            db.close()

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan['id']}"
        ).json()
        assert "stale_reclassification_plan" not in {
            error["code"] for error in refreshed["validation"]["errors"]
        }


def test_new_draft_classroom_takes_teachers_and_unused_copies_can_be_dropped():
    """新學期的班要能編老師；這學期收掉、下學期不開的班要能移除。

    這兩件事以前都做不到，而且都是靜默的：
    - 草稿只在建立當下長出 `TermClassroomPlan`，後加的班沒有 plan 列，老師編制頁面
      根本不會出現它，套用後成為無人帶班的空班
    - `delete_classroom` 把 plan 列當成佔用，而複製來的班每一個都有 plan 列，
      等於一個都刪不掉——包括這學期收掉的班
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        kept_id = _create_classroom(client, campus_id, unique_name("續開的班"))
        _create_classroom(client, campus_id, unique_name("下學期收掉的班"))
        _add_members(client, kept_id, [unique_name("續讀學生")])
        teacher, _ = _create_teacher(client, None)

        plan = _create_plan(client)
        plan_id = plan["id"]
        target_semester_id = plan["target_semester_id"]
        copies = {row["name"]: row for row in plan["target_classrooms"]}
        dropped_copy_id = copies[
            next(name for name in copies if name.startswith("下學期收掉的班"))
        ]["classroom_id"]
        kept_copy_id = copies[
            next(name for name in copies if name.startswith("續開的班"))
        ]["classroom_id"]

        # 沒有人被編進去的複製班可以移除；有 placement 指著的不行
        assert copies[
            next(name for name in copies if name.startswith("下學期收掉的班"))
        ]["can_remove"] is True
        assert copies[
            next(name for name in copies if name.startswith("續開的班"))
        ]["can_remove"] is False
        blocked = client.delete(f"/api/organization/classrooms/{kept_copy_id}")
        assert_status(blocked, 409)
        assert blocked.json()["detail"]["counts"] == {"placements": 1}

        removed = client.delete(f"/api/organization/classrooms/{dropped_copy_id}")
        assert_status(removed, 200)

        # 移除後它就不在老師編制裡了。這裡要先驗完再新增班級——SQLite 會回收
        # 剛刪掉的 rowid，新班很可能拿到同一個 id，用 id 比對會得到假的結果。
        after_removal = client.get(
            f"/api/organization/term-reclassification-plans/{plan_id}"
        ).json()
        assert dropped_copy_id not in {
            row["classroom_id"] for row in after_removal["classroom_teacher_targets"]
        }
        assert dropped_copy_id not in {
            row["classroom_id"] for row in after_removal["target_classrooms"]
        }

        # 新開一個班，它必須進到老師編制裡
        added = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("新學期多開的班"),
                "semester_id": target_semester_id,
            },
        )
        assert_status(added, 201)
        added_id = added.json()["id"]

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan_id}"
        ).json()
        target_ids = {row["classroom_id"] for row in refreshed["classroom_teacher_targets"]}
        assert added_id in target_ids, "新開的班必須出現在老師編制裡"
        assert next(
            row for row in refreshed["classroom_teacher_targets"]
            if row["classroom_id"] == added_id
        )["teachers"] == [], "新班的編制應該是空的，等人指定"

        updated = client.put(
            f"/api/organization/term-reclassification-plans/{plan_id}",
            json=_plan_update_body(
                refreshed,
                expected_revision=refreshed["revision"],
                teacher_overrides={
                    added_id: [{"teacher_id": teacher["id"], "duty": "lead"}],
                },
            ),
        )
        assert_status(updated, 200)

        ready = client.get(
            f"/api/organization/term-reclassification-plans/{plan_id}"
        ).json()
        assert ready["validation"]["is_valid"] is True
        applied = client.post(
            f"/api/organization/term-reclassification-plans/{plan_id}/apply",
            json={"expected_revision": ready["revision"]},
        )
        assert_status(applied, 200)

        # 套用後那個新班真的有主教，不是空班
        teachers_after = client.get("/api/organization/overview").json()
        classrooms_after = {
            room["id"]: room
            for campus in teachers_after["campuses"]
            for room in campus["classrooms"]
        }
        assert [
            (item["teacher_id"], item["duty"])
            for item in classrooms_after[added_id]["current_teachers"]
        ] == [(teacher["id"], "lead")]


def test_draft_semester_without_a_plan_cannot_grow_classrooms():
    """沒有編班計畫的草稿學期不可以長出班級。

    草稿學期唯一的用途是承載編班計畫，這時建出來的班不在園所總覽、也不會被任何
    套用流程處理——是永遠看不到也刪不掉的孤兒。

    正常流程造不出這個狀態（取消計畫會連同目標學期一起取消），所以這裡直接寫一筆
    沒有計畫的草稿學期進去，驗證守衛本身成立而不是依賴上游剛好沒有漏洞。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)

        session = SessionLocal()
        try:
            orphan = Semester(
                label=unique_name("沒有計畫的草稿"),
                status="draft",
                created_by_name_snapshot="測試",
            )
            session.add(orphan)
            session.commit()
            orphan_id = orphan.id
        finally:
            session.close()

        rejected = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("孤兒班"),
                "semester_id": orphan_id,
            },
        )
        assert_status(rejected, 409)
        assert rejected.json()["detail"]["code"] == "draft_semester_has_no_plan"


def test_draft_semester_accepts_new_students_who_survive_apply():
    """名冊裡還沒有的新生，必須能在草稿階段就編進新學期的班。

    新生沒有來源名單列，所以不是 placement。套用只處理 placement，因此他們會原封不動
    留在新學期。少了這條路，新生只能等套用完才補建，那段期間沒有班也沒有相本——
    2026-08 照行政系統演練 115 上時，24 位新生就是卡在這裡。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        source_classroom_id = _create_classroom(client, campus_id, unique_name("原班"))
        _add_members(client, source_classroom_id, [unique_name("續讀生")])

        plan = _create_plan(client)
        target_classroom_id = plan["target_classrooms"][0]["classroom_id"]
        assert plan["new_students"] == []

        newcomer_name = unique_name("新生")
        added = client.post(
            f"/api/organization/classrooms/{target_classroom_id}/members/batch",
            json={"members": [{"name": newcomer_name}]},
        )
        assert_status(added, 201)

        refreshed = client.get(
            f"/api/organization/term-reclassification-plans/{plan['id']}"
        )
        assert_status(refreshed, 200)
        body = refreshed.json()
        assert [
            (row["classroom_id"], row["name"]) for row in body["new_students"]
        ] == [(target_classroom_id, newcomer_name)]
        # 新生不是 placement——他沒有來源名單列可以當 key
        assert newcomer_name not in {
            row["student_name"] for row in body["student_placements"]
        }

        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": body["revision"]},
        )
        assert_status(apply_response, 200)

        db = SessionLocal()
        try:
            names = {
                member.roster_child.name
                for member in db.query(ClassroomMember).filter(
                    ClassroomMember.classroom_id == target_classroom_id,
                    ClassroomMember.ended_at.is_(None),
                )
            }
        finally:
            db.close()
        assert newcomer_name in names, "新生套用後不見了"
        assert len(names) == 2, f"新學期的班應該有續讀生與新生兩位，實際 {names}"


def test_classrooms_outside_current_or_drafting_semesters_reject_new_members():
    """已關閉學期的班不可以再加人——那是歷史，不是可編輯的名單。"""
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        source_classroom_id = _create_classroom(client, campus_id, unique_name("原班"))
        _add_members(client, source_classroom_id, [unique_name("續讀生")])

        plan = _create_plan(client)
        apply_response = client.post(
            f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
            json={"expected_revision": plan["revision"]},
        )
        assert_status(apply_response, 200)

        rejected = client.post(
            f"/api/organization/classrooms/{source_classroom_id}/members/batch",
            json={"members": [{"name": unique_name("補加")}]},
        )
        assert_status(rejected, 409)


def test_removing_a_draft_newcomer_frees_the_classroom_for_deletion():
    """新生編入又移除之後，那個班還要刪得掉。

    `classroom_members` 對 `classrooms` 的外鍵沒有 CASCADE，移除班級又會數所有成員列
    （含已結束的）。所以草稿學期的新生必須整列刪掉，不能只是把在班區間結束——否則
    多開錯一個班、試編了一位新生，那個班就永遠留在新學期了。
    """
    with started_client() as client:
        login(client)
        campus_id = _create_campus(client)
        source_classroom_id = _create_classroom(client, campus_id, unique_name("原班"))
        _add_members(client, source_classroom_id, [unique_name("續讀生")])

        plan = _create_plan(client)
        spare = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_id,
                "department": "infant",
                "name": unique_name("多開的班"),
                "semester_id": plan["target_semester_id"],
            },
        )
        assert_status(spare, 201)
        spare_id = spare.json()["id"]

        newcomer = unique_name("新生")
        added = client.post(
            f"/api/organization/classrooms/{spare_id}/members/batch",
            json={"members": [{"name": newcomer}]},
        )
        assert_status(added, 201)
        member_id = added.json()["created"][0]["id"]

        occupied = client.delete(f"/api/organization/classrooms/{spare_id}")
        assert_status(occupied, 409)

        db = SessionLocal()
        try:
            roster_child_id = int(
                db.get(ClassroomMember, member_id).roster_child_id
            )
        finally:
            db.close()

        removed = client.delete(
            f"/api/organization/classrooms/{spare_id}/members/{member_id}"
        )
        assert_status(removed, 200)

        db = SessionLocal()
        try:
            assert db.get(Student, roster_child_id) is None, (
                "名冊項要一起收回，否則再編一次同一位新生就變成兩個孩子"
            )
        finally:
            db.close()

        freed = client.delete(f"/api/organization/classrooms/{spare_id}")
        assert_status(freed, 200)

        # 目前學期的名單列不可以走這條路——那是有歷史的
        db = SessionLocal()
        try:
            source_member_id = db.query(ClassroomMember.id).filter(
                ClassroomMember.classroom_id == source_classroom_id
            ).scalar()
        finally:
            db.close()
        rejected = client.delete(
            f"/api/organization/classrooms/{source_classroom_id}"
            f"/members/{source_member_id}"
        )
        assert_status(rejected, 409)
        assert rejected.json()["detail"]["code"] == "member_not_in_draft_semester"
