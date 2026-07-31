"""班級老師編制與新學期整園重新編班契約。"""

from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from database import (
    AcademicTerm,
    Classroom,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacherAssignment,
    ClassRosterMember,
    Project,
    RosterChild,
    SessionLocal,
    Student,
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
            "name": unique_name("term_period"),
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
            "name": unique_name("target_term_period"),
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


def test_active_term_student_snapshot_tracks_final_roster_and_closed_freezes():
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
            current_term = db.query(AcademicTerm).filter(
                AcademicTerm.status.in_(("imported", "active"))
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
            active = db.query(ClassRosterMember).filter(
                ClassRosterMember.roster_child_id == member["roster_child_id"],
                ClassRosterMember.ended_at.is_(None),
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
            ended = db.query(ClassRosterMember).filter(
                ClassRosterMember.roster_child_id == member["roster_child_id"],
            ).order_by(ClassRosterMember.id.desc()).first()
            classroom = db.get(Classroom, ended.classroom_id)
            assert classroom.classroom_id == classroom_b_id
            assert snapshot.source_membership_id == transferred_member["id"]

            current_term = db.get(AcademicTerm, term_id)
            current_term.status = "closed"
            db.commit()
            snapshot.student_name_snapshot = "不可改寫"
            with pytest.raises(IntegrityError):
                db.commit()
            db.rollback()
        finally:
            db.rollback()
            restored_term = db.get(AcademicTerm, term_id)
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

        db = SessionLocal()
        try:
            db.get(Campus, campus_id).is_active = True
            db.get(Classroom, classroom_id).is_active = False
            db.commit()
        finally:
            db.close()
        inactive_classroom_response = client.post(
            "/api/organization/term-reclassification-plans",
            json={"label": "異常班級不可建草稿"},
        )
        assert_status(inactive_classroom_response, 409)
        assert inactive_classroom_response.json()["detail"]["code"] == (
            "inactive_organization_has_active_roster_or_teachers"
        )

        db = SessionLocal()
        try:
            db.get(Classroom, classroom_id).is_active = True
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
                for student in db.query(Student)
                .filter(Student.project_id == old_project["id"])
                .order_by(Student.id)
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
        update_body = _plan_update_body(
            plan,
            expected_revision=1,
            placement_overrides={
                placement_by_name["編班李小華"]["source_member_id"]: {
                    "outcome": "classroom",
                    "target_classroom_id": classroom_b_id,
                },
                placement_by_name["編班陳小安"]["source_member_id"]: {
                    "outcome": "departed",
                    "target_classroom_id": None,
                },
            },
            teacher_overrides={
                classroom_a_id: [
                    {"teacher_id": teacher_b["id"], "duty": "lead"}
                ],
                classroom_b_id: [
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
        assert classroom_counts[classroom_a_id] == {
            "classroom_id": classroom_a_id,
            "before": 2,
            "after": 1,
            "change": -1,
        }
        assert classroom_counts[classroom_b_id] == {
            "classroom_id": classroom_b_id,
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
                for row in db.query(ClassRosterMember)
                .filter(
                    ClassRosterMember.classroom_id.in_([
                        classroom_a_id,
                        classroom_b_id,
                    ]),
                    ClassRosterMember.ended_at.is_(None),
                )
                .all()
            }
            active_assignment_ids_before = {
                row.id
                for row in db.query(ClassroomTeacherAssignment)
                .filter(ClassroomTeacherAssignment.ended_at.is_(None))
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
            if row["classroom_id"] in {classroom_a_id, classroom_b_id}
        } == {
            classroom_a_id: classroom_counts[classroom_a_id],
            classroom_b_id: classroom_counts[classroom_b_id],
        }
        applied_at = datetime.fromisoformat(applied_plan["applied_at"])

        db = SessionLocal()
        try:
            active_members = (
                db.query(ClassRosterMember)
                .join(RosterChild, RosterChild.id == ClassRosterMember.roster_child_id)
                .filter(
                    ClassRosterMember.classroom_id.in_([
                        classroom_a_id,
                        classroom_b_id,
                    ]),
                    ClassRosterMember.ended_at.is_(None),
                )
                .all()
            )
            active_student_locations = {
                member.roster_child.name: member.classroom_id
                for member in active_members
            }
            assert active_student_locations == {
                "編班王小明": classroom_a_id,
                "編班李小華": classroom_b_id,
            }
            target_term_id = applied_plan["target_academic_term_id"]
            target_members = (
                db.query(ClassRosterMember)
                .join(Classroom, Classroom.id == ClassRosterMember.classroom_id)
                .filter(
                    Classroom.academic_term_id == target_term_id,
                    ClassRosterMember.ended_at.is_(None),
                )
                .all()
            )
            assert {
                member.roster_child.name: member.classroom.name
                for member in target_members
            } == {
                "編班王小明": classroom_a_id,
                "編班李小華": classroom_b_id,
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
                    Classroom.academic_term_id == target_term_id
                )
                .count()
            ) == 0
            moved_old = db.get(
                ClassRosterMember,
                placement_by_name["編班李小華"]["source_member_id"],
            )
            departed_old = db.get(
                ClassRosterMember,
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

            active_assignments = db.query(ClassroomTeacherAssignment).filter(
                ClassroomTeacherAssignment.ended_at.is_(None)
            ).all()
            active_teacher_state = {
                (assignment.classroom_id, assignment.teacher_id): assignment
                for assignment in active_assignments
            }
            assert active_teacher_state[(classroom_a_id, teacher_b["id"])].duty == "lead"
            assert active_teacher_state[(classroom_b_id, teacher_c["id"])].id == unchanged_b_lead_id
            assert active_teacher_state[(classroom_b_id, teacher_a["id"])].duty == "co_teacher"
            changed_assignments = [
                assignment
                for assignment in db.query(ClassroomTeacherAssignment).all()
                if assignment.ended_at == applied_at or assignment.started_at == applied_at
            ]
            assert changed_assignments
            assert all(
                assignment.ended_at in {None, applied_at}
                and assignment.started_at <= applied_at
                for assignment in changed_assignments
            )
            project_count_before_retry = db.query(Project).count()
            membership_count_before_retry = db.query(ClassRosterMember).count()
            assignment_count_before_retry = db.query(ClassroomTeacherAssignment).count()
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
                for student in db.query(Student)
                .filter(Student.project_id == old_project["id"])
                .order_by(Student.id)
            ]
        finally:
            db.close()

        old_detail = client.get(f"/api/projects/{old_project['id']}")
        assert_status(old_detail, 200)
        assert _stable_project_snapshot(old_detail.json()) == old_project_snapshot

        target_template_id = plan["target_template_id"]
        future_a = _create_classroom_project(
            client,
            classroom_a_id,
            target_template_id,
        )
        future_b = _create_classroom_project(
            client,
            classroom_b_id,
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
            assert db.query(ClassRosterMember).count() == membership_count_before_retry
            assert (
                db.query(ClassroomTeacherAssignment).count()
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
                for row in db.query(ClassRosterMember).order_by(ClassRosterMember.id)
            ]
            assignments_before = [
                (row.id, row.classroom_id, row.teacher_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomTeacherAssignment).order_by(
                    ClassroomTeacherAssignment.id
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
                for row in db.query(ClassRosterMember).order_by(ClassRosterMember.id)
            ]
            assert assignments_before == [
                (row.id, row.classroom_id, row.teacher_id, row.ended_at, row.end_reason)
                for row in db.query(ClassroomTeacherAssignment).order_by(
                    ClassroomTeacherAssignment.id
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
        invalid_update_body = _plan_update_body(
            plan,
            expected_revision=99,
            teacher_overrides={
                classroom_id: [
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
                for row in db.query(ClassroomTeacherAssignment)
                .filter(ClassroomTeacherAssignment.ended_at.is_(None))
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
                for row in db.query(ClassroomTeacherAssignment)
                .filter(ClassroomTeacherAssignment.ended_at.is_(None))
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
