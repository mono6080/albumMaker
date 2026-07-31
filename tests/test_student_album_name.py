"""園所名冊相本稱呼的單一來源與舊相本相容契約。"""

from datetime import datetime

from sqlalchemy import create_engine, text

from database import ClassroomMember, Project, RosterChild, SessionLocal, Student
from services.output_keys import get_student_pdf_key
from services.student_album_name_policy import (
    assign_automatic_album_names,
    suggest_automatic_album_name,
)
from services.student_input_policy import STUDENT_ALBUM_NAME_MAX_LENGTH
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _project_students(client, project_id: int) -> dict[str, dict]:
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return {
        student["name"]: student
        for student in detail.json()["students"]
    }


def test_automatic_album_name_policy_is_conservative_and_blocks_collisions():
    assert suggest_automatic_album_name("王小明") == "小明"
    assert suggest_automatic_album_name(" 王明 ") == "明"
    assert suggest_automatic_album_name("歐陽明") is None
    assert suggest_automatic_album_name("歐陽小明") is None
    assert suggest_automatic_album_name("明") is None
    assert suggest_automatic_album_name("王小明安") is None
    assert suggest_automatic_album_name("王小明A") is None
    assert suggest_automatic_album_name("王 小明") is None

    assert assign_automatic_album_names(
        ["王小明", "陳小明", "李小華", "王志豪"],
        {"志豪"},
    ) == [None, None, "小華", None]
    assert assign_automatic_album_names(["王明", "明"], set()) == [None, None]
    assert assign_automatic_album_names(
        ["王明", "李明", "陳王明"],
        set(),
    ) == [None, None, None]


def test_assigned_student_with_missing_child_never_reads_legacy_alias():
    project = Project(classroom_id=1)
    student = Student(name="既有完整姓名", album_name="相本內舊稱呼")
    student.project = project

    assert student.resolved_album_name is None
    assert student.effective_album_name == "既有完整姓名"


def test_roster_creation_stores_automatic_names_before_project_creation():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        student_names = [
            "王小明",
            "陳小明",
            "李小華",
            "歐陽明",
            "明",
            "王明",
            "李明",
            "陳王明",
            "王小明安",
            "王小明A",
        ]
        project_id = create_project(
            client,
            template_id,
            unique_name("automatic_album_name"),
            student_names=student_names,
        )

        students = _project_students(client, project_id)
        assert students["王小明"]["album_name"] is None
        assert students["陳小明"]["album_name"] is None
        assert students["李小華"]["album_name"] == "小華"
        assert students["李小華"]["effective_album_name"] == "小華"
        for unsupported_name in ("歐陽明", "明", "王小明安", "王小明A"):
            assert students[unsupported_name]["album_name"] is None
            assert students[unsupported_name]["effective_album_name"] == unsupported_name
        for colliding_name in ("王明", "李明", "陳王明"):
            assert students[colliding_name]["album_name"] is None

        db = SessionLocal()
        try:
            db_students = db.query(Student).filter(Student.project_id == project_id).all()
            assert all(student.album_name is None for student in db_students)
            roster_by_name = {
                child.name: child
                for child in db.query(RosterChild).filter(
                    RosterChild.id.in_({student.roster_child_id for student in db_students})
                )
            }
            assert roster_by_name["李小華"].album_name == "小華"
        finally:
            db.close()


def test_assigned_project_ignores_raw_student_alias_and_rejects_second_authority():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("roster_authority"),
            student_names=["李志豪"],
        )
        student = next(iter(_project_students(client, project_id).values()))
        assert student["album_name"] == "志豪"

        db = SessionLocal()
        try:
            db.get(Student, student["id"]).album_name = "相本內舊值"
            db.commit()
        finally:
            db.close()
        assert next(iter(_project_students(client, project_id).values()))["album_name"] == "志豪"

        routes = [
            ("put", f"/api/projects/{project_id}/students/{student['id']}/album-name"),
            ("post", f"/api/projects/{project_id}/students/{student['id']}/album-name/auto-fill"),
            ("post", f"/api/projects/{project_id}/students/album-names/auto-fill"),
        ]
        for method, url in routes:
            response = getattr(client, method)(
                url,
                json={"album_name": "不可寫入"} if method == "put" else None,
            )
            assert_status(response, 409)
            assert response.json()["detail"]["code"] == "roster_album_name_authority"


def test_roster_alias_change_updates_all_existing_projects_and_invalidates_outputs():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        first_project_id = create_project(
            client,
            template_id,
            unique_name("central_alias_first"),
            student_names=["王小明"],
        )
        first_student = next(iter(_project_students(client, first_project_id).values()))

        old_timestamp = datetime(2000, 1, 1)
        db = SessionLocal()
        try:
            first_project = db.get(Project, first_project_id)
            first_db_student = db.get(Student, first_student["id"])
            roster_child_id = int(first_db_student.roster_child_id)
            second_project = Project(
                name=unique_name("central_alias_second"),
                template_id=first_project.template_id,
                template_revision=first_project.template_revision,
                department=first_project.department,
                template_period_id=first_project.template_period_id,
                owner_id=first_project.owner_id,
                classroom_id=first_project.classroom_id,
                created_by_id=first_project.created_by_id,
                created_by_name=first_project.created_by_name,
                campus_id_snapshot=first_project.campus_id_snapshot,
                campus_name_snapshot=first_project.campus_name_snapshot,
                classroom_name_snapshot=first_project.classroom_name_snapshot,
                label_texts_json="{}",
                updated_at=old_timestamp,
            )
            db.add(second_project)
            db.flush()
            second_student = Student(
                project_id=second_project.id,
                name="王小明舊快照",
                album_name="相本內舊值",
                order_index=0,
                pages_data_json="[]",
                roster_child_id=roster_child_id,
                output_filename=get_student_pdf_key(second_project.id, 999999),
                updated_at=old_timestamp,
            )
            db.add(second_student)
            first_db_student.output_filename = get_student_pdf_key(
                first_project_id,
                first_db_student.id,
            )
            first_db_student.updated_at = old_timestamp
            first_project.updated_at = old_timestamp
            db.commit()
            second_project_id = second_project.id
            second_student_id = second_student.id
        finally:
            db.close()

        update = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={"album_name": "  明明  "},
        )
        assert_status(update, 200)
        assert update.json()["album_name"] == "明明"

        first = next(iter(_project_students(client, first_project_id).values()))
        second = next(iter(_project_students(client, second_project_id).values()))
        assert first["album_name"] == "明明"
        assert first["effective_album_name"] == "明明"
        assert second["album_name"] == "明明"
        assert second["effective_album_name"] == "明明"

        db = SessionLocal()
        try:
            assert db.get(Student, first_student["id"]).output_filename is None
            second_db_student = db.get(Student, second_student_id)
            assert second_db_student.output_filename is None
            assert second_db_student.album_name == "相本內舊值"
            assert db.get(Project, first_project_id).updated_at > old_timestamp
            assert db.get(Project, second_project_id).updated_at > old_timestamp
        finally:
            db.close()

        clear = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={"album_name": None},
        )
        assert_status(clear, 200)
        first = next(iter(_project_students(client, first_project_id).values()))
        second = next(iter(_project_students(client, second_project_id).values()))
        assert first["effective_album_name"] == "王小明"
        assert second["effective_album_name"] == "王小明舊快照"


def test_roster_auto_fill_updates_only_safe_blank_names_across_existing_projects():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("central_alias_auto_fill"),
            student_names=[
                "李小華",
                "王小明",
                "陳小明",
                "歐陽明",
                "趙志豪",
                "周美玲",
            ],
        )
        old_timestamp = datetime(2000, 1, 1)
        db = SessionLocal()
        try:
            project = db.get(Project, project_id)
            classroom_id = int(project.classroom_id)
            students = {
                student.name: student
                for student in db.query(Student).filter(
                    Student.project_id == project_id,
                )
            }
            roster_children = {
                name: db.get(RosterChild, student.roster_child_id)
                for name, student in students.items()
            }
            for name in ("李小華", "周美玲"):
                roster_children[name].album_name = None
            roster_children["趙志豪"].album_name = "人工稱呼"
            for name in ("李小華", "王小明", "歐陽明", "趙志豪", "周美玲"):
                membership = db.query(ClassroomMember).filter(
                    ClassroomMember.roster_child_id == roster_children[name].id,
                ).one()
                membership.ended_at = None
                membership.end_reason = None
            students["李小華"].output_filename = get_student_pdf_key(
                project_id,
                students["李小華"].id,
            )
            students["李小華"].updated_at = old_timestamp
            project.updated_at = old_timestamp
            db.commit()
            child_ids = {
                name: int(child.id)
                for name, child in roster_children.items()
            }
            target_student_id = int(students["李小華"].id)
        finally:
            db.close()

        batch = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/album-names/auto-fill",
        )
        assert_status(batch, 200)
        assert batch.json() == {"updated": 2, "unresolved": 2}

        project_students = _project_students(client, project_id)
        assert project_students["李小華"]["album_name"] == "小華"
        assert project_students["周美玲"]["album_name"] == "美玲"
        assert project_students["趙志豪"]["album_name"] == "人工稱呼"
        assert project_students["王小明"]["album_name"] is None
        assert project_students["陳小明"]["album_name"] is None
        assert project_students["歐陽明"]["album_name"] is None

        db = SessionLocal()
        try:
            assert db.get(Student, target_student_id).output_filename is None
            assert db.get(Student, target_student_id).updated_at > old_timestamp
            assert db.get(Project, project_id).updated_at > old_timestamp
        finally:
            db.close()

        repeated = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/album-names/auto-fill",
        )
        assert_status(repeated, 200)
        assert repeated.json() == {"updated": 0, "unresolved": 2}

        collision = client.post(
            "/api/organization/roster-children/"
            f"{child_ids['陳小明']}/album-name/auto-fill",
        )
        assert_status(collision, 200)
        assert collision.json() == {"updated": 0, "unresolved": 1}

        preserved = client.post(
            "/api/organization/roster-children/"
            f"{child_ids['趙志豪']}/album-name/auto-fill",
        )
        assert_status(preserved, 200)
        assert preserved.json() == {"updated": 0, "unresolved": 0}

        cleared = client.patch(
            f"/api/organization/roster-children/{child_ids['周美玲']}/album-name",
            json={"album_name": None},
        )
        assert_status(cleared, 200)
        single = client.post(
            "/api/organization/roster-children/"
            f"{child_ids['周美玲']}/album-name/auto-fill",
        )
        assert_status(single, 200)
        assert single.json() == {"updated": 1, "unresolved": 0}

        teacher, teacher_password = create_user(client, "teacher")
        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        assert_status(client.post(
            f"/api/organization/classrooms/{classroom_id}/members/album-names/auto-fill",
        ), 403)
        assert_status(client.post(
            "/api/organization/roster-children/"
            f"{child_ids['周美玲']}/album-name/auto-fill",
        ), 403)


def test_roster_album_name_input_limit_preserves_existing_value():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("album_limit"),
            student_names=["來源名冊姓名"],
        )
        student = next(iter(_project_students(client, project_id).values()))
        db = SessionLocal()
        try:
            roster_child_id = db.get(Student, student["id"]).roster_child_id
        finally:
            db.close()

        missing = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={},
        )
        assert_status(missing, 422)
        accepted = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={"album_name": "來源相本名"},
        )
        assert_status(accepted, 200)
        rejected = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={"album_name": "名" * (STUDENT_ALBUM_NAME_MAX_LENGTH + 1)},
        )
        assert_status(rejected, 422)
        preserved = next(iter(_project_students(client, project_id).values()))
        assert preserved["album_name"] == "來源相本名"


def test_album_name_migration_is_idempotent_and_preserves_legacy_rows(
    tmp_path,
    monkeypatch,
):
    import migrations
    from database import Base

    database_path = tmp_path / "legacy-student-album-name.db"
    legacy_engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        Base.metadata.create_all(bind=legacy_engine)
        with legacy_engine.begin() as connection:
            connection.execute(text("ALTER TABLE students DROP COLUMN album_name"))
            template_id = connection.execute(text(
                "INSERT INTO templates (name) VALUES ('既有模板') RETURNING id"
            )).scalar_one()
            project_id = connection.execute(
                text("""
                    INSERT INTO projects (name, template_id, label_texts_json)
                    VALUES ('既有專案', :template_id, '{}') RETURNING id
                """),
                {"template_id": template_id},
            ).scalar_one()
            connection.execute(
                text("""
                    INSERT INTO students (project_id, name, pages_data_json)
                    VALUES (:project_id, '既有學生', '[]')
                """),
                {"project_id": project_id},
            )

        monkeypatch.setattr(migrations, "engine", legacy_engine)
        migrations.run_migrations()
        migrations.run_migrations()
        with legacy_engine.connect() as connection:
            columns = {
                row[1]
                for row in connection.execute(text("PRAGMA table_info(students)"))
            }
            preserved = connection.execute(text(
                "SELECT name, album_name FROM students WHERE id = 1"
            )).one()

        assert "album_name" in columns
        assert preserved == ("既有學生", None)
    finally:
        legacy_engine.dispose()
