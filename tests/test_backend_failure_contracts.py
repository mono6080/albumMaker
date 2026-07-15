"""結構重構前的 Storage／DB 失敗順序與鎖順序 characterization。"""

import threading
from contextlib import contextmanager

import pytest
from sqlalchemy.orm import Session as OrmSession

from database import Project, SessionLocal, Template, utc_now
from routers.projects import crud as project_crud
from services import template_sync_locks
from services.storage import get_storage
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    create_user,
    jpeg_bytes,
    login,
    png_bytes,
    revisioned_project_url,
    smoke_layout,
    started_client,
    template_revision,
    unique_name,
    use_tmp_uploads,
)


def _students_by_name(client, project_id: int) -> dict[str, dict]:
    response = client.get(f"/api/projects/{project_id}")
    assert_status(response, 200)
    return {student["name"]: student for student in response.json()["students"]}


def _photo_path(student: dict, page_index: int = 0, slot_id: int = 1) -> str | None:
    pages = student["pages_data"]
    if page_index >= len(pages):
        return None
    record = pages[page_index].get("photos", {}).get(str(slot_id))
    if not record:
        return None
    return record if isinstance(record, str) else record.get("path")


def _label_text(student: dict, page_index: int = 0, label_id: int = 1) -> str | None:
    pages = student["pages_data"]
    if page_index >= len(pages):
        return None
    return pages[page_index].get("label_texts", {}).get(str(label_id))


def test_single_photo_commit_failure_leaves_storage_orphan_without_database_binding(
    monkeypatch,
    tmp_path,
):
    """單張照片先寫 Storage；DB commit 失敗時目前會留下未綁定的新檔。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("single_commit_fail"))
        assert_status(
            client.post(f"/api/projects/{project_id}/students/batch", json=["Commit Failure"]),
            200,
        )
        student = _students_by_name(client, project_id)["Commit Failure"]
        storage = get_storage()

        def fail_commit(_session) -> None:
            raise RuntimeError("simulated single photo commit failure")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="single photo commit failure"):
                client.post(
                    revisioned_project_url(
                        client,
                        project_id,
                        f"/api/projects/{project_id}/students/{student['id']}/pages/0/photos/1",
                    ),
                    files={"file": ("orphan.jpg", jpeg_bytes(), "image/jpeg")},
                )

        updated = _students_by_name(client, project_id)["Commit Failure"]
        assert _photo_path(updated) is None
        orphan_keys = storage.list_keys(
            f"projects/proj{project_id}/photos/student{student['id']}"
        )
        assert len(orphan_keys) == 1
        assert storage.exists(orphan_keys[0])


def test_shared_photo_second_storage_failure_keeps_first_commit_and_stops_fanout(
    monkeypatch,
    tmp_path,
):
    """共用照片逐學生 commit；第 2 位失敗時第 1 位保留、第 3 位不處理。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("shared_partial"))
        names = ["Shared Before", "Shared Failure", "Shared After"]
        assert_status(client.post(f"/api/projects/{project_id}/students/batch", json=names), 200)
        storage = get_storage()
        original_copy = storage.copy
        copy_calls = 0

        def fail_first_copy(source_key: str, target_key: str) -> None:
            nonlocal copy_calls
            copy_calls += 1
            if copy_calls == 1:
                raise OSError("simulated shared photo second-student failure")
            original_copy(source_key, target_key)

        monkeypatch.setattr(storage, "copy", fail_first_copy)
        with pytest.raises(OSError, match="second-student failure"):
            client.post(
                revisioned_project_url(
                    client,
                    project_id,
                    f"/api/projects/{project_id}/photos/shared/pages/0/slots/1",
                ),
                files={"file": ("shared.jpg", jpeg_bytes((30, 90, 180)), "image/jpeg")},
            )

        updated = _students_by_name(client, project_id)
        first_path = _photo_path(updated["Shared Before"])
        assert first_path and storage.exists(first_path)
        assert _photo_path(updated["Shared Failure"]) is None
        assert _photo_path(updated["Shared After"]) is None
        assert copy_calls == 1


def test_copy_students_acquires_both_project_locks_in_sorted_order(monkeypatch):
    """跨專案複製固定由小到大拿 P 鎖，並以相反順序釋放。"""
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        first_project_id = create_project(client, template_id, name=unique_name("copy_lock_first"))
        second_project_id = create_project(client, template_id, name=unique_name("copy_lock_second"))
        assert_status(
            client.post(f"/api/projects/{first_project_id}/students/batch", json=["Lock Child"]),
            200,
        )

        acquired: list[int] = []
        released: list[int] = []

        class RecordingLock:
            def __init__(self, project_id: int):
                self.project_id = project_id

            def acquire(self) -> None:
                acquired.append(self.project_id)

            def release(self) -> None:
                released.append(self.project_id)

        def recording_lock_for(_registry, _guard, project_id: int):
            return RecordingLock(project_id)

        monkeypatch.setattr(template_sync_locks, "_lock_for", recording_lock_for)
        response = client.post(
            f"/api/projects/{second_project_id}/students/copy",
            json={"source_project_id": first_project_id},
        )

        assert_status(response, 200)
        expected_order = sorted([first_project_id, second_project_id])
        assert acquired == expected_order
        assert released == list(reversed(expected_order))
        assert response.json() == {"created": ["Lock Child"], "skipped": []}


def test_copy_students_rechecks_target_after_waiting_for_real_project_locks(monkeypatch):
    """等待 P 鎖期間 target 完成後，鎖內 rollback/requery 必須看到最新狀態並拒絕。"""
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, teacher_password = create_user(
            client,
            "teacher",
            supervisor_ids=[supervisor["id"]],
        )
        template_id, _ = create_template_with_page(client)

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        source_project_id = create_project(client, template_id, name=unique_name("copy_wait_source"))
        target_project_id = create_project(client, template_id, name=unique_name("copy_wait_target"))
        assert_status(
            client.post(f"/api/projects/{source_project_id}/students/batch", json=["Wait Child"]),
            200,
        )

        waiting_for_lock = threading.Event()
        real_project_locks = template_sync_locks.lock_project_content_writes

        @contextmanager
        def observed_project_locks(project_ids):
            waiting_for_lock.set()
            with real_project_locks(project_ids):
                yield

        monkeypatch.setattr(project_crud, "lock_project_content_writes", observed_project_locks)
        result: dict = {}

        def run_copy() -> None:
            try:
                result["response"] = client.post(
                    f"/api/projects/{target_project_id}/students/copy",
                    json={"source_project_id": source_project_id},
                )
            except BaseException as error:  # pragma: no cover - 失敗時帶回主執行緒斷言
                result["error"] = error

        with real_project_locks([source_project_id, target_project_id]):
            copy_thread = threading.Thread(target=run_copy)
            copy_thread.start()
            assert waiting_for_lock.wait(5), "copy request 未進入 P 鎖等待點"
            assert copy_thread.is_alive()

            concurrent_db = SessionLocal()
            try:
                target_project = concurrent_db.get(Project, target_project_id)
                assert target_project is not None
                target_project.completed_at = utc_now()
                concurrent_db.commit()
            finally:
                concurrent_db.close()

        copy_thread.join(5)
        assert not copy_thread.is_alive()
        assert "error" not in result
        assert_status(result["response"], 403)
        assert result["response"].json()["detail"] == (
            "專案已標記完成，內容已鎖定；需主管或管理員退回才能修改"
        )

        db = SessionLocal()
        try:
            target_project = db.get(Project, target_project_id)
            assert target_project is not None
            assert target_project.completed_at is not None
            assert target_project.students == []
        finally:
            db.close()


def test_template_copy_storage_mid_failure_rolls_back_database_but_leaves_prior_copy(
    monkeypatch,
    tmp_path,
):
    """模板複製中第 2 個素材失敗時 DB 全退，但先前複製的素材目前會殘留。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        source_template_id, source_page_id = create_template_with_page(client)
        background = client.post(
            f"/api/templates/{source_template_id}/pages/{source_page_id}/background",
            params={"expected_revision": template_revision(client, source_template_id)},
            files={"file": ("source-bg.png", png_bytes((24, 24)), "image/png")},
        )
        assert_status(background, 200)
        sticker = client.post(
            f"/api/templates/{source_template_id}/stickers",
            files={"file": ("source-sticker.png", png_bytes((40, 20)), "image/png")},
        )
        assert_status(sticker, 200)
        layout = smoke_layout()
        layout["stickers"] = [{
            "id": 7,
            "path": sticker.json()["path"],
            "filename": sticker.json()["filename"],
            "x": 12,
            "y": 18,
            "width": 40,
            "height": 20,
        }]
        assert_status(
            client.put(
                f"/api/templates/{source_template_id}/pages/{source_page_id}/layout",
                json=layout,
            ),
            200,
        )

        storage = get_storage()
        original_put = storage.put
        copied_target_keys: list[str] = []

        def fail_second_target_put(key: str, data: bytes) -> None:
            if key.startswith("templates/tmpl") and not key.startswith(
                f"templates/tmpl{source_template_id}/"
            ):
                copied_target_keys.append(key)
                if len(copied_target_keys) == 2:
                    raise OSError("simulated template copy storage failure")
            original_put(key, data)

        monkeypatch.setattr(storage, "put", fail_second_target_put)
        target_name = unique_name("copy_storage_fail")
        with pytest.raises(OSError, match="template copy storage failure"):
            client.post(
                "/api/templates/",
                data={"name": target_name, "source_template_id": str(source_template_id)},
            )

        assert len(copied_target_keys) == 2
        assert storage.exists(copied_target_keys[0])
        assert not storage.exists(copied_target_keys[1])

        db = SessionLocal()
        try:
            assert db.query(Template).filter(Template.name == target_name).first() is None
        finally:
            db.close()


def test_background_commit_failure_restores_database_and_deletes_new_storage_key(
    monkeypatch,
    tmp_path,
):
    """背景新檔先寫入；DB commit 失敗會 rollback 並刪除新 key，舊背景保留。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        first_upload = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/background",
            params={"expected_revision": template_revision(client, template_id)},
            files={"file": ("old-bg.png", png_bytes((24, 24), (20, 80, 140, 255)), "image/png")},
        )
        assert_status(first_upload, 200)
        old_key = first_upload.json()["filename"]
        revision_before_failure = template_revision(client, template_id)
        storage = get_storage()
        put_keys: list[str] = []
        original_put = storage.put

        def record_put(key: str, data: bytes) -> None:
            put_keys.append(key)
            original_put(key, data)

        def fail_commit(_session) -> None:
            raise RuntimeError("simulated background database commit failure")

        monkeypatch.setattr(storage, "put", record_put)
        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="background database commit failure"):
                client.post(
                    f"/api/templates/{template_id}/pages/{page_id}/background",
                    params={"expected_revision": revision_before_failure},
                    files={
                        "file": (
                            "new-bg.png",
                            png_bytes((24, 24), (180, 30, 60, 255)),
                            "image/png",
                        )
                    },
                )

        assert len(put_keys) == 1
        assert put_keys[0] != old_key
        assert storage.exists(old_key)
        assert not storage.exists(put_keys[0])
        assert template_revision(client, template_id) == revision_before_failure
        current_background = client.get(f"/api/templates/{template_id}/pages/{page_id}/background")
        assert_status(current_background, 200)
        assert current_background.content == storage.get_bytes(old_key)


def test_batch_text_second_commit_failure_keeps_first_and_stops_remaining_students(
    monkeypatch,
):
    """批次文字逐學生 commit；第 2 次失敗時第 1 位保留、第 3 位不處理。"""
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("batch_text_partial"))
        names = ["Text Before", "Text Failure", "Text After"]
        assert_status(client.post(f"/api/projects/{project_id}/students/batch", json=names), 200)
        students = _students_by_name(client, project_id)
        original_commit = OrmSession.commit
        commit_calls = 0

        def fail_second_commit(session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            if commit_calls == 2:
                raise RuntimeError("simulated batch text second commit failure")
            original_commit(session)

        payload = {
            "students": {
                str(students[name]["id"]): {"0": {"1": f"updated {name}"}}
                for name in names
            }
        }
        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_second_commit)
            with pytest.raises(RuntimeError, match="batch text second commit failure"):
                client.put(
                    revisioned_project_url(
                        client,
                        project_id,
                        f"/api/projects/{project_id}/batch/texts",
                    ),
                    json=payload,
                )

        updated = _students_by_name(client, project_id)
        assert _label_text(updated["Text Before"]) == "updated Text Before"
        assert _label_text(updated["Text Failure"]) is None
        assert _label_text(updated["Text After"]) is None
        assert commit_calls == 2


def test_template_period_update_persists_trimmed_name_and_status():
    """期別更新同一交易保存去空白名稱與狀態，回應與重新查詢一致。"""
    with started_client() as client:
        login(client)
        create_response = client.post(
            "/api/templates/periods",
            data={"name": unique_name("period_update"), "department": "academy", "status": "draft"},
        )
        assert_status(create_response, 200)
        period_id = create_response.json()["id"]
        updated_name = unique_name("updated_period")

        update_response = client.patch(
            f"/api/templates/periods/{period_id}",
            data={"name": f"  {updated_name}  ", "status": "active"},
        )

        assert_status(update_response, 200)
        assert update_response.json()["name"] == updated_name
        assert update_response.json()["status"] == "active"
        periods_response = client.get("/api/templates/periods", params={"department": "academy"})
        assert_status(periods_response, 200)
        persisted = next(period for period in periods_response.json() if period["id"] == period_id)
        assert persisted["name"] == updated_name
        assert persisted["status"] == "active"
