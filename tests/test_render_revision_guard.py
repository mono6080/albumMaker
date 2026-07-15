# 渲染 revision guard：舊工作不得在模板同步後重新發布 PDF/JPG/output_filename

import json
import threading
from datetime import timedelta

import pytest
from fastapi import HTTPException

from database import Project, SessionLocal, Student, Template, TemplatePage, init_db
from routers.projects import crud as project_crud
from services import student_render_service
from services.output_keys import build_combined_stem, get_project_output_prefix
from services.storage import LocalStorageAdapter
from services.student_pages import lock_student_page_writes
from services.template_sync_locks import lock_project_content_writes, lock_template_write
from tests.helpers import login, started_client, unique_name


def _seed_render_target() -> dict:
    init_db()
    db = SessionLocal()
    try:
        template = Template(name=unique_name("render_guard_template"), revision=1)
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


def _run_render(project_id: int, student_id: int, result: dict) -> None:
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        student = db.get(Student, student_id)
        result["value"] = student_render_service.render_and_save_student_album(
            project, student, project_id, db
        )
    except BaseException as error:
        result["error"] = error
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
        self.deleted_prefixes.append(prefix)
        super().delete_prefix(prefix)


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


@pytest.mark.parametrize("mutation", ["project_rename", "student_rename", "student_delete"])
def test_rename_or_delete_waits_for_publish_then_invalidates_canonical_output(
    monkeypatch,
    tmp_path,
    mutation,
):
    seeded = _seed_render_target()
    # Windows MAX_PATH：combined stem 同時出現在目錄與檔名，測試 base 必須保持短。
    storage = _BlockingPublishStorage(tmp_path.parent / f"rl-{mutation}" / "u")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    monkeypatch.setattr(project_crud, "get_storage", lambda: storage)
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
            elif mutation == "student_rename":
                response = client.put(
                    f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}",
                    data={"name": "改名後學生"},
                )
            else:
                response = client.delete(
                    f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}"
                )
            mutation_response["response"] = response
            mutation_finished.set()

        mutation_thread = threading.Thread(target=run_mutation)
        mutation_thread.start()
        # publish 持有 project→student locks 時，改名／刪除不得插入 CAS 與 put 之間。
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
        elif mutation == "student_rename":
            assert student.name == "改名後學生"
            assert student.output_filename is None
        else:
            assert student is None
    finally:
        db.close()

    assert storage.list_keys(get_project_output_prefix(seeded["project_id"])) == []


def test_student_delete_holds_project_lock_until_photo_cleanup_finishes(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    photo_prefix = (
        f"projects/proj{seeded['project_id']}/photos/student{seeded['student_id']}"
    )
    storage = _BlockingPhotoCleanupStorage(tmp_path / "uploads", photo_prefix)
    monkeypatch.setattr(project_crud, "get_storage", lambda: storage)
    photo_key = f"{photo_prefix}/existing.jpg"
    storage.put(photo_key, b"photo")

    with started_client() as client:
        login(client)
        delete_result: dict = {}
        batch_result: dict = {}
        batch_finished = threading.Event()

        def run_delete():
            delete_result["response"] = client.delete(
                f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}"
            )

        def run_batch_add():
            batch_result["response"] = client.post(
                f"/api/projects/{seeded['project_id']}/students/batch",
                json=["清理期間新增"],
            )
            batch_finished.set()

        delete_thread = threading.Thread(target=run_delete)
        delete_thread.start()
        assert storage.photo_cleanup_started.wait(5)

        batch_thread = threading.Thread(target=run_batch_add)
        batch_thread.start()
        assert not batch_finished.wait(0.2)

        storage.allow_photo_cleanup.set()
        delete_thread.join(5)
        batch_thread.join(5)
        assert not delete_thread.is_alive()
        assert not batch_thread.is_alive()
        assert delete_result["response"].status_code == 200
        assert batch_result["response"].status_code == 200

    assert not storage.exists(photo_key)


def test_student_delete_stays_successful_when_output_cleanup_fails(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    storage = _FailingOutputCleanupStorage(tmp_path / "uploads")
    monkeypatch.setattr(project_crud, "get_storage", lambda: storage)
    photo_prefix = (
        f"projects/proj{seeded['project_id']}/photos/student{seeded['student_id']}"
    )
    photo_key = f"{photo_prefix}/existing.jpg"
    storage.put(photo_key, b"photo")

    with started_client() as client:
        login(client)
        response = client.delete(
            f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}"
        )
        assert response.status_code == 200

    db = SessionLocal()
    try:
        assert db.get(Student, seeded["student_id"]) is None
    finally:
        db.close()
    assert storage.output_cleanup_failed
    assert photo_prefix in storage.deleted_prefixes
    assert not storage.exists(photo_key)


def test_deleted_student_id_reuse_cannot_publish_old_render(monkeypatch, tmp_path):
    seeded = _seed_render_target()
    storage = LocalStorageAdapter(tmp_path / "uploads")
    monkeypatch.setattr(student_render_service, "get_storage", lambda: storage)
    monkeypatch.setattr(project_crud, "get_storage", lambda: storage)

    db = SessionLocal()
    try:
        original_student = db.get(Student, seeded["student_id"])
        original_created_at = original_student.created_at
    finally:
        db.close()

    render_started = threading.Event()
    allow_render_finish = threading.Event()

    def controlled_render(*args, **kwargs):
        render_started.set()
        assert allow_render_finish.wait(5), "測試未釋放舊學生渲染"
        return ["stale-print-image"]

    _patch_fast_render(monkeypatch, controlled_render)
    render_result: dict = {}

    with started_client() as client:
        login(client)
        render_thread = threading.Thread(
            target=_run_render,
            args=(seeded["project_id"], seeded["student_id"], render_result),
        )
        render_thread.start()
        assert render_started.wait(5)

        delete_response = client.delete(
            f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}"
        )
        assert delete_response.status_code == 200

        replacement_db = SessionLocal()
        try:
            replacement_db.add(Student(
                id=seeded["student_id"],
                project_id=seeded["project_id"],
                name=seeded["student_name"],
                order_index=0,
                pages_data_json="[]",
                created_at=original_created_at + timedelta(microseconds=1),
            ))
            replacement_db.commit()
        finally:
            replacement_db.close()

        allow_render_finish.set()
        render_thread.join(5)
        assert not render_thread.is_alive()

    assert isinstance(render_result.get("error"), HTTPException)
    assert render_result["error"].status_code == 409
    assert render_result["error"].detail["code"] == "render_input_changed"

    db = SessionLocal()
    try:
        replacement_student = db.get(Student, seeded["student_id"])
        assert replacement_student.name == seeded["student_name"]
        assert replacement_student.pages_data_json == "[]"
        assert replacement_student.created_at != original_created_at
        assert replacement_student.output_filename is None
    finally:
        db.close()
    assert storage.list_keys(get_project_output_prefix(seeded["project_id"])) == []


@pytest.mark.parametrize("mutation", ["project_rename", "student_rename"])
def test_rename_stays_successful_when_output_cleanup_fails(
    monkeypatch,
    tmp_path,
    mutation,
):
    seeded = _seed_render_target()
    storage = _FailingOutputCleanupStorage(tmp_path / "uploads")
    monkeypatch.setattr(project_crud, "get_storage", lambda: storage)

    with started_client() as client:
        login(client)
        if mutation == "project_rename":
            response = client.patch(
                f"/api/projects/{seeded['project_id']}",
                data={"name": "清理失敗後的專案"},
            )
        else:
            response = client.put(
                f"/api/projects/{seeded['project_id']}/students/{seeded['student_id']}",
                data={"name": "清理失敗後的學生"},
            )
        assert response.status_code == 200

    db = SessionLocal()
    try:
        project = db.get(Project, seeded["project_id"])
        student = db.get(Student, seeded["student_id"])
        if mutation == "project_rename":
            assert project.name == "清理失敗後的專案"
        else:
            assert student.name == "清理失敗後的學生"
        assert student.output_filename is None
    finally:
        db.close()
    assert storage.output_cleanup_failed
