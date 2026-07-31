from contextlib import contextmanager
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session as OrmSession

from database import (
    SemesterPeriod,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacher,
    OrganizationSupervisorAssignment,
    Project,
    ProjectAssignmentHistory,
    ProjectEditorAssignment,
    SessionLocal,
    Student,
    Template,
    User,
    utc_now,
)
from services import user_service
from services.organization_service import _ensure_current_term_classroom_grid
from services.project_access_service import assert_project_content_writable
from tests.helpers import (
    current_semester_id,
    USER_PASSWORD,
    assert_status,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _seed_project(
    db,
    *,
    template_id: int,
    owner_id: int,
    creator_id: int,
    creator_name: str,
    name: str,
    classroom: Classroom | None,
    with_student: bool = False,
) -> int:
    template = db.get(Template, template_id)
    assert template is not None
    work_slot = None
    if classroom is not None:
        classroom = _ensure_current_term_classroom_grid(db, classroom)
        db.flush()
        assert classroom is not None
        work_slot = (
            db.query(ClassPeriodWorkSlot)
            .join(
                SemesterPeriod,
                SemesterPeriod.id == ClassPeriodWorkSlot.semester_period_id,
            )
            .filter(
                ClassPeriodWorkSlot.classroom_id == classroom.id,
                SemesterPeriod.template_period_id == template.period_id,
            )
            .one()
        )
        work_slot.started_at = work_slot.started_at or utc_now()
    project = Project(
        name=name,
        template_id=template.id,
        template_period_id=template.period_id,
        template_revision=template.revision,
        owner_id=owner_id,
        classroom_id=classroom.id if classroom is not None else None,
        class_period_work_slot_id=work_slot.id if work_slot is not None else None,
        created_by_id=creator_id,
        created_by_name=creator_name,
        campus_id_snapshot=classroom.campus_id if classroom is not None else None,
        campus_name_snapshot=classroom.campus.name if classroom is not None else None,
        classroom_name_snapshot=classroom.name if classroom is not None else None,
        department=classroom.department if classroom is not None else None,
    )
    db.add(project)
    db.flush()
    if with_student:
        db.add(Student(
            project_id=project.id,
            name=unique_name("ACL學生"),
            order_index=0,
            pages_data_json="[]",
        ))
    return int(project.id)


def _listed_project_ids(client) -> set[int]:
    response = client.get("/api/projects/")
    assert_status(response, 200)
    return {item["id"] for item in response.json()}


def test_archived_project_content_guard_rejects_writes_even_for_admin():
    with started_client() as client:
        admin = login(client)
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            project = Project(
                name=unique_name("archived_content_guard"),
                template_id=template_id,
                template_revision=1,
                deleted_at=utc_now(),
            )
            db.add(project)
            db.commit()
            current_admin = db.get(User, admin["user_id"])

            with pytest.raises(HTTPException) as blocked:
                assert_project_content_writable(project, current_admin, db)

            assert blocked.value.status_code == 404
        finally:
            db.close()


def test_archive_list_does_not_purge_expired_projects_outside_user_scope():
    with started_client() as client:
        admin = login(client)
        teacher, teacher_password = create_user(client, "teacher")
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=admin["user_id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("scope外到期封存相本"),
                classroom=None,
            )
            project = db.get(Project, project_id)
            expired_at = utc_now() - timedelta(minutes=1)
            project.deleted_at = expired_at - timedelta(days=30)
            project.archive_expires_at = expired_at
            db.commit()
        finally:
            db.close()

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        archived_projects = client.get("/api/projects/archive")
        assert_status(archived_projects, 200)
        assert archived_projects.json() == []

        db = SessionLocal()
        try:
            assert db.get(Project, project_id) is not None
        finally:
            db.close()


def test_project_acl_uses_classroom_staffing_and_organization_scope_only():
    with started_client() as client:
        admin = login(client)
        department_supervisor, department_supervisor_password = create_user(
            client, "supervisor"
        )
        campus_supervisor, campus_supervisor_password = create_user(
            client, "supervisor"
        )
        legacy_supervisor, legacy_supervisor_password = create_user(
            client, "supervisor"
        )
        assigned_teacher, assigned_teacher_password = create_user(client, "teacher")
        owner_without_assignment, owner_password = create_user(client, "teacher")
        legacy_editor, legacy_editor_password = create_user(client, "teacher")
        art_team, art_team_password = create_user(client, "art_team")
        template_id, _ = create_template_with_page(client)
        academy_period_response = client.post(
            "/api/templates/periods",
            data={
                "name": unique_name("academy_period"),
                "department": "academy",
                "status": "active",
            },
        )
        assert_status(academy_period_response, 200)
        academy_template_id, _ = create_template_with_page(
            client,
            period_id=academy_period_response.json()["id"],
        )

        db = SessionLocal()
        try:
            campus_a = Campus(name=unique_name("A分校"))
            campus_b = Campus(name=unique_name("B分校"))
            db.add_all([campus_a, campus_b])
            db.flush()
            infant_a = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus_a.id,
                department="infant",
                name=unique_name("A幼幼班"),
            )
            academy_a = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus_a.id,
                department="academy",
                name=unique_name("A幼兒班"),
            )
            infant_b = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus_b.id,
                department="infant",
                name=unique_name("B幼幼班"),
            )
            db.add_all([infant_a, academy_a, infant_b])
            db.flush()
            db.add(ClassroomTeacher(
                classroom_id=infant_a.id,
                teacher_id=assigned_teacher["id"],
                teacher_name_snapshot=assigned_teacher["display_name"],
                duty="lead",
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            ))
            db.add_all([
                OrganizationSupervisorAssignment(
                    campus_id=campus_a.id,
                    department="infant",
                    supervisor_id=department_supervisor["id"],
                    supervisor_name_snapshot=department_supervisor["display_name"],
                    started_by_id=admin["user_id"],
                    started_by_name_snapshot=admin["display_name"],
                ),
                OrganizationSupervisorAssignment(
                    campus_id=campus_a.id,
                    department=None,
                    supervisor_id=campus_supervisor["id"],
                    supervisor_name_snapshot=campus_supervisor["display_name"],
                    started_by_id=admin["user_id"],
                    started_by_name_snapshot=admin["display_name"],
                ),
            ])
            infant_a_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=owner_without_assignment["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("A幼幼班相本"),
                classroom=infant_a,
                with_student=True,
            )
            academy_a_project_id = _seed_project(
                db,
                template_id=academy_template_id,
                owner_id=owner_without_assignment["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("A幼兒班相本"),
                classroom=academy_a,
            )
            infant_b_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=owner_without_assignment["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("B幼幼班相本"),
                classroom=infant_b,
            )
            unassigned_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=owner_without_assignment["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("未歸班舊相本"),
                classroom=None,
            )
            db.add(ProjectEditorAssignment(
                project_id=infant_a_project_id,
                user_id=legacy_editor["id"],
                user_name_snapshot=legacy_editor["display_name"],
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            ))
            db.commit()
        finally:
            db.close()

        client.cookies.clear()
        login(client, assigned_teacher["username"], assigned_teacher_password)
        assert _listed_project_ids(client) == {infant_a_project_id}
        assigned_detail = client.get(f"/api/projects/{infant_a_project_id}")
        assert_status(assigned_detail, 200)
        assert assigned_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": True,
            "can_reopen": False,
            "can_comment": False,
        }
        assert "editors" not in assigned_detail.json()
        assert_status(client.get(f"/api/projects/{academy_a_project_id}"), 403)
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 403)
        assert_status(client.post(f"/api/projects/{infant_a_project_id}/complete"), 200)
        # 改名不受完成狀態限制（名稱只進輸出檔名），且不解除完成狀態
        renamed_name = unique_name("完成後仍可改名")
        allowed_rename = client.patch(
            f"/api/projects/{infant_a_project_id}",
            data={"name": renamed_name},
        )
        assert_status(allowed_rename, 200)
        renamed_detail = client.get(f"/api/projects/{infant_a_project_id}")
        assert_status(renamed_detail, 200)
        assert renamed_detail.json()["name"] == renamed_name
        assert renamed_detail.json()["completed_at"] is not None

        client.cookies.clear()
        login(client, owner_without_assignment["username"], owner_password)
        assert _listed_project_ids(client) == set()
        assert_status(client.get(f"/api/projects/{infant_a_project_id}"), 403)
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 403)

        client.cookies.clear()
        login(client, legacy_editor["username"], legacy_editor_password)
        assert _listed_project_ids(client) == set()
        assert_status(client.get(f"/api/projects/{infant_a_project_id}"), 403)

        client.cookies.clear()
        login(
            client,
            department_supervisor["username"],
            department_supervisor_password,
        )
        assert _listed_project_ids(client) == {infant_a_project_id}
        supervisor_detail = client.get(f"/api/projects/{infant_a_project_id}")
        assert_status(supervisor_detail, 200)
        assert supervisor_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": False,
            "can_reopen": True,
            "can_comment": True,
        }
        assert_status(client.get(f"/api/projects/{academy_a_project_id}"), 403)
        assert_status(client.get(f"/api/projects/{infant_b_project_id}"), 403)
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 403)
        assert_status(client.post(f"/api/projects/{infant_a_project_id}/reopen"), 200)

        client.cookies.clear()
        login(client, campus_supervisor["username"], campus_supervisor_password)
        assert _listed_project_ids(client) == {
            infant_a_project_id,
            academy_a_project_id,
        }
        assert_status(client.get(f"/api/projects/{infant_b_project_id}"), 403)

        client.cookies.clear()
        login(client, legacy_supervisor["username"], legacy_supervisor_password)
        assert _listed_project_ids(client) == set()
        assert_status(client.get(f"/api/projects/{infant_a_project_id}"), 403)
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 403)

        client.cookies.clear()
        login(client, art_team["username"], art_team_password)
        art_project_ids = _listed_project_ids(client)
        assert {
            infant_a_project_id,
            academy_a_project_id,
            infant_b_project_id,
        } <= art_project_ids
        assert unassigned_project_id not in art_project_ids
        art_detail = client.get(f"/api/projects/{infant_a_project_id}")
        assert_status(art_detail, 200)
        assert art_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": False,
            "can_reopen": False,
            "can_comment": True,
        }
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 403)

        client.cookies.clear()
        login(client)
        assert {
            infant_a_project_id,
            academy_a_project_id,
            infant_b_project_id,
            unassigned_project_id,
        }.issubset(_listed_project_ids(client))
        assert_status(client.get(f"/api/projects/{unassigned_project_id}"), 200)
        generic_create = client.post(
            "/api/projects/",
            data={"name": "不得再建未歸班相本", "template_id": template_id},
        )
        assert_status(generic_create, 405)

        invalid_owner_transfer = client.post(
            f"/api/projects/{infant_a_project_id}/assignment",
            json={"owner_id": legacy_editor["id"], "reason": "非目前老師"},
        )
        assert_status(invalid_owner_transfer, 422)
        valid_owner_transfer = client.post(
            f"/api/projects/{infant_a_project_id}/assignment",
            json={"owner_id": assigned_teacher["id"], "reason": "進度歸戶"},
        )
        assert_status(valid_owner_transfer, 200)
        unassigned_owner_transfer = client.post(
            f"/api/projects/{unassigned_project_id}/assignment",
            json={"owner_id": assigned_teacher["id"], "reason": "不得繞過歸班"},
        )
        assert_status(unassigned_owner_transfer, 409)

        editor_role_change = client.patch(
            f"/api/users/{legacy_editor['id']}",
            json={"role": "art_team"},
        )
        assert_status(editor_role_change, 200)


def test_former_teacher_keeps_read_on_past_classroom_but_loses_write():
    """調班後仍讀得到自己帶過班級的相本，但製作權只跟著目前編制走。"""
    with started_client() as client:
        admin = login(client)
        moving_teacher, moving_teacher_password = create_user(client, "teacher")
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            campus = Campus(name=unique_name("升階分校"))
            db.add(campus)
            db.flush()
            previous_classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus.id,
                department="infant",
                name=unique_name("八階A"),
            )
            next_classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus.id,
                department="infant",
                name=unique_name("九階A"),
            )
            db.add_all([previous_classroom, next_classroom])
            db.flush()
            previous_assignment = ClassroomTeacher(
                classroom_id=previous_classroom.id,
                teacher_id=moving_teacher["id"],
                teacher_name_snapshot=moving_teacher["display_name"],
                duty="lead",
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            )
            db.add(previous_assignment)
            previous_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=moving_teacher["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("八階A相本"),
                classroom=previous_classroom,
                with_student=True,
            )
            next_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=admin["user_id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("九階A相本"),
                classroom=next_classroom,
            )
            db.commit()
            previous_assignment_id = previous_assignment.id
            next_classroom_id = next_classroom.id
        finally:
            db.close()

        client.cookies.clear()
        login(client, moving_teacher["username"], moving_teacher_password)
        assert _listed_project_ids(client) == {previous_project_id}
        assert client.get(
            f"/api/projects/{previous_project_id}"
        ).json()["permissions"]["can_edit"] is True

        # 學期轉換：結束舊班編制，改編到新班
        db = SessionLocal()
        try:
            db.get(ClassroomTeacher, previous_assignment_id).ended_at = (
                utc_now()
            )
            db.add(ClassroomTeacher(
                classroom_id=next_classroom_id,
                teacher_id=moving_teacher["id"],
                teacher_name_snapshot=moving_teacher["display_name"],
                duty="lead",
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            ))
            db.commit()
        finally:
            db.close()

        assert _listed_project_ids(client) == {previous_project_id, next_project_id}
        previous_permissions = client.get(
            f"/api/projects/{previous_project_id}"
        ).json()["permissions"]
        assert previous_permissions["can_read"] is True
        assert previous_permissions["can_edit"] is False
        next_permissions = client.get(
            f"/api/projects/{next_project_id}"
        ).json()["permissions"]
        assert next_permissions["can_read"] is True
        assert next_permissions["can_edit"] is True

        # 舊班相本只剩唯讀：內容寫入必須被擋
        rename_previous = client.patch(
            f"/api/projects/{previous_project_id}",
            data={"name": "舊班不得再改名"},
        )
        assert_status(rename_previous, 403)

        # 「我的班級」仍只列目前編制，不因為讀得到舊相本而回頭長出舊班
        my_classrooms = client.get("/api/organization/my-classrooms")
        assert_status(my_classrooms, 200)
        assert [
            item["id"] for item in my_classrooms.json()["classrooms"]
        ] == [next_classroom_id]


def test_operational_user_combines_teacher_and_supervisor_assignment_permissions():
    with started_client() as client:
        admin = login(client)
        dual_teacher, dual_teacher_password = create_user(client, "teacher")
        supervisor_teacher, supervisor_teacher_password = create_user(
            client, "supervisor"
        )
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            template = db.get(Template, template_id)
            assert template is not None
            assert template.period is not None
            assert template.period.status == "active"
            department = template.period.department
            teaching_campus = Campus(name=unique_name("雙身分任教分校"))
            supervising_campus = Campus(name=unique_name("雙身分主管分校"))
            supervisor_teacher_campus = Campus(name=unique_name("主管任教分校"))
            db.add_all([
                teaching_campus,
                supervising_campus,
                supervisor_teacher_campus,
            ])
            db.flush()
            teaching_classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=teaching_campus.id,
                department=department,
                name=unique_name("雙身分任教班"),
            )
            supervised_classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=supervising_campus.id,
                department=department,
                name=unique_name("雙身分主管班"),
            )
            supervisor_teacher_classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=supervisor_teacher_campus.id,
                department=department,
                name=unique_name("主管任教班"),
            )
            db.add_all([
                teaching_classroom,
                supervised_classroom,
                supervisor_teacher_classroom,
            ])
            db.flush()
            db.add_all([
                ClassroomTeacher(
                    classroom_id=teaching_classroom.id,
                    teacher_id=dual_teacher["id"],
                    teacher_name_snapshot=dual_teacher["display_name"],
                    duty="lead",
                    started_by_id=admin["user_id"],
                    started_by_name_snapshot=admin["display_name"],
                ),
                ClassroomTeacher(
                    classroom_id=supervisor_teacher_classroom.id,
                    teacher_id=supervisor_teacher["id"],
                    teacher_name_snapshot=supervisor_teacher["display_name"],
                    duty="lead",
                    started_by_id=admin["user_id"],
                    started_by_name_snapshot=admin["display_name"],
                ),
                OrganizationSupervisorAssignment(
                    campus_id=supervising_campus.id,
                    department=None,
                    supervisor_id=dual_teacher["id"],
                    supervisor_name_snapshot=dual_teacher["display_name"],
                    started_by_id=admin["user_id"],
                    started_by_name_snapshot=admin["display_name"],
                ),
            ])
            teaching_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=dual_teacher["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("雙身分任教相本"),
                classroom=teaching_classroom,
            )
            supervised_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=admin["user_id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("雙身分主管相本"),
                classroom=supervised_classroom,
            )
            supervisor_teacher_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=supervisor_teacher["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("主管任教相本"),
                classroom=supervisor_teacher_classroom,
            )
            db.get(Project, supervised_project_id).completed_at = utc_now()
            supervisor_teacher_work_slot_id = db.get(
                Project,
                supervisor_teacher_project_id,
            ).class_period_work_slot_id
            semester_period_id = db.get(
                ClassPeriodWorkSlot,
                supervisor_teacher_work_slot_id,
            ).semester_period_id
            semester_id = db.get(
                SemesterPeriod,
                semester_period_id,
            ).semester_id
            db.commit()
            supervisor_teacher_classroom_id = supervisor_teacher_classroom.id
        finally:
            db.close()

        client.cookies.clear()
        login(client, dual_teacher["username"], dual_teacher_password)
        assert _listed_project_ids(client) == {
            teaching_project_id,
            supervised_project_id,
        }
        teaching_detail = client.get(f"/api/projects/{teaching_project_id}")
        assert_status(teaching_detail, 200)
        assert teaching_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": True,
            "can_reopen": False,
            "can_comment": False,
        }
        supervised_detail = client.get(f"/api/projects/{supervised_project_id}")
        assert_status(supervised_detail, 200)
        assert supervised_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": False,
            "can_reopen": True,
            "can_comment": True,
        }
        supervised_comment = client.post(
            f"/api/projects/{supervised_project_id}/comments",
            data={"content": "老師帳號以主管 scope 審閱"},
        )
        assert_status(supervised_comment, 201)
        teaching_comment = client.post(
            f"/api/projects/{teaching_project_id}/comments",
            data={"content": "純任教不可新增審閱"},
        )
        assert_status(teaching_comment, 403)
        assert_status(client.post(f"/api/projects/{supervised_project_id}/reopen"), 200)
        classrooms = client.get("/api/organization/my-classrooms")
        assert_status(classrooms, 200)
        assert classrooms.json()["permissions"] == {
            "can_view_supervisor_reports": True,
        }
        progress = client.get(
            "/api/roster/teacher-progress",
            params={"semester_id": semester_id},
        )
        assert_status(progress, 200)
        identity = client.get("/api/auth/me")
        assert_status(identity, 200)
        assert identity.json()["role"] == "teacher"

        client.cookies.clear()
        login(
            client,
            supervisor_teacher["username"],
            supervisor_teacher_password,
        )
        assert _listed_project_ids(client) == {supervisor_teacher_project_id}
        project_detail = client.get(
            f"/api/projects/{supervisor_teacher_project_id}"
        )
        assert_status(project_detail, 200)
        assert project_detail.json()["permissions"] == {
            "can_read": True,
            "can_edit": True,
            "can_reopen": False,
            "can_comment": False,
        }
        teacher_only_comment = client.post(
            f"/api/projects/{supervisor_teacher_project_id}/comments",
            data={"content": "主管角色字串不可繞過 scope"},
        )
        assert_status(teacher_only_comment, 403)
        classrooms = client.get("/api/organization/my-classrooms")
        assert_status(classrooms, 200)
        assert classrooms.json()["permissions"] == {
            "can_view_supervisor_reports": False,
        }
        forbidden_progress = client.get(
            "/api/roster/teacher-progress",
            params={"semester_id": semester_id},
        )
        assert_status(forbidden_progress, 403)
        created = client.post(
            f"/api/organization/classrooms/{supervisor_teacher_classroom_id}/projects",
            json={
                "name": unique_name("主管主教建立相本"),
                "template_id": template_id,
                "work_slot_id": supervisor_teacher_work_slot_id,
                "owner_id": supervisor_teacher["id"],
            },
        )
        assert_status(created, 409)
        identity = client.get("/api/auth/me")
        assert_status(identity, 200)
        assert identity.json()["role"] == "supervisor"


def test_role_none_is_atomic_emergency_disable_and_invalidates_old_cookie(
    monkeypatch,
):
    with started_client() as client:
        admin = login(client)
        teacher, teacher_password = create_user(client, "teacher")
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            campus = Campus(name=unique_name("停權分校"))
            db.add(campus)
            db.flush()
            classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus.id,
                department="infant",
                name=unique_name("停權班級"),
            )
            db.add(classroom)
            db.flush()
            db.add(ClassroomTeacher(
                classroom_id=classroom.id,
                teacher_id=teacher["id"],
                teacher_name_snapshot=teacher["display_name"],
                duty="lead",
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            ))
            owned_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=teacher["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("停權負責相本"),
                classroom=classroom,
            )
            editor_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=admin["user_id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("停權歷史協作者相本"),
                classroom=classroom,
            )
            db.add(ProjectEditorAssignment(
                project_id=editor_project_id,
                user_id=teacher["id"],
                user_name_snapshot=teacher["display_name"],
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            ))
            db.commit()
        finally:
            db.close()

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        old_cookie = client.cookies.get("access_token")

        client.cookies.clear()
        login(client)
        blocked_role_change = client.patch(
            f"/api/users/{teacher['id']}", json={"role": "art_team"}
        )
        assert_status(blocked_role_change, 409)
        original_commit = OrmSession.commit
        original_execute = OrmSession.execute
        real_project_locks = user_service.lock_project_content_writes
        transaction_events = []

        def recording_commit(session) -> None:
            transaction_events.append("commit")
            original_commit(session)

        def recording_execute(session, statement, *args, **kwargs):
            if str(statement).strip().upper() == "BEGIN IMMEDIATE":
                transaction_events.append("begin_immediate")
            return original_execute(session, statement, *args, **kwargs)

        @contextmanager
        def recording_project_locks(project_ids):
            transaction_events.append("project_locks_enter")
            with real_project_locks(project_ids):
                yield
            transaction_events.append("project_locks_exit")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", recording_commit)
            request_patch.setattr(OrmSession, "execute", recording_execute)
            request_patch.setattr(
                user_service,
                "lock_project_content_writes",
                recording_project_locks,
            )
            disabled = client.patch(
                f"/api/users/{teacher['id']}", json={"role": "none"}
            )
        assert_status(disabled, 200)
        assert disabled.json()["role"] == "none"
        assert transaction_events == [
            "project_locks_enter",
            "begin_immediate",
            "commit",
            "project_locks_exit",
        ]

        client.cookies.clear()
        client.cookies.set("access_token", old_cookie)
        assert_status(client.get("/api/auth/me"), 401)

    db = SessionLocal()
    try:
        disabled_user = db.get(User, teacher["id"])
        assert disabled_user is not None
        assert disabled_user.role == "none"
        assert disabled_user.auth_version == 1
        classroom_assignment = db.query(ClassroomTeacher).filter(
            ClassroomTeacher.teacher_id == teacher["id"]
        ).one()
        assert classroom_assignment.ended_at is not None
        assert classroom_assignment.end_reason == "role_none"
        editor_assignment = db.query(ProjectEditorAssignment).filter(
            ProjectEditorAssignment.project_id == editor_project_id,
            ProjectEditorAssignment.user_id == teacher["id"],
        ).one()
        assert editor_assignment.ended_at is None
        assert editor_assignment.end_reason is None
        assert db.get(Project, owned_project_id).owner_id == admin["user_id"]
        disable_history = db.query(ProjectAssignmentHistory).filter(
            ProjectAssignmentHistory.project_id == owned_project_id
        ).order_by(ProjectAssignmentHistory.id.desc()).first()
        assert disable_history is not None
        assert disable_history.from_owner_name == teacher["display_name"]
        assert disable_history.to_owner_id == admin["user_id"]
    finally:
        db.close()


def test_supervisor_scope_blocks_normal_demotion_and_lifecycle_preserves_history():
    with started_client() as client:
        admin = login(client)
        disabled_supervisor, _ = create_user(client, "supervisor")
        deleted_supervisor, _ = create_user(client, "supervisor")

        db = SessionLocal()
        try:
            campus = Campus(name=unique_name("主管生命週期分校"))
            db.add(campus)
            db.flush()
            disabled_scope = OrganizationSupervisorAssignment(
                campus_id=campus.id,
                department=None,
                supervisor_id=disabled_supervisor["id"],
                supervisor_name_snapshot=disabled_supervisor["display_name"],
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            )
            deleted_scope = OrganizationSupervisorAssignment(
                campus_id=campus.id,
                department="infant",
                supervisor_id=deleted_supervisor["id"],
                supervisor_name_snapshot=deleted_supervisor["display_name"],
                started_by_id=admin["user_id"],
                started_by_name_snapshot=admin["display_name"],
            )
            db.add_all([disabled_scope, deleted_scope])
            db.commit()
            disabled_scope_id = disabled_scope.id
            deleted_scope_id = deleted_scope.id
        finally:
            db.close()

        blocked = client.patch(
            f"/api/users/{disabled_supervisor['id']}",
            json={"role": "art_team"},
        )
        assert_status(blocked, 409)
        assert blocked.json()["detail"] == "請先解除目前園所主管範圍"

        db = SessionLocal()
        try:
            assert db.get(OrganizationSupervisorAssignment, disabled_scope_id).ended_at is None
        finally:
            db.close()

        disabled = client.patch(
            f"/api/users/{disabled_supervisor['id']}",
            json={"role": "none"},
        )
        assert_status(disabled, 200)
        assert disabled.json()["role"] == "none"

        deleted = client.delete(f"/api/users/{deleted_supervisor['id']}")
        assert_status(deleted, 200)

    db = SessionLocal()
    try:
        disabled_scope = db.get(OrganizationSupervisorAssignment, disabled_scope_id)
        assert disabled_scope is not None
        assert disabled_scope.supervisor_id == disabled_supervisor["id"]
        assert disabled_scope.supervisor_name_snapshot == disabled_supervisor["display_name"]
        assert disabled_scope.ended_at is not None
        assert disabled_scope.end_reason == "role_none"
        assert disabled_scope.ended_by_id == admin["user_id"]
        assert disabled_scope.ended_by_name_snapshot == admin["display_name"]

        deleted_scope = db.get(OrganizationSupervisorAssignment, deleted_scope_id)
        assert deleted_scope is not None
        assert deleted_scope.supervisor_id is None
        assert deleted_scope.supervisor_name_snapshot == deleted_supervisor["display_name"]
        assert deleted_scope.ended_at is not None
        assert deleted_scope.end_reason == "user_deleted"
        assert deleted_scope.ended_by_id == admin["user_id"]
        assert deleted_scope.ended_by_name_snapshot == admin["display_name"]
        assert db.get(User, deleted_supervisor["id"]) is None
    finally:
        db.close()


def test_user_api_rejects_and_omits_legacy_supervisor_fields():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, _ = create_user(client, "teacher")
        assert "supervisor_id" not in teacher
        assert "supervisor_ids" not in teacher
        assert "supervisor_name" not in teacher
        assert "supervisor_names" not in teacher

        rejected_create = client.post(
            "/api/users/",
            json={
                "username": unique_name("legacy_supervisor_create"),
                "display_name": "不再接受逐人主管",
                "password": USER_PASSWORD,
                "role": "teacher",
                "supervisor_ids": [supervisor["id"]],
            },
        )
        assert_status(rejected_create, 422)

        rejected_update = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_id": supervisor["id"]},
        )
        assert_status(rejected_update, 422)

        client.cookies.clear()
        login(client, teacher["username"], USER_PASSWORD)
        identity = client.get("/api/auth/me")
        assert_status(identity, 200)
        assert "supervisor_id" not in identity.json()
        assert "supervisor_ids" not in identity.json()


def test_role_none_commit_failure_rolls_back_owner_transfer(monkeypatch):
    with started_client() as client:
        admin = login(client)
        teacher, _ = create_user(client, "teacher")
        template_id, _ = create_template_with_page(client)

        db = SessionLocal()
        try:
            template = db.get(Template, template_id)
            assert template is not None and template.period is not None
            campus = Campus(name=unique_name("停權回滾分校"))
            db.add(campus)
            db.flush()
            classroom = Classroom(
                semester_id=current_semester_id(db),
                campus_id=campus.id,
                department=template.period.department,
                name=unique_name("停權回滾班級"),
            )
            db.add(classroom)
            db.flush()
            owned_project_id = _seed_project(
                db,
                template_id=template_id,
                owner_id=teacher["id"],
                creator_id=admin["user_id"],
                creator_name=admin["display_name"],
                name=unique_name("停權回滾負責相本"),
                classroom=classroom,
            )
            db.commit()
        finally:
            db.close()

        def fail_commit(_session) -> None:
            raise RuntimeError("simulated role disable commit failure")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="role disable commit failure"):
                client.patch(
                    f"/api/users/{teacher['id']}", json={"role": "none"}
                )

    db = SessionLocal()
    try:
        target_user = db.get(User, teacher["id"])
        assert target_user is not None
        assert target_user.role == "teacher"
        assert target_user.auth_version == 0
        assert db.get(Project, owned_project_id).owner_id == teacher["id"]
        assert db.query(ProjectAssignmentHistory).filter(
            ProjectAssignmentHistory.project_id == owned_project_id
        ).count() == 0
    finally:
        db.close()
