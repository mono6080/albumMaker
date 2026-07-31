# 渲染 revision guard：舊工作不得在模板同步後重新發布 PDF/JPG/output_filename

import json
import threading
from typing import cast

import pytest
from fastapi import HTTPException

from database import (
    Campus,
    Classroom,
    ClassroomMember,
    ClassroomTeacher,
    Project,
    RosterChild,
    SessionLocal,
    Student,
    Template,
    TemplatePage,
    TemplatePeriod,
    User,
    init_db,
    utc_now,
)
from migrations import run_migrations
from services import (
    organization_service,
    project_lifecycle_service,
    project_student_service,
    student_render_service,
)
from services.output_keys import (
    build_combined_stem,
    get_project_output_prefix,
    get_student_image_key,
    get_student_pdf_key,
    student_pdf_key_for_mode,
)
from services.storage import LocalStorageAdapter
from services.student_pages import lock_student_page_writes
from services.template_sync_locks import lock_project_content_writes, lock_template_write
from tests.helpers import current_semester_id, login, started_client, unique_name


_SCHEMA_READY = False


def _seed_render_target() -> dict:
    global _SCHEMA_READY
    init_db()
    if not _SCHEMA_READY:
        run_migrations()
        _SCHEMA_READY = True
    db = SessionLocal()
    try:
        period = TemplatePeriod(
            name=unique_name("render_guard_period"),
            department="infant",
            status="active",
        )
        db.add(period)
        db.flush()
        template = Template(
            name=unique_name("render_guard_template"),
            revision=1,
            period_id=period.id,
        )
        db.add(template)
        db.flush()
        db.add(TemplatePage(
            template_id=template.id,
            page_number=0,
            layout_json=json.dumps({
                "canvas_width": 794,
                "canvas_height": 1123,
                "photo_slots": [],
                "text_labels": [],
                "stickers": [],
            }),
        ))
        project = Project(
            name=unique_name("render_guard_project"),
            template_id=template.id,
            department=period.department,
            template_period_id=period.id,
            template_revision=1,
            label_texts_json="{}",
        )
        db.add(project)
        db.flush()
        student = Student(
            project_id=project.id,
            name=unique_name("student"),
            order_index=0,
            pages_data_json="[]",
        )
        db.add(student)
        db.commit()
        return {
            "template_id": template.id,
            "project_id": project.id,
            "student_id": student.id,
            "project_name": project.name,
            "student_name": student.name,
        }
    finally:
        db.close()


def _add_colliding_student(
    seeded: dict,
    *,
    first_name: str,
    second_name: str,
) -> int:
    db = SessionLocal()
    try:
        first_student = db.get(Student, seeded["student_id"])
        first_student.name = first_name
        second_student = Student(
            project_id=seeded["project_id"],
            name=second_name,
            order_index=1,
            pages_data_json="[]",
        )
        db.add(second_student)
        db.commit()
        return second_student.id
    finally:
        db.close()


def _seed_legacy_collision_outputs(
    seeded: dict,
    second_student_id: int,
    storage,
) -> dict[str, str]:
    output_prefix = get_project_output_prefix(seeded["project_id"])
    first_stem = build_combined_stem(seeded["project_name"], "小明")
    second_stem = build_combined_stem(seeded["project_name"], "小明_screen")
    first_print_key = f"{output_prefix}/{first_stem}.pdf"
    shared_key = f"{output_prefix}/{first_stem}_screen.pdf"
    second_print_key = f"{output_prefix}/{second_stem}.pdf"
    assert shared_key == second_print_key
    second_screen_key = f"{output_prefix}/{second_stem}_screen.pdf"
    first_image_key = f"{output_prefix}/{first_stem}/images/print/page1.jpg"
    second_image_key = f"{output_prefix}/{second_stem}/images/print/page1.jpg"

    storage.put(first_print_key, b"first-print")
    storage.put(shared_key, b"second-print")
    storage.put(second_screen_key, b"second-screen")
    storage.put(first_image_key, b"first-image")
    storage.put(second_image_key, b"second-image")

    db = SessionLocal()
    try:
        db.get(Student, seeded["student_id"]).output_filename = first_print_key
        db.get(Student, second_student_id).output_filename = second_print_key
        db.commit()
    finally:
        db.close()
    return {
        "first_print": first_print_key,
        "shared": shared_key,
        "second_screen": second_screen_key,
        "first_image": first_image_key,
        "second_image": second_image_key,
    }


def _patch_fast_render(monkeypatch, render_album):
    monkeypatch.setattr(student_render_service, "render_album", render_album)
    monkeypatch.setattr(
        student_render_service,
        "derive_screen_images",
        lambda rendered_images: [f"screen:{image}" for image in rendered_images],
    )
    monkeypatch.setattr(
        student_render_service,
        "save_album_pdf",
        lambda rendered_images, mode: f"new-{mode}-pdf".encode(),
    )
    monkeypatch.setattr(
        student_render_service,
        "save_album_images",
        lambda rendered_images, stem, mode: {
            f"{stem}{'_screen' if mode == 'screen' else ''}_page1.jpg":
                f"new-{mode}-jpg".encode()
        },
    )


def _run_render(
    project_id: int,
    student_id: int,
    result: dict,
    actor_id: int | None = None,
) -> None:
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        student = db.get(Student, student_id)
        result["value"] = student_render_service.render_and_save_student_album(
            project,
            student,
            project_id,
            db,
            actor_id=actor_id,
        )
    except BaseException as error:
        result["error"] = error
    finally:
        db.close()


def _attach_render_teacher_scope(seeded: dict) -> dict[str, int]:
    """把直接 seed 的渲染目標歸班，並建立可在渲染途中撤除的任教編制。"""
    db = SessionLocal()
    try:
        admin = User(
            username=unique_name("render_admin"),
            display_name="渲染管理員",
            hashed_password="unused",
            role="admin",
        )
        teacher = User(
            username=unique_name("render_teacher"),
            display_name="渲染老師",
            hashed_password="unused",
            role="teacher",
        )
        campus = Campus(name=unique_name("render_campus"))
        db.add_all([admin, teacher, campus])
        db.flush()
        classroom = Classroom(
            semester_id=current_semester_id(db),
            campus_id=campus.id,
            department="infant",
            name=unique_name("render_classroom"),
        )
        db.add(classroom)
        db.flush()
        db.add(ClassroomTeacher(
            classroom_id=classroom.id,
            teacher_id=teacher.id,
            teacher_name_snapshot=teacher.display_name,
            duty="lead",
            started_by_id=admin.id,
            started_by_name_snapshot=admin.display_name,
        ))
        db.commit()
        # 舊相本歸班機制已退場，直接把相本掛到班級與工作格
        from database import SemesterPeriod, ClassPeriodWorkSlot, Project
        from services.organization_service import _ensure_current_term_classroom_grid

        _ensure_current_term_classroom_grid(db, classroom)
        db.flush()
        project = db.get(Project, seeded["project_id"])
        work_slot = (
            db.query(ClassPeriodWorkSlot)
            .join(
                SemesterPeriod,
                SemesterPeriod.id == ClassPeriodWorkSlot.semester_period_id,
            )
            .filter(
                ClassPeriodWorkSlot.classroom_id == classroom.id,
                SemesterPeriod.template_period_id == project.template_period_id,
            )
            .first()
        )
        if work_slot is None:
            semester_period = (
                db.query(SemesterPeriod)
                .filter(
                    SemesterPeriod.semester_id == classroom.semester_id,
                    SemesterPeriod.template_period_id
                    == project.template_period_id,
                )
                .first()
            )
            if semester_period is None:
                semester_period = SemesterPeriod(
                    semester_id=classroom.semester_id,
                    template_period_id=project.template_period_id,
                    period_name_snapshot="render_guard_period",
                    department=classroom.department,
                    position=(
                        db.query(SemesterPeriod)
                        .filter(
                            SemesterPeriod.semester_id
                            == classroom.semester_id
                        )
                        .count()
                    ),
                )
                db.add(semester_period)
                db.flush()
            work_slot = ClassPeriodWorkSlot(
                classroom_id=classroom.id,
                semester_period_id=semester_period.id,
            )
            db.add(work_slot)
            db.flush()
        work_slot.started_at = work_slot.started_at or utc_now()
        # 已歸班的相本學生一定對應到班上的名冊孩子；要趕在相本歸班前接上，
        # 之後 trg_students_freeze_class_backed_identity 就不允許再改 identity。
        student = db.get(Student, seeded["student_id"])
        roster_child = RosterChild(name=student.name)
        db.add(roster_child)
        db.flush()
        db.add(ClassroomMember(
            classroom_id=classroom.id,
            roster_child_id=roster_child.id,
        ))
        student.roster_child_id = roster_child.id
        db.flush()
        project.classroom_id = classroom.id
        project.class_period_work_slot_id = work_slot.id
        project.campus_id_snapshot = campus.id
        project.campus_name_snapshot = campus.name
        project.classroom_name_snapshot = classroom.name
        project.department = classroom.department
        db.commit()
        return {
            "admin_id": cast(int, admin.id),
            "teacher_id": cast(int, teacher.id),
            "classroom_id": cast(int, classroom.id),
        }
    finally:
        db.close()


def test_album_name_is_captured_in_render_cas_token():
    seeded = _seed_render_target()
    db = SessionLocal()
    try:
        student = db.get(Student, seeded["student_id"])
        student.album_name = "原本稱呼"
        db.commit()

        captured = student_render_service._capture_student_render_input(
            seeded["project_id"],
            seeded["student_id"],
            db,
        )
        assert captured["album_name"] == "原本稱呼"

        student = db.get(Student, seeded["student_id"])
        student.album_name = "渲染途中改名"
        db.commit()

        assert student_render_service._current_student_render_token(
            seeded["project_id"],
            seeded["student_id"],
            db,
        ) != captured["state_token"]
    finally:
        db.close()


class _BlockingPublishStorage(LocalStorageAdapter):
    """CAS 通過後卡住第一個 canonical put，供 mutation 鎖契約測試。"""

    def __init__(self, base_dir):
        super().__init__(base_dir)
        self.publish_started = threading.Event()
        self.allow_publish = threading.Event()

    def put(self, key: str, data: bytes) -> None:
        if data == b"new-print-pdf":
            self.publish_started.set()
            assert self.allow_publish.wait(5), "測試未釋放 canonical publish"
        super().put(key, data)


class _BlockingPhotoCleanupStorage(LocalStorageAdapter):
    """卡住學生照片清理，供驗證 project lock 涵蓋完整刪除流程。"""

    def __init__(self, base_dir, photo_prefix: str):
        super().__init__(base_dir)
        self.photo_prefix = photo_prefix
        self.photo_cleanup_started = threading.Event()
        self.allow_photo_cleanup = threading.Event()

    def delete_prefix(self, prefix: str) -> None:
        if prefix == self.photo_prefix:
            self.photo_cleanup_started.set()
            assert self.allow_photo_cleanup.wait(5), "測試未釋放學生照片清理"
        super().delete_prefix(prefix)


class _FailingOutputCleanupStorage(LocalStorageAdapter):
    """模擬 canonical output 刪除失敗，並記錄後續 namespace 清理。"""

    def __init__(self, base_dir):
        super().__init__(base_dir)
        self.output_cleanup_failed = False
        self.deleted_prefixes: list[str] = []

    def delete(self, key: str) -> None:
        if "/output/" in key:
            self.output_cleanup_failed = True
            raise RuntimeError("simulated output cleanup failure")
        super().delete(key)

    def delete_prefix(self, prefix: str) -> None:
        if "/output/" in prefix:
            self.output_cleanup_failed = True
            raise RuntimeError("simulated output cleanup failure")
        self.deleted_prefixes.append(prefix)
        super().delete_prefix(prefix)


def test_archived_project_during_render_cannot_publish(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)

    render_started = threading.Event()
    allow_render_finish = threading.Event()

    def controlled_render(*args, **kwargs):
        render_started.set()
        assert allow_render_finish.wait(5), "測試未釋放渲染工作"
        return ["stale-print-image"]

    _patch_fast_render(monkeypatch, controlled_render)
    render_result: dict = {}
    render_thread = threading.Thread(
        target=_run_render,
        args=(seeded["project_id"], seeded["student_id"], render_result),
    )
    render_thread.start()
    assert render_started.wait(5)

    db = SessionLocal()
    try:
        db.get(Project, seeded["project_id"]).deleted_at = utc_now()
        db.commit()
    finally:
        db.close()

    allow_render_finish.set()
    render_thread.join(5)
    assert not render_thread.is_alive()
    assert isinstance(render_result.get("error"), HTTPException)
    assert render_result["error"].status_code == 404

    db = SessionLocal()
    try:
        assert db.get(Student, seeded["student_id"]).output_filename is None
    finally:
        db.close()
    assert storage.list_keys(get_project_output_prefix(seeded["project_id"])) == []


def test_teacher_removed_during_render_cannot_publish(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    scope = _attach_render_teacher_scope(seeded)
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)

    render_started = threading.Event()
    allow_render_finish = threading.Event()

    def controlled_render(*args, **kwargs):
        render_started.set()
        assert allow_render_finish.wait(5), "測試未釋放渲染工作"
        return ["stale-print-image"]

    _patch_fast_render(monkeypatch, controlled_render)
    render_result: dict = {}
    render_thread = threading.Thread(
        target=_run_render,
        args=(
            seeded["project_id"],
            seeded["student_id"],
            render_result,
            scope["teacher_id"],
        ),
    )
    render_thread.start()
    assert render_started.wait(5)

    db = SessionLocal()
    try:
        admin = db.get(User, scope["admin_id"])
        organization_service.replace_classroom_teachers(
            db,
            admin,
            scope["classroom_id"],
            [],
        )
    finally:
        db.close()

    allow_render_finish.set()
    render_thread.join(5)
    assert not render_thread.is_alive()
    assert isinstance(render_result.get("error"), HTTPException)
    assert render_result["error"].status_code == 403

    db = SessionLocal()
    try:
        assert db.get(Student, seeded["student_id"]).output_filename is None
    finally:
        db.close()
    assert storage.list_keys(get_project_output_prefix(seeded["project_id"])) == []


def test_assigned_album_name_write_is_rejected_before_mutation():
    seeded = _seed_render_target()
    scope = _attach_render_teacher_scope(seeded)
    db = SessionLocal()
    try:
        actor = db.get(User, scope["teacher_id"])
        with pytest.raises(HTTPException) as error:
            project_student_service.update_student_album_name(
                db,
                actor,
                seeded["project_id"],
                seeded["student_id"],
                "不得寫入相本快照",
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "roster_album_name_authority"
        assert db.get(Student, seeded["student_id"]).album_name is None
    finally:
        db.close()


def test_roster_album_name_is_captured_in_assigned_render_cas_token():
    seeded = _seed_render_target()
    _attach_render_teacher_scope(seeded)
    db = SessionLocal()
    try:
        student = db.get(Student, seeded["student_id"])
        roster_child = db.get(RosterChild, student.roster_child_id)
        roster_child.album_name = "園所原稱呼"
        db.commit()

        captured = student_render_service._capture_student_render_input(
            seeded["project_id"],
            seeded["student_id"],
            db,
        )
        assert captured["album_name"] == "園所原稱呼"

        roster_child = db.get(RosterChild, student.roster_child_id)
        roster_child.album_name = "園所新稱呼"
        db.commit()

        assert student_render_service._current_student_render_token(
            seeded["project_id"],
            seeded["student_id"],
            db,
        ) != captured["state_token"]
    finally:
        db.close()


def test_completed_project_teacher_can_render_handoff_files(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    scope = _attach_render_teacher_scope(seeded)
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    _patch_fast_render(monkeypatch, lambda *args, **kwargs: ["print-image"])

    db = SessionLocal()
    try:
        db.get(Project, seeded["project_id"]).completed_at = utc_now()
        db.commit()
    finally:
        db.close()

    render_result: dict = {}
    _run_render(
        seeded["project_id"],
        seeded["student_id"],
        render_result,
        scope["teacher_id"],
    )

    assert "error" not in render_result
    assert render_result["value"]["pdf"] == get_student_pdf_key(
        seeded["project_id"],
        seeded["student_id"],
    )


def test_template_sync_can_finish_during_render_and_old_render_cannot_publish(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)

    combined_stem = build_combined_stem(seeded["project_name"], seeded["student_name"])
    output_prefix = get_project_output_prefix(seeded["project_id"])
    print_key = f"{output_prefix}/{combined_stem}.pdf"
    screen_key = f"{output_prefix}/{combined_stem}_screen.pdf"
    old_image_key = f"{output_prefix}/{combined_stem}/images/print/old_page1.jpg"
    render_hash_key = f"{output_prefix}/{combined_stem}/.render_state"
    storage.put(print_key, b"previous-print-pdf")
    storage.put(screen_key, b"previous-screen-pdf")
    storage.put(old_image_key, b"previous-jpg")
    storage.put(render_hash_key, b"previous-render-hash")

    db = SessionLocal()
    try:
        student = db.get(Student, seeded["student_id"])
        student.output_filename = print_key
        db.commit()
    finally:
        db.close()

    render_started = threading.Event()
    allow_render_finish = threading.Event()

    def controlled_render(*args, **kwargs):
        render_started.set()
        assert allow_render_finish.wait(5), "測試未釋放渲染工作"
        return ["stale-print-image"]

    _patch_fast_render(monkeypatch, controlled_render)
    render_result: dict = {}
    render_thread = threading.Thread(
        target=_run_render,
        args=(seeded["project_id"], seeded["student_id"], render_result),
    )
    render_thread.start()
    assert render_started.wait(5)

    sync_finished = threading.Event()
    sync_error: list[BaseException] = []

    def finish_template_sync():
        sync_db = SessionLocal()
        try:
            with (
                lock_template_write(seeded["template_id"]),
                lock_project_content_writes([seeded["project_id"]]),
                lock_student_page_writes([seeded["student_id"]]),
            ):
                template = sync_db.get(Template, seeded["template_id"])
                project = sync_db.get(Project, seeded["project_id"])
                student = sync_db.get(Student, seeded["student_id"])
                template.revision = 2
                project.template_revision = 2
                student.output_filename = None
                sync_db.commit()
        except BaseException as error:
            sync_error.append(error)
        finally:
            sync_db.close()
            sync_finished.set()

    sync_thread = threading.Thread(target=finish_template_sync)
    sync_thread.start()
    # 慢渲染不得長時間持 template/project/student content locks。
    assert sync_finished.wait(5)
    assert sync_error == []

    allow_render_finish.set()
    render_thread.join(5)
    sync_thread.join(5)
    assert not render_thread.is_alive()
    assert isinstance(render_result.get("error"), HTTPException)
    assert render_result["error"].status_code == 409
    assert render_result["error"].detail["code"] == "render_input_changed"

    db = SessionLocal()
    try:
        assert db.get(Student, seeded["student_id"]).output_filename is None
    finally:
        db.close()
    assert storage.get_bytes(print_key) == b"previous-print-pdf"
    assert storage.get_bytes(screen_key) == b"previous-screen-pdf"
    assert storage.get_bytes(old_image_key) == b"previous-jpg"
    assert storage.get_bytes(render_hash_key) == b"previous-render-hash"
    assert not any(
        storage.get_bytes(key).startswith(b"new-")
        for key in storage.list_keys(output_prefix)
    )


def test_same_student_renders_are_serialized_and_second_uses_completed_output(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)

    first_render_started = threading.Event()
    allow_first_render_finish = threading.Event()
    second_call_started = threading.Event()
    second_call_finished = threading.Event()
    render_call_count = 0
    render_call_count_lock = threading.Lock()

    def controlled_render(*args, **kwargs):
        nonlocal render_call_count
        with render_call_count_lock:
            render_call_count += 1
        first_render_started.set()
        assert allow_first_render_finish.wait(5), "測試未釋放第一個渲染工作"
        return ["print-image"]

    _patch_fast_render(monkeypatch, controlled_render)
    first_result: dict = {}
    second_result: dict = {}
    first_thread = threading.Thread(
        target=_run_render,
        args=(seeded["project_id"], seeded["student_id"], first_result),
    )
    first_thread.start()
    assert first_render_started.wait(5)

    def run_second_render():
        second_call_started.set()
        _run_render(seeded["project_id"], seeded["student_id"], second_result)
        second_call_finished.set()

    second_thread = threading.Thread(target=run_second_render)
    second_thread.start()
    assert second_call_started.wait(5)
    assert not second_call_finished.wait(0.2)
    assert render_call_count == 1

    allow_first_render_finish.set()
    first_thread.join(5)
    second_thread.join(5)
    assert not first_thread.is_alive()
    assert not second_thread.is_alive()
    assert "error" not in first_result
    assert "error" not in second_result
    assert first_result["value"].get("skipped") is not True
    assert second_result["value"]["skipped"] is True
    assert render_call_count == 1


def test_suffix_name_students_publish_to_distinct_mode_namespaces(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    second_student_id = _add_colliding_student(
        seeded,
        first_name="小明",
        second_name="小明_screen",
    )
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    _patch_fast_render(monkeypatch, lambda *args, **kwargs: ["print-image"])

    first_result: dict = {}
    second_result: dict = {}
    _run_render(seeded["project_id"], seeded["student_id"], first_result)
    _run_render(seeded["project_id"], second_student_id, second_result)

    assert "error" not in first_result
    assert "error" not in second_result
    first_screen_key = get_student_pdf_key(
        seeded["project_id"],
        seeded["student_id"],
    )
    first_screen_key = student_pdf_key_for_mode(
        first_screen_key,
        "screen",
    )
    second_print_key = get_student_pdf_key(
        seeded["project_id"],
        second_student_id,
    )
    assert first_screen_key != second_print_key
    assert storage.get_bytes(first_screen_key) == b"new-screen-pdf"
    assert storage.get_bytes(second_print_key) == b"new-print-pdf"


def test_same_name_students_use_id_namespaces_and_keep_independent_dirty_skip(
    monkeypatch,
    tmp_path,
):
    seeded = _seed_render_target()
    second_student_id = _add_colliding_student(
        seeded,
        first_name="同名學生",
        second_name="同名學生",
    )
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    render_call_count = 0

    def fast_render(*args, **kwargs):
        nonlocal render_call_count
        render_call_count += 1
        return ["print-image"]

    _patch_fast_render(monkeypatch, fast_render)
    first_result: dict = {}
    second_result: dict = {}
    repeated_first_result: dict = {}
    _run_render(seeded["project_id"], seeded["student_id"], first_result)
    _run_render(seeded["project_id"], second_student_id, second_result)
    _run_render(seeded["project_id"], seeded["student_id"], repeated_first_result)

    first_print_key = get_student_pdf_key(
        seeded["project_id"],
        seeded["student_id"],
    )
    second_print_key = get_student_pdf_key(
        seeded["project_id"],
        second_student_id,
    )
    assert first_print_key != second_print_key
    assert first_result["value"]["pdf"] == first_print_key
    assert second_result["value"]["pdf"] == second_print_key
    assert repeated_first_result["value"]["skipped"] is True
    assert render_call_count == 2


def test_first_canonical_render_preserves_legacy_key_referenced_by_sibling(
    monkeypatch,
    tmp_path,
):
    seeded = _seed_render_target()
    second_student_id = _add_colliding_student(
        seeded,
        first_name="小明",
        second_name="小明_screen",
    )
    storage = LocalStorageAdapter(tmp_path / "uploads")
    legacy_keys = _seed_legacy_collision_outputs(
        seeded,
        second_student_id,
        storage,
    )
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    _patch_fast_render(monkeypatch, lambda *args, **kwargs: ["print-image"])

    render_result: dict = {}
    _run_render(seeded["project_id"], seeded["student_id"], render_result)

    assert "error" not in render_result
    assert not storage.exists(legacy_keys["first_print"])
    assert storage.get_bytes(legacy_keys["shared"]) == b"second-print"
    assert storage.get_bytes(legacy_keys["second_screen"]) == b"second-screen"
    assert not storage.exists(legacy_keys["first_image"])
    assert storage.get_bytes(legacy_keys["second_image"]) == b"second-image"
    db = SessionLocal()
    try:
        first_student = db.get(Student, seeded["student_id"])
        second_student = db.get(Student, second_student_id)
        assert first_student.output_filename == get_student_pdf_key(
            seeded["project_id"],
            seeded["student_id"],
        )
        assert second_student.output_filename == legacy_keys["shared"]
    finally:
        db.close()


def test_album_name_mutation_preserves_colliding_legacy_sibling_output(
    monkeypatch,
    tmp_path,
):
    seeded = _seed_render_target()
    second_student_id = _add_colliding_student(
        seeded,
        first_name="小明",
        second_name="小明_screen",
    )
    storage = LocalStorageAdapter(tmp_path / "uploads")
    legacy_keys = _seed_legacy_collision_outputs(
        seeded,
        second_student_id,
        storage,
    )
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        response = client.put(
            f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}/album-name",
            json={"album_name": "相本小名"},
        )
        assert response.status_code == 200

    assert not storage.exists(legacy_keys["first_print"])
    assert storage.get_bytes(legacy_keys["shared"]) == b"second-print"
    assert storage.get_bytes(legacy_keys["second_screen"]) == b"second-screen"
    assert not storage.exists(legacy_keys["first_image"])
    assert storage.get_bytes(legacy_keys["second_image"]) == b"second-image"


@pytest.mark.parametrize("missing_output", ["screen_pdf", "print_image", "screen_image"])
def test_dirty_skip_rebuilds_when_any_promised_output_is_missing(
    monkeypatch,
    tmp_path,
    missing_output,
):
    seeded = _seed_render_target()
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    render_call_count = 0

    def fast_render(*args, **kwargs):
        nonlocal render_call_count
        render_call_count += 1
        return ["print-image"]

    _patch_fast_render(monkeypatch, fast_render)
    first_result = {}
    _run_render(seeded["project_id"], seeded["student_id"], first_result)
    assert "error" not in first_result
    assert render_call_count == 1

    missing_key_by_kind = {
        "screen_pdf": student_pdf_key_for_mode(
            get_student_pdf_key(
                seeded["project_id"],
                seeded["student_id"],
            ),
            "screen",
        ),
        "print_image": get_student_image_key(
            seeded["project_id"],
            seeded["student_id"],
            "print",
            1,
        ),
        "screen_image": get_student_image_key(
            seeded["project_id"],
            seeded["student_id"],
            "screen",
            1,
        ),
    }
    missing_key = missing_key_by_kind[missing_output]
    storage.delete(missing_key)
    assert not storage.exists(missing_key)

    second_result = {}
    _run_render(seeded["project_id"], seeded["student_id"], second_result)

    assert "error" not in second_result
    assert second_result["value"].get("skipped") is not True
    assert render_call_count == 2
    assert storage.exists(missing_key)


@pytest.mark.parametrize("mutation", ["project_rename", "album_name"])
def test_identity_text_mutation_waits_for_publish_then_invalidates_canonical_output(
    monkeypatch,
    tmp_path,
    mutation,
):
    seeded = _seed_render_target()
    # Windows MAX_PATH：combined stem 同時出現在目錄與檔名，測試 base 必須保持短。
    storage = _BlockingPublishStorage(tmp_path.parent / f"rl-{mutation}" / "u")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)
    monkeypatch.setattr(project_lifecycle_service, "get_storage", lambda: storage)
    _patch_fast_render(monkeypatch, lambda *args, **kwargs: ["print-image"])

    with started_client() as client:
        login(client)
        render_result: dict = {}
        render_thread = threading.Thread(
            target=_run_render,
            args=(seeded["project_id"], seeded["student_id"], render_result),
        )
        render_thread.start()
        assert storage.publish_started.wait(5)

        mutation_finished = threading.Event()
        mutation_response: dict = {}

        def run_mutation():
            if mutation == "project_rename":
                response = client.patch(
                    f"/api/projects/{seeded['project_id']}",
                    data={"name": "改名後專案"},
                )
            else:
                response = client.put(
                    f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}/album-name",
                    json={"album_name": "相本小名"},
                )
            mutation_response["response"] = response
            mutation_finished.set()

        mutation_thread = threading.Thread(target=run_mutation)
        mutation_thread.start()
        # publish 持有 project→student locks 時，名稱寫入不得插入 CAS 與 put 之間。
        assert not mutation_finished.wait(0.2)

        storage.allow_publish.set()
        render_thread.join(5)
        mutation_thread.join(5)
        assert not render_thread.is_alive()
        assert not mutation_thread.is_alive()
        if "error" in render_result:
            raise render_result["error"]
        assert mutation_response["response"].status_code == 200

    db = SessionLocal()
    try:
        project = db.get(Project, seeded["project_id"])
        student = db.get(Student, seeded["student_id"])
        if mutation == "project_rename":
            assert project.name == "改名後專案"
            assert student.output_filename is None
        else:
            assert student.name == seeded["student_name"]
            assert student.album_name == "相本小名"
            assert student.output_filename is None
    finally:
        db.close()

    assert storage.list_keys(get_project_output_prefix(seeded["project_id"])) == []


@pytest.mark.parametrize("mutation", ["project_rename", "album_name"])
def test_rename_stays_successful_when_output_cleanup_fails(
    monkeypatch,
    tmp_path,
    mutation,
):
    seeded = _seed_render_target()
    storage = _FailingOutputCleanupStorage(tmp_path / "uploads")
    monkeypatch.setattr(project_student_service, "get_storage", lambda: storage)
    monkeypatch.setattr(project_lifecycle_service, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        if mutation == "project_rename":
            response = client.patch(
                f"/api/projects/{seeded['project_id']}",
                data={"name": "清理失敗後的專案"},
            )
        else:
            response = client.put(
                f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}/album-name",
                json={"album_name": "清理失敗後的相本名"},
            )
        assert response.status_code == 200

    db = SessionLocal()
    try:
        project = db.get(Project, seeded["project_id"])
        student = db.get(Student, seeded["student_id"])
        if mutation == "project_rename":
            assert project.name == "清理失敗後的專案"
        else:
            assert student.name == seeded["student_name"]
            assert student.album_name == "清理失敗後的相本名"
        assert student.output_filename is None
    finally:
        db.close()
    assert storage.output_cleanup_failed
