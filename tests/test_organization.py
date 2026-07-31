"""園所班級名單、每期相本快照與負責人稽核契約。"""

from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text

from database import (
    AcademicTerm,
    Classroom,
    Campus,
    Classroom,
    ClassroomTeacherAssignment,
    ClassRosterMember,
    Project,
    RosterChild,
    SessionLocal,
    Student,
    User,
)
from services import organization_service
from tests.helpers import (
    USER_PASSWORD,
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
            "name": unique_name("org_period"),
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


def _create_campus_and_classroom(
    client,
    *,
    campus_id: int | None = None,
    department: str = "infant",
) -> tuple[int, int]:
    if campus_id is None:
        campus_response = client.post(
            "/api/organization/campuses",
            json={"name": unique_name("campus")},
        )
        assert_status(campus_response, 201)
        campus_id = campus_response.json()["id"]
    classroom_response = client.post(
        "/api/organization/classrooms",
        json={
            "campus_id": campus_id,
            "department": department,
            "name": unique_name("classroom"),
        },
    )
    assert_status(classroom_response, 201)
    return campus_id, classroom_response.json()["id"]


def _add_members(client, classroom_id: int, names: list[str]) -> list[dict]:
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/members/batch",
        json={"members": [{"name": name} for name in names]},
    )
    assert_status(response, 201)
    return response.json()["created"]


def _create_teacher(client) -> dict:
    teacher, _ = create_user(client, "teacher")
    return teacher


def _replace_teachers(client, classroom_id: int, teachers: list[dict]) -> dict:
    response = client.put(
        f"/api/organization/classrooms/{classroom_id}/teachers",
        json={"teachers": teachers},
    )
    assert_status(response, 200)
    return response.json()


def _create_classroom_project(
    client,
    classroom_id: int,
    template_id: int,
    owner_id: int,
) -> dict:
    overview_response = client.get("/api/organization/overview")
    if overview_response.status_code == 200:
        work_slots = overview_response.json()["work_slots"]
    else:
        assert_status(overview_response, 403)
        classrooms_response = client.get("/api/organization/my-classrooms")
        assert_status(classrooms_response, 200)
        work_slots = [
            work_slot
            for classroom in classrooms_response.json()["classrooms"]
            for work_slot in classroom["work_slots"]
        ]
    work_slot_id = next(
        work_slot["id"]
        for work_slot in work_slots
        if work_slot["classroom_id"] == classroom_id
        and template_id in work_slot["template_ids"]
        and work_slot["can_create_project"]
    )
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json={
            "name": unique_name("class_album"),
            "template_id": template_id,
            "work_slot_id": work_slot_id,
            "owner_id": owner_id,
        },
    )
    assert_status(response, 201)
    return response.json()


def test_current_term_project_keeps_term_classroom_scope_after_classroom_move():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client, "infant")
        source_campus_id, classroom_id = _create_campus_and_classroom(
            client,
            department="infant",
        )
        overview = client.get("/api/organization/overview").json()
        source_campus = next(
            campus for campus in overview["campuses"]
            if campus["id"] == source_campus_id
        )
        source_classroom = next(
            classroom for classroom in source_campus["classrooms"]
            if classroom["id"] == classroom_id
        )
        target_campus_response = client.post(
            "/api/organization/campuses",
            json={"name": unique_name("moved-campus")},
        )
        assert_status(target_campus_response, 201)
        target_campus_id = target_campus_response.json()["id"]
        moved_classroom_name = unique_name("moved-classroom")
        update_response = client.patch(
            f"/api/organization/classrooms/{classroom_id}",
            json={
                "campus_id": target_campus_id,
                "department": "academy",
                "name": moved_classroom_name,
            },
        )
        assert_status(update_response, 200)

        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        _add_members(client, classroom_id, ["學期快照學生"])
        project = _create_classroom_project(
            client,
            classroom_id,
            template_id,
            lead_teacher["id"],
        )

        assert project["campus_id"] == source_campus_id
        assert project["campus_name"] == source_campus["name"]
        assert project["classroom_name"] == source_classroom["name"]
        assert project["department"] == "infant"
        assert project["campus_id"] != target_campus_id
        assert project["classroom_name"] != moved_classroom_name


def test_class_roster_changes_only_affect_future_project_snapshots():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        campus_id, classroom_a_id = _create_campus_and_classroom(client)
        _, classroom_b_id = _create_campus_and_classroom(
            client,
            campus_id=campus_id,
        )
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_a_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        _replace_teachers(
            client,
            classroom_b_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )

        first_member = _add_members(client, classroom_a_id, ["王小明"])[0]
        first_project = _create_classroom_project(
            client,
            classroom_a_id,
            template_id,
            lead_teacher["id"],
        )
        assert "editors" not in first_project
        assert [student["name"] for student in first_project["students"]] == ["王小明"]
        assert first_project["students"][0]["album_name"] == "小明"

        newcomer = _add_members(client, classroom_a_id, ["李小華"])[0]
        second_template_id = _create_active_template(client)
        second_project = _create_classroom_project(
            client,
            classroom_a_id,
            second_template_id,
            lead_teacher["id"],
        )
        assert [student["name"] for student in first_project["students"]] == ["王小明"]
        assert [student["name"] for student in second_project["students"]] == [
            "王小明",
            "李小華",
        ]

        end_response = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{first_member['id']}",
            json={"status": "ended", "end_reason": "departed"},
        )
        assert_status(end_response, 200)
        assert end_response.json()["member"]["end_reason"] == "departed"
        departure_template_id = _create_active_template(client)
        after_departure = _create_classroom_project(
            client,
            classroom_a_id,
            departure_template_id,
            lead_teacher["id"],
        )
        assert [student["name"] for student in after_departure["students"]] == ["李小華"]
        first_project_detail = client.get(f"/api/projects/{first_project['id']}")
        assert_status(first_project_detail, 200)
        assert [student["name"] for student in first_project_detail.json()["students"]] == [
            "王小明"
        ]

        transfer_response = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{newcomer['id']}",
            json={"target_classroom_id": classroom_b_id},
        )
        assert_status(transfer_response, 200)
        transfer = transfer_response.json()
        assert transfer["member"]["end_reason"] == "transfer"
        assert transfer["transferred_member"]["classroom_id"] == classroom_b_id
        assert transfer["transferred_member"]["id"] != newcomer["id"]

        future_template_id = _create_active_template(client)
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        future_a_work_slot_id = next(
            work_slot["id"]
            for work_slot in overview.json()["work_slots"]
            if work_slot["classroom_id"] == classroom_a_id
            and future_template_id in work_slot["template_ids"]
            and work_slot["can_create_project"]
        )
        future_a = client.post(
            f"/api/organization/classrooms/{classroom_a_id}/projects",
            json={
                "name": unique_name("empty_class_album"),
                "template_id": future_template_id,
                "work_slot_id": future_a_work_slot_id,
                "owner_id": lead_teacher["id"],
            },
        )
        assert_status(future_a, 409)
        assert future_a.json()["detail"]["code"] == "classroom_roster_empty"
        future_b = _create_classroom_project(
            client,
            classroom_b_id,
            future_template_id,
            lead_teacher["id"],
        )
        assert [student["name"] for student in future_b["students"]] == ["李小華"]
        assert [student["name"] for student in second_project["students"]] == [
            "王小明",
            "李小華",
        ]

        restore_response = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{first_member['id']}",
            json={"status": "active"},
        )
        assert_status(restore_response, 200)
        restored_member = restore_response.json()["member"]
        assert restored_member["id"] != first_member["id"]
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        overview_payload = overview.json()
        assert "project_owners" not in overview_payload
        assert (
            overview_payload["migration_status"]
            ["archived_teacher_supervisor_link_count"]
            == 0
        )
        campus = next(
            item for item in overview_payload["campuses"] if item["id"] == campus_id
        )
        classroom_a = next(
            item for item in campus["classrooms"] if item["id"] == classroom_a_id
        )
        original_interval = next(
            item for item in classroom_a["members"] if item["id"] == first_member["id"]
        )
        assert original_interval["status"] == "ended"
        assert original_interval["end_reason"] == "departed"

        assert_status(client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{restored_member['id']}",
            json={"status": "ended", "end_reason": "departed"},
        ), 200)
        assert_status(client.patch(
            f"/api/organization/classrooms/{classroom_a_id}",
            json={"is_active": False},
        ), 409)
        _replace_teachers(client, classroom_a_id, [])
        assert_status(client.patch(
            f"/api/organization/classrooms/{classroom_a_id}",
            json={"is_active": False},
        ), 200)
        blocked_restore = client.patch(
            f"/api/organization/classrooms/{classroom_a_id}/members/{restored_member['id']}",
            json={"status": "active"},
        )
        assert_status(blocked_restore, 409)
        assert_status(
            client.patch(
                f"/api/organization/classrooms/{classroom_b_id}/members/"
                f"{transfer['transferred_member']['id']}",
                json={"status": "ended", "end_reason": "departed"},
            ),
            200,
        )


def test_roster_album_name_is_admin_managed_and_updates_existing_and_future_projects():
    with started_client() as client:
        login(client)
        first_template_id = _create_active_template(client)
        campus_id, classroom_id = _create_campus_and_classroom(client)
        _, target_classroom_id = _create_campus_and_classroom(
            client,
            campus_id=campus_id,
        )
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        add_response = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/batch",
            json={
                "members": [
                    {"name": "王小明", "album_name": "  明明  "},
                    {"name": "李小華", "album_name": "   "},
                    {"name": "陳小真", "album_name": "小華"},
                ],
            },
        )
        assert_status(add_response, 201)
        members = {
            member["name"]: member for member in add_response.json()["created"]
        }
        assert members["王小明"]["album_name"] == "明明"
        assert members["王小明"]["effective_album_name"] == "明明"
        assert members["李小華"]["album_name"] is None
        assert members["李小華"]["effective_album_name"] == "李小華"

        first_project = _create_classroom_project(
            client,
            classroom_id,
            first_template_id,
            lead_teacher["id"],
        )
        first_students = {
            student["name"]: student for student in first_project["students"]
        }
        assert first_students["王小明"]["album_name"] == "明明"
        assert first_students["李小華"]["album_name"] is None
        assert first_students["陳小真"]["album_name"] == "小華"

        project_album_name_response = client.put(
            f"/api/projects/{first_project['id']}/students/"
            f"{first_students['王小明']['id']}/album-name",
            json={"album_name": "本期明明"},
        )
        assert_status(project_album_name_response, 409)
        assert (
            project_album_name_response.json()["detail"]["code"]
            == "roster_album_name_authority"
        )
        roster_overview = client.get("/api/organization/overview")
        assert_status(roster_overview, 200)
        roster_member = next(
            member
            for campus in roster_overview.json()["campuses"]
            for classroom in campus["classrooms"]
            if classroom["id"] == classroom_id
            for member in classroom["members"]
            if member["id"] == members["王小明"]["id"]
        )
        assert roster_member["album_name"] == "明明"

        client.cookies.clear()
        login(client, lead_teacher["username"], USER_PASSWORD)
        forbidden = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/"
            f"{members['王小明']['id']}",
            json={"album_name": "老師不可改"},
        )
        assert_status(forbidden, 403)

        client.cookies.clear()
        login(client)
        update_response = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/"
            f"{members['王小明']['id']}",
            json={"album_name": "  新稱呼  "},
        )
        assert_status(update_response, 200)
        assert update_response.json()["member"]["album_name"] == "新稱呼"
        assert (
            update_response.json()["member"]["effective_album_name"]
            == "新稱呼"
        )

        first_project_detail = client.get(
            f"/api/projects/{first_project['id']}"
        )
        assert_status(first_project_detail, 200)
        persisted_first_students = {
            student["name"]: student
            for student in first_project_detail.json()["students"]
        }
        assert persisted_first_students["王小明"]["album_name"] == "新稱呼"

        second_template_id = _create_active_template(client)
        second_project = _create_classroom_project(
            client,
            classroom_id,
            second_template_id,
            lead_teacher["id"],
        )
        second_students = {
            student["name"]: student for student in second_project["students"]
        }
        assert second_students["王小明"]["album_name"] == "新稱呼"
        assert second_students["李小華"]["album_name"] is None

        transfer_response = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/"
            f"{members['王小明']['id']}",
            json={"target_classroom_id": target_classroom_id},
        )
        assert_status(transfer_response, 200)
        transferred_member = transfer_response.json()["transferred_member"]
        assert transferred_member["album_name"] == "新稱呼"

        clear_response = client.patch(
            f"/api/organization/classrooms/{target_classroom_id}/members/"
            f"{transferred_member['id']}",
            json={"album_name": None},
        )
        assert_status(clear_response, 200)
        assert clear_response.json()["member"]["album_name"] is None
        assert (
            clear_response.json()["member"]["effective_album_name"]
            == "王小明"
        )
        for project_id in (first_project["id"], second_project["id"]):
            project_detail = client.get(f"/api/projects/{project_id}")
            assert_status(project_detail, 200)
            student = next(
                student
                for student in project_detail.json()["students"]
                if student["name"] == "王小明"
            )
            assert student["album_name"] is None
            assert student["effective_album_name"] == "王小明"


def test_classroom_project_locks_organization_then_template_before_db_write(
    monkeypatch,
):
    import services.organization_service as organization_service
    from services.organization_lock import organization_acl_lock

    events: list[str] = []
    original_template_lock = organization_service.lock_template_write
    original_transaction = organization_service.organization_write_transaction

    class RecordingOrganizationLock:
        def __enter__(self):
            organization_acl_lock.acquire()
            events.append("organization")

        def __exit__(self, exc_type, exc_value, traceback):
            organization_acl_lock.release()

    @contextmanager
    def recording_template_lock(template_id: int):
        with original_template_lock(template_id):
            events.append("template")
            yield

    @contextmanager
    def recording_transaction(db):
        with original_transaction(db):
            events.append("transaction")
            yield

    monkeypatch.setattr(
        organization_service,
        "organization_acl_lock",
        RecordingOrganizationLock(),
    )
    monkeypatch.setattr(
        organization_service,
        "lock_template_write",
        recording_template_lock,
    )
    monkeypatch.setattr(
        organization_service,
        "organization_write_transaction",
        recording_transaction,
    )

    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        _, classroom_id = _create_campus_and_classroom(client)
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        _add_members(client, classroom_id, [unique_name("lock_child")])

        events.clear()
        _create_classroom_project(
            client,
            classroom_id,
            template_id,
            lead_teacher["id"],
        )

    assert events == ["organization", "template", "transaction"]


def test_assignment_preserves_creator_and_user_delete_keeps_name_snapshots():
    with started_client() as client:
        admin = login(client)
        owner, _ = create_user(client, "teacher")
        next_owner, next_owner_password = create_user(client, "teacher")
        template_id = _create_active_template(client)
        _, classroom_id = _create_campus_and_classroom(client)
        _replace_teachers(
            client,
            classroom_id,
            [
                {"teacher_id": owner["id"], "duty": "lead"},
                {"teacher_id": next_owner["id"], "duty": "co_teacher"},
            ],
        )
        _add_members(client, classroom_id, ["陳小安"])
        project = _create_classroom_project(
            client,
            classroom_id,
            template_id,
            owner["id"],
        )
        assert project["created_by_id"] == admin["user_id"]
        assert project["owner_id"] == owner["id"]

        transfer_response = client.post(
            f"/api/projects/{project['id']}/assignment",
            json={"owner_id": next_owner["id"], "reason": "新一期改由另一位老師承接"},
        )
        assert_status(transfer_response, 200)
        transferred = transfer_response.json()
        assert transferred["created_by_id"] == admin["user_id"]
        assert transferred["owner_id"] == next_owner["id"]
        history_response = client.get(
            f"/api/projects/{project['id']}/assignment-history"
        )
        assert_status(history_response, 200)
        assert len(history_response.json()) == 1
        assert history_response.json()[0]["from_owner_id"] == owner["id"]
        assert history_response.json()[0]["to_owner_id"] == next_owner["id"]
        detail_response = client.get(f"/api/projects/{project['id']}")
        assert_status(detail_response, 200)
        assert detail_response.json()["created_by_id"] == admin["user_id"]
        assert detail_response.json()["owner_id"] == next_owner["id"]

        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": next_owner["id"], "duty": "lead"}],
        )
        personal_template_id = _create_active_template(client)

        client.cookies.clear()
        login(client, next_owner["username"], next_owner_password)
        personal_project = _create_classroom_project(
            client,
            classroom_id,
            personal_template_id,
            next_owner["id"],
        )
        personal_project_id = personal_project["id"]
        client.cookies.clear()
        login(client)
        delete_response = client.delete(f"/api/users/{next_owner['id']}")
        assert_status(delete_response, 200)

        personal_detail = client.get(f"/api/projects/{personal_project_id}")
        assert_status(personal_detail, 200)
        assert personal_detail.json()["created_by_id"] is None
        assert personal_detail.json()["created_by_name"] == next_owner["display_name"]
        assert personal_detail.json()["owner_id"] == admin["user_id"]
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        assert personal_project_id in {
            project_row["id"]
            for campus_row in overview.json()["campuses"]
            for classroom_row in campus_row["classrooms"]
            for project_row in classroom_row["projects"]
        }
        deletion_history = client.get(
            f"/api/projects/{personal_project_id}/assignment-history"
        )
        assert_status(deletion_history, 200)
        assert len(deletion_history.json()) == 1
        assert deletion_history.json()[0]["from_owner_id"] is None
        assert deletion_history.json()[0]["from_owner_name"] == next_owner["display_name"]
        assert deletion_history.json()[0]["changed_by_id"] == admin["user_id"]


def test_assignment_accepts_supervisor_account_with_active_teacher_assignment():
    with started_client() as client:
        login(client)
        lead_teacher, _ = create_user(client, "teacher")
        supervisor_teacher, _ = create_user(client, "supervisor")
        template_id = _create_active_template(client)
        _, classroom_id = _create_campus_and_classroom(client)
        _replace_teachers(
            client,
            classroom_id,
            [
                {"teacher_id": lead_teacher["id"], "duty": "lead"},
                {
                    "teacher_id": supervisor_teacher["id"],
                    "duty": "co_teacher",
                },
            ],
        )
        _add_members(client, classroom_id, ["雙重職務學生"])
        project = _create_classroom_project(
            client,
            classroom_id,
            template_id,
            lead_teacher["id"],
        )

        transfer_response = client.post(
            f"/api/projects/{project['id']}/assignment",
            json={"owner_id": supervisor_teacher["id"]},
        )

        assert_status(transfer_response, 200)
        assert transfer_response.json()["owner_id"] == supervisor_teacher["id"]


def test_organization_routes_are_admin_only():
    with started_client() as client:
        unauthenticated = client.get("/api/organization/overview")
        assert_status(unauthenticated, 401)
        login(client)
        teacher, _ = create_user(client, "teacher")
        client.cookies.clear()
        login(client, teacher["username"], USER_PASSWORD)
        assert_status(client.get("/api/organization/overview"), 403)
        assert_status(
            client.post(
                "/api/organization/campuses",
                json={"name": unique_name("forbidden_campus")},
            ),
            403,
        )
        assert_status(
            client.post(
                "/api/projects/999999/assignment",
                json={"owner_id": teacher["id"]},
            ),
            403,
        )


def test_project_snapshot_is_immutable_and_blocks_duplicate_current_roster():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        _, classroom_id = _create_campus_and_classroom(client)
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        member = _add_members(client, classroom_id, ["林小美"])[0]
        project = _create_classroom_project(
            client,
            classroom_id,
            template_id,
            lead_teacher["id"],
        )
        student_id = project["students"][0]["id"]
        delete_response = client.delete(
            f"/api/projects/{project['id']}/students/{student_id}"
        )
        assert_status(delete_response, 405)

        db = SessionLocal()
        try:
            assert db.get(Student, student_id) is not None
            assert db.get(RosterChild, member["roster_child_id"]) is not None
            assert db.query(ClassRosterMember).filter(
                ClassRosterMember.roster_child_id == member["roster_child_id"]
            ).count() == 1
            duplicate_child = RosterChild(name="林小美")
            db.add(duplicate_child)
            db.flush()
            db.add(ClassRosterMember(
                classroom_id=classroom_id,
                roster_child_id=duplicate_child.id,
            ))
            db.commit()
            duplicate_child_id = duplicate_child.id
            project_count = db.query(Project).count()
        finally:
            db.close()

        merge_response = client.post(
            f"/api/roster/children/{duplicate_child_id}/merge/{member['roster_child_id']}"
        )
        assert_status(merge_response, 405)

        duplicate_template_id = _create_active_template(client)
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        duplicate_work_slot_id = next(
            work_slot["id"]
            for work_slot in overview.json()["work_slots"]
            if work_slot["classroom_id"] == classroom_id
            and duplicate_template_id in work_slot["template_ids"]
            and work_slot["can_create_project"]
        )
        duplicate_response = client.post(
            f"/api/organization/classrooms/{classroom_id}/projects",
            json={
                "name": unique_name("duplicate_snapshot"),
                "template_id": duplicate_template_id,
                "work_slot_id": duplicate_work_slot_id,
                "owner_id": lead_teacher["id"],
            },
        )
        assert_status(duplicate_response, 409)
        assert duplicate_response.json()["detail"]["code"] == "duplicate_active_child_name"
        db = SessionLocal()
        try:
            assert db.query(Project).count() == project_count
            duplicate_membership = db.query(ClassRosterMember).filter(
                ClassRosterMember.roster_child_id == duplicate_child_id
            ).one()
            duplicate_membership.ended_at = duplicate_membership.started_at
            duplicate_membership.end_reason = "departed"
            db.commit()
        finally:
            db.close()


def test_campus_cannot_be_disabled_with_active_classrooms_or_assignments():
    with started_client() as client:
        login(client)
        campus_id, classroom_id = _create_campus_and_classroom(client)
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        member = _add_members(client, classroom_id, [unique_name("campus_child")])[0]

        active_roster_response = client.patch(
            f"/api/organization/campuses/{campus_id}",
            json={"is_active": False},
        )
        assert_status(active_roster_response, 409)
        assert active_roster_response.json()["detail"]["code"] == (
            "campus_has_active_classrooms_or_assignments"
        )

        assert_status(
            client.patch(
                f"/api/organization/classrooms/{classroom_id}/members/{member['id']}",
                json={"status": "ended", "end_reason": "departed"},
            ),
            200,
        )
        active_teacher_response = client.patch(
            f"/api/organization/campuses/{campus_id}",
            json={"is_active": False},
        )
        assert_status(active_teacher_response, 409)

        # 班級隨學期結束，所以「旗下還有班級」不再是停用分校的阻擋條件；
        # 只要沒有在籍成員與在職編制就能停用。
        _replace_teachers(client, classroom_id, [])
        disabled_response = client.patch(
            f"/api/organization/campuses/{campus_id}",
            json={"is_active": False},
        )
        assert_status(disabled_response, 200)
        assert disabled_response.json()["is_active"] is False


def test_active_classroom_cannot_be_created_or_moved_under_inactive_campus():
    with started_client() as client:
        login(client)
        inactive_campus_response = client.post(
            "/api/organization/campuses",
            json={"name": unique_name("inactive_campus"), "is_active": False},
        )
        assert_status(inactive_campus_response, 201)
        inactive_campus_id = inactive_campus_response.json()["id"]

        blocked_create = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": inactive_campus_id,
                "department": "infant",
                "name": unique_name("blocked_active_classroom"),
                "is_active": True,
            },
        )
        assert_status(blocked_create, 409)
        assert blocked_create.json()["detail"]["code"] == (
            "active_classroom_requires_active_campus"
        )

        # 班級沒有停用狀態：不屬於目前學期即為結束，所以建立時不接受 is_active=False
        rejected_inactive = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": inactive_campus_id,
                "department": "infant",
                "name": unique_name("inactive_classroom"),
                "is_active": False,
            },
        )
        assert_status(rejected_inactive, 422)
        assert rejected_inactive.json()["detail"]["code"] == (
            "classroom_has_no_active_flag"
        )

        active_campus_id, active_classroom_id = _create_campus_and_classroom(client)
        lead_teacher = _create_teacher(client)
        _replace_teachers(
            client,
            active_classroom_id,
            [{"teacher_id": lead_teacher["id"], "duty": "lead"}],
        )
        _add_members(client, active_classroom_id, [unique_name("active_child")])
        blocked_move = client.patch(
            f"/api/organization/classrooms/{active_classroom_id}",
            json={"campus_id": inactive_campus_id},
        )
        assert_status(blocked_move, 409)
        assert blocked_move.json()["detail"]["code"] == (
            "active_classroom_requires_active_campus"
        )

        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        active_campus = next(
            campus
            for campus in overview.json()["campuses"]
            if campus["id"] == active_campus_id
        )
        assert active_classroom_id in {
            classroom["id"] for classroom in active_campus["classrooms"]
        }


def test_classroom_member_explicit_null_name_is_rejected_without_mutation():
    with started_client() as client:
        login(client)
        campus_id, classroom_id = _create_campus_and_classroom(client)
        member = _add_members(client, classroom_id, ["保留姓名"])[0]

        response = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/{member['id']}",
            json={"name": None},
        )

        assert_status(response, 422)
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        campus = next(
            row for row in overview.json()["campuses"] if row["id"] == campus_id
        )
        classroom = next(
            row for row in campus["classrooms"] if row["id"] == classroom_id
        )
        persisted_member = next(
            row for row in classroom["members"] if row["id"] == member["id"]
        )
        assert persisted_member["name"] == "保留姓名"


def test_organization_migration_repairs_intermediate_schema_idempotently():
    import migrations

    migration_path = (
        Path(__file__).resolve().parents[1]
        / ".tmp"
        / "pytest"
        / f"organization_migration_{uuid4().hex}.db"
    )
    migration_engine = create_engine(f"sqlite:///{migration_path.as_posix()}")
    with migration_engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, display_name VARCHAR)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE roster_children (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, owner_id INTEGER)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE campuses (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, "
            "is_active BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME, updated_at DATETIME)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE classrooms (id INTEGER PRIMARY KEY, campus_id INTEGER NOT NULL, "
            "name VARCHAR NOT NULL, is_active BOOLEAN NOT NULL DEFAULT 1, "
            "created_at DATETIME, updated_at DATETIME)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE class_roster_members (id INTEGER PRIMARY KEY, "
            "classroom_id INTEGER NOT NULL, roster_child_id INTEGER NOT NULL, "
            "started_at DATETIME, ended_at DATETIME)"
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX ux_class_roster_active_child "
            "ON class_roster_members(classroom_id, roster_child_id) WHERE ended_at IS NULL"
        )
        connection.exec_driver_sql("INSERT INTO projects (id, owner_id) VALUES (1, NULL)")

    with migration_engine.connect() as connection:
        migrations._add_organization_structure(connection)
        migrations._add_organization_structure(connection)
        classroom_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(classrooms)"))
        }
        member_columns = {
            row[1]
            for row in connection.execute(text("PRAGMA table_info(class_roster_members)"))
        }
        project_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))
        }
        assert "department" in classroom_columns
        assert "end_reason" in member_columns
        assert {"classroom_id", "created_by_id", "created_by_name"} <= project_columns
        index_sql = connection.execute(text(
            "SELECT sql FROM sqlite_master "
            "WHERE type='index' AND name='ux_class_roster_active_child'"
        )).scalar_one()
        assert "(roster_child_id)" in index_sql
        assert "classroom_id" not in index_sql
        legacy_project = connection.execute(text(
            "SELECT created_by_id, created_by_name FROM projects WHERE id = 1"
        )).one()
        assert legacy_project == (None, None)
        assert connection.execute(text(
            "SELECT COUNT(*) FROM project_assignment_history WHERE project_id = 1"
        )).scalar_one() == 0
