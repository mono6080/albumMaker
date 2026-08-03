"""照片解碼期間學生被刪除並重用 ID 時，不可誤寫新學生。"""

import asyncio
import json
import threading
from datetime import timedelta

from database import SessionLocal, ProjectStudent
from services import project_photo_service
from services.storage_factory import get_storage
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


def _student_created_at(student_id: int):
    db = SessionLocal()
    try:
        return db.get(ProjectStudent, student_id).created_at
    finally:
        db.close()


def _insert_replacement_with_reused_id(
    project_id: int,
    deleted_student_id: int,
    original_created_at,
    *,
    name: str,
    order_index: int,
) -> None:
    db = SessionLocal()
    try:
        replacement = ProjectStudent(
            project_id=project_id,
            name=name,
            order_index=order_index,
            pages_data_json="[]",
            created_at=original_created_at + timedelta(microseconds=1),
        )
        db.add(replacement)
        db.commit()
        db.refresh(replacement)
        assert replacement.id == deleted_student_id
        assert replacement.created_at != original_created_at
    finally:
        db.close()


def _pause_photo_decode(monkeypatch):
    decode_started = threading.Event()
    allow_decode = threading.Event()
    original_decode = project_photo_service.read_and_process_photo_upload

    async def paused_decode(upload_file):
        decode_started.set()
        assert await asyncio.to_thread(allow_decode.wait, 10), "測試未釋放照片解碼"
        return await original_decode(upload_file)

    monkeypatch.setattr(
        project_photo_service,
        "read_and_process_photo_upload",
        paused_decode,
    )
    return decode_started, allow_decode


def _start_request(request):
    result: dict = {}

    def run_request() -> None:
        try:
            result["response"] = request()
        except BaseException as exc:
            result["error"] = exc

    request_thread = threading.Thread(target=run_request)
    request_thread.start()
    return request_thread, result


def _delete_student_directly(student_id: int) -> None:
    """模擬外部遷移在解碼期間替換學生 identity。"""
    db = SessionLocal()
    try:
        student = db.get(ProjectStudent, student_id)
        assert student is not None
        db.delete(student)
        db.commit()
    finally:
        db.close()


def test_single_photo_upload_rejects_reused_student_id_before_storage_write(
    monkeypatch,
    tmp_path,
):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        original_name = unique_name("original_student")
        project_id = create_project(
            client,
            template_id,
            name=unique_name("photo_identity"),
            student_names=[original_name],
        )
        original_student_id = _students_by_name(client, project_id)[original_name]["id"]
        original_created_at = _student_created_at(original_student_id)
        upload_url = revisioned_project_url(
            client,
            project_id,
            (
                f"/api/projects/{project_id}/students/{original_student_id}"
                "/pages/0/photos/1"
            ),
        )
        decode_started, allow_decode = _pause_photo_decode(monkeypatch)

        request_thread, result = _start_request(
            lambda: client.post(
                upload_url,
                files={
                    "file": (
                        "late-photo.jpg",
                        jpeg_bytes((30, 100, 180)),
                        "image/jpeg",
                    )
                },
            )
        )
        assert decode_started.wait(5)

        _delete_student_directly(original_student_id)
        replacement_name = unique_name("replacement_student")
        _insert_replacement_with_reused_id(
            project_id,
            original_student_id,
            original_created_at,
            name=replacement_name,
            order_index=0,
        )

        allow_decode.set()
        request_thread.join(5)
        assert not request_thread.is_alive()
        assert "error" not in result
        response = result["response"]
        assert_status(response, 409)
        assert response.json()["detail"] == {
            "code": "student_photo_target_changed",
            "message": "學生名單已變更，請重新整理後再上傳照片。",
            "student_id": original_student_id,
        }

    db = SessionLocal()
    try:
        replacement = db.get(ProjectStudent, original_student_id)
        assert replacement.name == replacement_name
        assert replacement.pages_data_json == "[]"
    finally:
        db.close()
    assert get_storage().list_keys(
        f"projects/proj{project_id}/photos/student{original_student_id}"
    ) == []


def test_batch_photo_upload_preflights_all_reused_student_ids_before_any_write(
    monkeypatch,
    tmp_path,
):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        stable_name = unique_name("stable_student")
        stale_name = unique_name("stale_student")
        project_id = create_project(
            client,
            template_id,
            name=unique_name("batch_identity"),
            student_names=[stable_name, stale_name],
        )
        students = _students_by_name(client, project_id)
        stable_student_id = students[stable_name]["id"]
        stale_student_id = students[stale_name]["id"]
        stale_created_at = _student_created_at(stale_student_id)
        upload_url = revisioned_project_url(
            client,
            project_id,
            f"/api/projects/{project_id}/photos/batch/pages/0/slots/1",
        )
        decode_started, allow_decode = _pause_photo_decode(monkeypatch)
        mapping = {
            str(stable_student_id): "stable.jpg",
            str(stale_student_id): "stale.jpg",
        }

        request_thread, result = _start_request(
            lambda: client.post(
                upload_url,
                data={
                    "mapping": json.dumps(mapping),
                    "overwrite_existing": "true",
                },
                files=[
                    (
                        "files",
                        ("stable.jpg", jpeg_bytes((20, 160, 80)), "image/jpeg"),
                    ),
                    (
                        "files",
                        ("stale.jpg", jpeg_bytes((180, 60, 40)), "image/jpeg"),
                    ),
                ],
            )
        )
        assert decode_started.wait(5)

        _delete_student_directly(stale_student_id)
        replacement_name = unique_name("batch_replacement")
        _insert_replacement_with_reused_id(
            project_id,
            stale_student_id,
            stale_created_at,
            name=replacement_name,
            order_index=1,
        )

        allow_decode.set()
        request_thread.join(5)
        assert not request_thread.is_alive()
        assert "error" not in result
        response = result["response"]
        assert_status(response, 409)
        assert response.json()["detail"]["code"] == "student_photo_target_changed"
        assert response.json()["detail"]["student_id"] == stale_student_id

    db = SessionLocal()
    try:
        stable_student = db.get(ProjectStudent, stable_student_id)
        replacement = db.get(ProjectStudent, stale_student_id)
        assert stable_student.pages_data_json == "[]"
        assert replacement.name == replacement_name
        assert replacement.pages_data_json == "[]"
    finally:
        db.close()
    assert get_storage().list_keys(f"projects/proj{project_id}/photos") == []
