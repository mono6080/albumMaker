"""結構重構前的後端 partial-success 與 cleanup 行為釘選。"""

import importlib
import json
from datetime import datetime, timedelta, timezone

from database import Project, SessionLocal
from services import project_service
from services.storage import LocalStorageAdapter, get_storage
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    revisioned_project_url,
    started_client,
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


def test_batch_photo_upload_reports_success_skip_and_failure_then_continues(
    monkeypatch,
    tmp_path,
):
    """單筆 storage 寫入失敗不回滾前筆，也不阻止後續學生成功。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("batch_partial"))
        assert_status(
            client.post(
                f"/api/projects/{project_id}/students/batch",
                json=["Success Before", "Skip Existing", "Fail Middle", "Success After"],
            ),
            200,
        )
        students = _students_by_name(client, project_id)

        skip_student_id = students["Skip Existing"]["id"]
        existing_upload = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{skip_student_id}/pages/0/photos/1",
            ),
            files={"file": ("existing.jpg", jpeg_bytes((80, 100, 120)), "image/jpeg")},
        )
        assert_status(existing_upload, 200)
        existing_path = existing_upload.json()["path"]

        storage = get_storage()
        original_put = storage.put

        def fail_one_photo(key: str, data: bytes) -> None:
            if "fail-middle_" in key:
                raise OSError("simulated batch storage failure")
            original_put(key, data)

        monkeypatch.setattr(storage, "put", fail_one_photo)
        mapping = {
            str(students["Success Before"]["id"]): "success-before.jpg",
            str(skip_student_id): "skip-existing.jpg",
            str(students["Fail Middle"]["id"]): "fail-middle.jpg",
            str(students["Success After"]["id"]): "success-after.jpg",
        }
        batch_response = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/photos/batch/pages/0/slots/1",
            ),
            data={
                "mapping": json.dumps(mapping),
                "overwrite_existing": "false",
            },
            files=[
                ("files", ("success-before.jpg", jpeg_bytes((20, 120, 220)), "image/jpeg")),
                ("files", ("skip-existing.jpg", jpeg_bytes((220, 120, 20)), "image/jpeg")),
                ("files", ("fail-middle.jpg", jpeg_bytes((180, 30, 80)), "image/jpeg")),
                ("files", ("success-after.jpg", jpeg_bytes((30, 180, 80)), "image/jpeg")),
            ],
        )

        assert_status(batch_response, 200)
        payload = batch_response.json()
        assert [item["student_id"] for item in payload["succeeded"]] == [
            students["Success Before"]["id"],
            students["Success After"]["id"],
        ]
        assert payload["skipped"] == [{
            "student_id": skip_student_id,
            "filename": "skip-existing.jpg",
            "path": None,
            "reason": "already_has_photo",
        }]
        assert payload["failed"] == [{
            "student_id": students["Fail Middle"]["id"],
            "filename": "fail-middle.jpg",
            "path": None,
            "reason": "storage_write_failed",
        }]

        updated = _students_by_name(client, project_id)
        before_path = _photo_path(updated["Success Before"])
        after_path = _photo_path(updated["Success After"])
        assert before_path and storage.exists(before_path)
        assert after_path and storage.exists(after_path)
        assert _photo_path(updated["Skip Existing"]) == existing_path
        assert storage.exists(existing_path)
        assert _photo_path(updated["Fail Middle"]) is None


def test_expired_project_purge_commits_only_namespaces_cleaned_successfully(
    monkeypatch,
    tmp_path,
):
    """多專案 purge 中一筆 Storage cleanup 失敗時，只保留該專案 DB 資料。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        failed_project_id = create_project(client, template_id, name=unique_name("purge_fail"))
        purged_project_id = create_project(client, template_id, name=unique_name("purge_ok"))
        assert_status(client.delete(f"/api/projects/{failed_project_id}"), 200)
        assert_status(client.delete(f"/api/projects/{purged_project_id}"), 200)

    expired_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    db = SessionLocal()
    try:
        projects = (
            db.query(Project)
            .filter(Project.id.in_([failed_project_id, purged_project_id]))
            .all()
        )
        for project in projects:
            project.archive_expires_at = expired_at
        db.commit()

        class SelectiveCleanupStorage(LocalStorageAdapter):
            def __init__(self, base_dir, failed_prefix: str):
                super().__init__(base_dir)
                self.failed_prefix = failed_prefix
                self.calls = []

            def delete_prefix(self, key_prefix: str) -> None:
                self.calls.append(key_prefix)
                if key_prefix == self.failed_prefix:
                    raise OSError("simulated purge cleanup failure")
                super().delete_prefix(key_prefix)

        failed_prefix = f"projects/proj{failed_project_id}"
        purged_prefix = f"projects/proj{purged_project_id}"
        storage = SelectiveCleanupStorage(tmp_path / "uploads", failed_prefix)
        storage.put(f"{failed_prefix}/pin.txt", b"keep")
        storage.put(f"{purged_prefix}/pin.txt", b"remove")
        monkeypatch.setattr(project_service, "get_storage", lambda: storage)

        purged_ids = project_service.purge_expired_archived_projects(
            db,
            datetime.now(timezone.utc).replace(tzinfo=None),
        )

        assert purged_ids == [purged_project_id]
        assert set(storage.calls) == {failed_prefix, purged_prefix}
        db.expire_all()
        assert db.query(Project).filter(Project.id == failed_project_id).one()
        assert db.query(Project).filter(Project.id == purged_project_id).first() is None
        assert storage.exists(f"{failed_prefix}/pin.txt")
        assert not storage.exists(f"{purged_prefix}/pin.txt")
    finally:
        db.close()


def test_template_rename_keeps_namespace_and_delete_cleanup_is_best_effort(
    monkeypatch,
    tmp_path,
):
    """模板改名不碰 ID namespace；刪除先 commit DB，cleanup 失敗仍回成功。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        renamed_template_id, _ = create_template_with_page(client)
        cleanup_failure_template_id, _ = create_template_with_page(client)
        storage = get_storage()
        renamed_prefix = f"templates/tmpl{renamed_template_id}"
        failure_prefix = f"templates/tmpl{cleanup_failure_template_id}"
        renamed_asset = f"{renamed_prefix}/backgrounds/pin.bin"
        failed_cleanup_asset = f"{failure_prefix}/stickers/pin.bin"
        storage.put(renamed_asset, b"rename-keeps-this")
        storage.put(failed_cleanup_asset, b"cleanup-fails-keeps-this")

        original_delete_prefix = storage.delete_prefix
        cleanup_calls = []

        def track_or_fail_cleanup(key_prefix: str) -> None:
            cleanup_calls.append(key_prefix)
            if key_prefix == failure_prefix:
                raise OSError("simulated template cleanup failure")
            original_delete_prefix(key_prefix)

        monkeypatch.setattr(storage, "delete_prefix", track_or_fail_cleanup)

        rename_response = client.patch(
            f"/api/templates/{renamed_template_id}",
            data={"name": unique_name("renamed_template")},
        )
        assert_status(rename_response, 200)
        assert cleanup_calls == []
        assert storage.get_bytes(renamed_asset) == b"rename-keeps-this"

        normal_delete = client.delete(f"/api/templates/{renamed_template_id}")
        assert_status(normal_delete, 200)
        assert cleanup_calls == [renamed_prefix]
        assert not storage.exists(renamed_asset)
        assert_status(client.get(f"/api/templates/{renamed_template_id}"), 404)

        cleanup_failure_delete = client.delete(f"/api/templates/{cleanup_failure_template_id}")
        assert_status(cleanup_failure_delete, 200)
        assert cleanup_calls == [renamed_prefix, failure_prefix]
        assert_status(client.get(f"/api/templates/{cleanup_failure_template_id}"), 404)
        assert storage.get_bytes(failed_cleanup_asset) == b"cleanup-fails-keeps-this"


def test_render_all_students_continues_after_one_student_fails(monkeypatch):
    """批次渲染中間一位失敗時，前後學生仍各自列入成功結果。"""
    render_router = importlib.import_module("routers.projects.render")

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("render_partial"))
        names = ["Render Before", "Render Failure", "Render After"]
        assert_status(
            client.post(f"/api/projects/{project_id}/students/batch", json=names),
            200,
        )
        render_calls = []

        def fake_render(project, student, requested_project_id, db):
            del project, db
            assert requested_project_id == project_id
            render_calls.append(student.name)
            if student.name == "Render Failure":
                raise RuntimeError("simulated render failure")
            return {"pdf": f"outputs/{student.name}.pdf", "pages": 1}

        monkeypatch.setattr(render_router, "render_and_save_student_album", fake_render)

        response = client.post(f"/api/projects/{project_id}/render/all")

        assert_status(response, 200)
        assert render_calls == names
        assert response.json() == {
            "rendered": [
                {"student": "Render Before", "pdf": "outputs/Render Before.pdf"},
                {"student": "Render After", "pdf": "outputs/Render After.pdf"},
            ],
            "errors": [{"student": "Render Failure", "error": "產生失敗"}],
        }
