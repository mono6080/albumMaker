"""學生名冊姓名與相本稱呼的資料／API 契約。"""

from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import create_engine, text

from database import Project, SessionLocal, Student
from services.output_keys import (
    get_student_image_key,
    get_student_output_prefix,
    get_student_pdf_key,
)
from services.storage_local import LocalStorageAdapter
from services.student_album_name_policy import (
    assign_automatic_album_names,
    suggest_automatic_album_name,
)
from services.student_input_policy import STUDENT_ALBUM_NAME_MAX_LENGTH
from tests.helpers import (
    assert_status,
    create_project,
    create_project_for_owner,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _create_student(client, project_id: int, name: str) -> dict:
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return next(
        student
        for student in detail.json()["students"]
        if student["name"] == name
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


def test_classroom_snapshot_automatically_sets_only_unique_safe_album_names():
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
            assert (
                students[unsupported_name]["effective_album_name"]
                == unsupported_name
            )
        for colliding_name in ("王明", "李明", "陳王明"):
            assert students[colliding_name]["album_name"] is None


def test_album_name_endpoint_rejects_full_name_field():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("existing_album_collision"),
            student_names=["李志豪"],
        )

        existing = _create_student(client, project_id, "李志豪")
        assert existing["album_name"] == "志豪"

        update = client.put(
            f"/api/projects/{project_id}/students/{existing['id']}/album-name",
            json={"album_name": "小真"},
        )
        assert_status(update, 200)
        rejected = client.put(
            f"/api/projects/{project_id}/students/{existing['id']}/album-name",
            json={"album_name": "小真", "name": "不可改完整姓名"},
        )
        assert_status(rejected, 422)
        student = _project_students(client, project_id)["李志豪"]
        assert student["name"] == "李志豪"
        assert student["album_name"] == "小真"


def test_auto_fill_existing_album_names_preserves_manual_values_and_outputs(
    monkeypatch,
    tmp_path,
):
    import services.project_student_service as project_student_service

    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("existing_album_auto_fill"),
            student_names=[
                "王小明",
                "陳小明",
                "李小華",
                "趙小美",
                "歐陽明",
                "既有人工姓名",
                "陳小真",
            ],
        )
        students = _project_students(client, project_id)
        manual_student_id = students["既有人工姓名"]["id"]
        assert_status(
            client.put(
                f"/api/projects/{project_id}/students/{manual_student_id}/album-name",
                json={"album_name": "小真"},
            ),
            200,
        )

        old_timestamp = datetime(2000, 1, 1)
        updated_student_id = students["李小華"]["id"]
        legacy_updated_student_id = students["趙小美"]["id"]
        preserved_student_id = students["王小明"]["id"]
        empty_album_student_id = students["陳小真"]["id"]
        updated_pdf_key = get_student_pdf_key(project_id, updated_student_id)
        updated_image_key = get_student_image_key(
            project_id,
            updated_student_id,
            "print",
            1,
        )
        preserved_pdf_key = get_student_pdf_key(project_id, preserved_student_id)
        legacy_pdf_key = f"projects/proj{project_id}/output/legacy-album.pdf"
        legacy_image_key = f"projects/proj{project_id}/output/legacy-album/page1.jpg"
        db = SessionLocal()
        try:
            db.get(Student, updated_student_id).album_name = None
            db.get(Student, updated_student_id).output_filename = updated_pdf_key
            db.get(Student, updated_student_id).updated_at = old_timestamp
            db.get(Student, legacy_updated_student_id).album_name = None
            db.get(Student, legacy_updated_student_id).output_filename = legacy_pdf_key
            db.get(Student, legacy_updated_student_id).updated_at = old_timestamp
            db.get(Student, preserved_student_id).output_filename = preserved_pdf_key
            db.get(Student, empty_album_student_id).album_name = ""
            db.get(Project, project_id).updated_at = old_timestamp
            db.commit()
        finally:
            db.close()
        storage.put(updated_pdf_key, b"updated-pdf")
        storage.put(updated_image_key, b"updated-image")
        storage.put(preserved_pdf_key, b"preserved-pdf")
        storage.put(legacy_pdf_key, b"legacy-pdf")
        storage.put(legacy_image_key, b"legacy-image")

        lock_events = []

        @contextmanager
        def observed_project_locks(project_ids):
            lock_events.append(("project_enter", tuple(project_ids)))
            yield
            lock_events.append(("project_exit", tuple(project_ids)))

        @contextmanager
        def observed_student_locks(student_ids):
            lock_events.append(("student_enter", tuple(sorted(student_ids))))
            yield
            lock_events.append(("student_exit", tuple(sorted(student_ids))))

        monkeypatch.setattr(
            project_student_service,
            "lock_project_content_writes",
            observed_project_locks,
        )
        monkeypatch.setattr(
            project_student_service,
            "lock_student_page_writes",
            observed_student_locks,
        )

        auto_fill = client.post(
            f"/api/projects/{project_id}/students/album-names/auto-fill"
        )
        assert_status(auto_fill, 200)
        assert auto_fill.json() == {"updated": 2, "unresolved": 4}
        assert [event[0] for event in lock_events] == [
            "project_enter",
            "student_enter",
            "student_exit",
            "project_exit",
        ]

        db = SessionLocal()
        try:
            updated_student = db.get(Student, updated_student_id)
            legacy_updated_student = db.get(Student, legacy_updated_student_id)
            preserved_student = db.get(Student, preserved_student_id)
            manual_student = db.get(Student, manual_student_id)
            assert updated_student.album_name == "小華"
            assert updated_student.output_filename is None
            assert updated_student.updated_at > old_timestamp
            assert legacy_updated_student.album_name == "小美"
            assert legacy_updated_student.output_filename is None
            assert legacy_updated_student.updated_at > old_timestamp
            assert preserved_student.album_name is None
            assert preserved_student.output_filename == preserved_pdf_key
            assert manual_student.album_name == "小真"
            assert db.get(Project, project_id).updated_at > old_timestamp
        finally:
            db.close()
        assert storage.list_keys(
            get_student_output_prefix(project_id, updated_student_id)
        ) == []
        assert storage.get_bytes(preserved_pdf_key) == b"preserved-pdf"
        assert not storage.exists(legacy_pdf_key)
        assert storage.list_keys(
            f"projects/proj{project_id}/output/legacy-album"
        ) == []

        second_auto_fill = client.post(
            f"/api/projects/{project_id}/students/album-names/auto-fill"
        )
        assert_status(second_auto_fill, 200)
        assert second_auto_fill.json() == {"updated": 0, "unresolved": 4}


def test_auto_fill_album_name_keeps_committed_result_when_storage_init_fails(
    monkeypatch,
):
    import services.project_student_service as project_student_service

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("album_auto_fill_cleanup_failure"),
            student_names=["李小華"],
        )
        student = _create_student(client, project_id, "李小華")
        pdf_key = get_student_pdf_key(project_id, student["id"])
        db = SessionLocal()
        try:
            db_student = db.get(Student, student["id"])
            db_student.album_name = None
            db_student.output_filename = pdf_key
            db.commit()
        finally:
            db.close()

        def fail_storage_init():
            raise RuntimeError("storage unavailable")

        monkeypatch.setattr(
            project_student_service,
            "get_storage",
            fail_storage_init,
        )
        response = client.post(
            f"/api/projects/{project_id}/students/album-names/auto-fill"
        )
        assert_status(response, 200)
        assert response.json() == {"updated": 1, "unresolved": 0}

        db = SessionLocal()
        try:
            db_student = db.get(Student, student["id"])
            assert db_student.album_name == "小華"
            assert db_student.output_filename is None
        finally:
            db.close()


def test_auto_fill_single_album_name_only_updates_target_and_invalidates_outputs(
    monkeypatch,
    tmp_path,
):
    import services.project_student_service as project_student_service

    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("single_album_auto_fill"),
            student_names=["王小明", "李小華"],
        )
        students = _project_students(client, project_id)
        target_id = students["王小明"]["id"]
        sibling_id = students["李小華"]["id"]
        target_pdf_key = get_student_pdf_key(project_id, target_id)
        target_image_key = get_student_image_key(project_id, target_id, "print", 1)
        old_timestamp = datetime(2000, 1, 1)
        db = SessionLocal()
        try:
            target = db.get(Student, target_id)
            sibling = db.get(Student, sibling_id)
            target.album_name = None
            target.output_filename = target_pdf_key
            target.updated_at = old_timestamp
            sibling.album_name = None
            sibling.updated_at = old_timestamp
            db.get(Project, project_id).updated_at = old_timestamp
            db.commit()
        finally:
            db.close()
        storage.put(target_pdf_key, b"pdf")
        storage.put(target_image_key, b"image")

        lock_events = []

        @contextmanager
        def observed_project_locks(project_ids):
            lock_events.append(("project_enter", tuple(project_ids)))
            yield
            lock_events.append(("project_exit", tuple(project_ids)))

        @contextmanager
        def observed_student_locks(student_ids):
            lock_events.append(("student_enter", tuple(student_ids)))
            yield
            lock_events.append(("student_exit", tuple(student_ids)))

        monkeypatch.setattr(
            project_student_service,
            "lock_project_content_writes",
            observed_project_locks,
        )
        monkeypatch.setattr(
            project_student_service,
            "lock_student_page_writes",
            observed_student_locks,
        )

        response = client.post(
            f"/api/projects/{project_id}/students/{target_id}/album-name/auto-fill"
        )
        assert_status(response, 200)
        assert response.json() == {"updated": 1, "unresolved": 0}
        assert [event[0] for event in lock_events] == [
            "project_enter",
            "student_enter",
            "student_exit",
            "project_exit",
        ]

        db = SessionLocal()
        try:
            target = db.get(Student, target_id)
            sibling = db.get(Student, sibling_id)
            assert target.album_name == "小明"
            assert target.output_filename is None
            assert target.updated_at > old_timestamp
            assert sibling.album_name is None
            assert sibling.updated_at == old_timestamp
            assert db.get(Project, project_id).updated_at > old_timestamp
        finally:
            db.close()
        assert storage.list_keys(get_student_output_prefix(project_id, target_id)) == []

        other_project_id = create_project(
            client,
            template_id,
            unique_name("single_album_wrong_project"),
        )
        wrong_project = client.post(
            f"/api/projects/{other_project_id}/students/"
            f"{target_id}/album-name/auto-fill"
        )
        assert_status(wrong_project, 404)

        assert_status(
            client.put(
                f"/api/projects/{project_id}/students/{target_id}/album-name",
                json={"album_name": "明明"},
            ),
            200,
        )
        no_overwrite = client.post(
            f"/api/projects/{project_id}/students/{target_id}/album-name/auto-fill"
        )
        assert_status(no_overwrite, 200)
        assert no_overwrite.json() == {"updated": 0, "unresolved": 0}
        assert _project_students(client, project_id)["王小明"]["album_name"] == "明明"


def test_auto_fill_single_album_name_blocks_blank_sibling_full_name_collision():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("single_album_blank_sibling_collision"),
            student_names=["王小明", "小明"],
        )
        students = _project_students(client, project_id)
        target_id = students["王小明"]["id"]
        sibling_id = students["小明"]["id"]

        for blank_album_name in ("", "   "):
            db = SessionLocal()
            try:
                db.get(Student, target_id).album_name = None
                db.get(Student, sibling_id).album_name = blank_album_name
                db.commit()
            finally:
                db.close()

            response = client.post(
                f"/api/projects/{project_id}/students/{target_id}/album-name/auto-fill"
            )
            assert_status(response, 200)
            assert response.json() == {"updated": 0, "unresolved": 1}
            assert _project_students(client, project_id)["王小明"]["album_name"] is None


def test_auto_fill_existing_album_names_obeys_completed_project_lock():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        teacher, teacher_password = create_user(client, "teacher")
        project_id = create_project_for_owner(
            client,
            template_id,
            teacher["id"],
            name=unique_name("completed_album_auto_fill"),
            student_names=["王小明", "陳小明"],
        )
        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        assert_status(client.post(f"/api/projects/{project_id}/complete"), 200)

        blocked = client.post(
            f"/api/projects/{project_id}/students/album-names/auto-fill"
        )
        assert_status(blocked, 403)
        students = _project_students(client, project_id)
        blocked_single = client.post(
            f"/api/projects/{project_id}/students/"
            f"{students['王小明']['id']}/album-name/auto-fill"
        )
        assert_status(blocked_single, 403)
        assert students["王小明"]["album_name"] is None
        assert students["陳小明"]["album_name"] is None


def test_album_name_update_preserves_identity_and_invalidates_outputs(
    monkeypatch,
    tmp_path,
):
    import services.project_student_service as project_student_service

    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            unique_name("album_name"),
            student_names=["名冊姓名"],
        )
        student = _create_student(client, project_id, "名冊姓名")
        student_id = student["id"]
        assert student["album_name"] is None
        assert student["effective_album_name"] == "名冊姓名"

        old_timestamp = datetime(2000, 1, 1)
        pdf_key = get_student_pdf_key(project_id, student_id)
        image_key = get_student_image_key(project_id, student_id, "print", 1)
        db = SessionLocal()
        try:
            db_student = db.get(Student, student_id)
            db_project = db.get(Project, project_id)
            roster_child_id = db_student.roster_child_id
            db_student.output_filename = pdf_key
            db_student.updated_at = old_timestamp
            db_project.updated_at = old_timestamp
            db.commit()
        finally:
            db.close()
        storage.put(pdf_key, b"pdf")
        storage.put(image_key, b"image")

        update = client.put(
            f"/api/projects/{project_id}/students/{student_id}/album-name",
            json={"album_name": "  相本小名  "},
        )
        assert_status(update, 200)
        assert update.json() == {
            "ok": True,
            "name": "名冊姓名",
            "album_name": "相本小名",
            "effective_album_name": "相本小名",
        }

        db = SessionLocal()
        try:
            db_student = db.get(Student, student_id)
            db_project = db.get(Project, project_id)
            assert db_student.name == "名冊姓名"
            assert db_student.album_name == "相本小名"
            assert db_student.roster_child_id == roster_child_id
            assert db_student.output_filename is None
            assert db_student.updated_at > old_timestamp
            assert db_project.updated_at > old_timestamp
        finally:
            db.close()
        assert storage.list_keys(get_student_output_prefix(project_id, student_id)) == []

        project_detail = client.get(f"/api/projects/{project_id}")
        assert_status(project_detail, 200)
        project_student = project_detail.json()["students"][0]
        assert project_student["album_name"] == "相本小名"
        assert project_student["effective_album_name"] == "相本小名"

        editor_detail = client.get(
            f"/api/projects/{project_id}/students/{student_id}/editor"
        )
        assert_status(editor_detail, 200)
        editor = editor_detail.json()
        assert editor["student"]["album_name"] == "相本小名"
        assert editor["student"]["effective_album_name"] == "相本小名"
        assert editor["project"]["students"][0]["album_name"] == "相本小名"
        assert (
            editor["project"]["students"][0]["effective_album_name"]
            == "相本小名"
        )

        clear = client.put(
            f"/api/projects/{project_id}/students/{student_id}/album-name",
            json={"album_name": "   "},
        )
        assert_status(clear, 200)
        assert clear.json()["album_name"] is None
        assert clear.json()["name"] == "名冊姓名"
        assert clear.json()["effective_album_name"] == "名冊姓名"

        assert_status(
            client.put(
                f"/api/projects/{project_id}/students/{student_id}/album-name",
                json={"album_name": "再次設定"},
            ),
            200,
        )
        clear_empty = client.put(
            f"/api/projects/{project_id}/students/{student_id}/album-name",
            json={"album_name": None},
        )
        assert_status(clear_empty, 200)
        assert clear_empty.json()["name"] == "名冊姓名"
        assert clear_empty.json()["album_name"] is None
        assert clear_empty.json()["effective_album_name"] == "名冊姓名"


def test_album_name_input_limit_preserves_existing_value():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        source_project_id = create_project(
            client,
            template_id,
            unique_name("album_source"),
            student_names=["來源名冊姓名"],
        )
        source_student = _create_student(client, source_project_id, "來源名冊姓名")

        accepted = client.put(
            f"/api/projects/{source_project_id}/students/{source_student['id']}/album-name",
            json={"album_name": "來源相本名"},
        )
        assert_status(accepted, 200)

        rejected = client.put(
            f"/api/projects/{source_project_id}/students/{source_student['id']}/album-name",
            json={"album_name": "名" * (STUDENT_ALBUM_NAME_MAX_LENGTH + 1)},
        )
        assert_status(rejected, 422)
        assert rejected.json()["detail"]["code"] == "student_album_name_too_long"
        preserved = _project_students(client, source_project_id)["來源名冊姓名"]
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
