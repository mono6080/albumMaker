import json
import threading
from contextlib import contextmanager

from database import Project, SessionLocal, Template
from services import project_template_revision as revision_service
from services.storage import get_storage
from services.template_sync_locks import lock_template_write
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    project_template_revision,
    revisioned_project_url,
    started_client,
    template_revision,
    use_tmp_uploads,
)


def _stale_url(url: str, revision: int) -> str:
    return f"{url}?expected_template_revision={revision}"


def _assert_revision_conflict(response) -> None:
    assert_status(response, 409)
    assert response.json()["detail"]["code"] == "project_template_revision_changed"


def test_stale_project_content_mutations_leave_db_and_storage_unchanged(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        project_id = create_project(client, template_id)
        assert_status(client.post(f"/api/projects/{project_id}/students/batch", json=["Revision Student"]), 200)
        student_id = client.get(f"/api/projects/{project_id}").json()["students"][0]["id"]
        stale_revision = project_template_revision(client, project_id)

        initial_upload = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
            ),
            files={"file": ("initial.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(initial_upload, 200)
        initial_path = initial_upload.json()["path"]

        background = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/background",
            params={"expected_revision": template_revision(client, template_id)},
            files={"file": ("revision.jpg", jpeg_bytes((80, 120, 200)), "image/jpeg")},
        )
        assert_status(background, 200)
        assert project_template_revision(client, project_id) > stale_revision

        baseline_project = client.get(f"/api/projects/{project_id}").json()
        baseline_storage_keys = get_storage().list_keys(f"projects/proj{project_id}/")

        responses = [
            client.put(
                _stale_url(f"/api/projects/{project_id}/label_texts", stale_revision),
                json={"0": {"1": "stale project text"}},
            ),
            client.put(
                _stale_url(
                    f"/api/projects/{project_id}/students/{student_id}/pages/0/texts",
                    stale_revision,
                ),
                json={"1": "stale student text"},
            ),
            client.put(
                _stale_url(f"/api/projects/{project_id}/batch/texts", stale_revision),
                json={"students": {str(student_id): {"0": {"1": "stale batch text"}}}},
            ),
            client.patch(
                _stale_url(
                    f"/api/projects/{project_id}/students/{student_id}/pages/0/skip",
                    stale_revision,
                ),
                json={"skip": True},
            ),
            client.put(
                _stale_url(
                    f"/api/projects/{project_id}/students/{student_id}/photos/mapping",
                    stale_revision,
                ),
                json={"pages": {"0": {"1": None}}},
            ),
            client.post(
                _stale_url(
                    f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
                    stale_revision,
                ),
                files={"file": ("stale-single.jpg", jpeg_bytes((200, 80, 80)), "image/jpeg")},
            ),
            client.post(
                _stale_url(
                    f"/api/projects/{project_id}/photos/shared/pages/0/slots/1",
                    stale_revision,
                ),
                files={"file": ("stale-shared.jpg", jpeg_bytes((80, 200, 80)), "image/jpeg")},
            ),
            client.post(
                _stale_url(
                    f"/api/projects/{project_id}/photos/batch/pages/0/slots/1",
                    stale_revision,
                ),
                files=[("files", ("stale-batch.jpg", jpeg_bytes((80, 80, 200)), "image/jpeg"))],
                data={
                    "mapping": json.dumps({str(student_id): "stale-batch.jpg"}),
                    "overwrite_existing": "true",
                },
            ),
        ]

        for response in responses:
            _assert_revision_conflict(response)

        final_project = client.get(f"/api/projects/{project_id}").json()
        assert final_project == baseline_project
        assert get_storage().list_keys(f"projects/proj{project_id}/") == baseline_storage_keys
        assert final_project["students"][0]["pages_data"][0]["photos"]["1"]["path"] == initial_path


def test_page_indexed_mutation_requires_expected_template_revision():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id)
        missing_revision = client.put(
            f"/api/projects/{project_id}/label_texts",
            json={"0": {"1": "missing revision"}},
        )
        assert_status(missing_revision, 422)


def test_waiting_revision_guard_restarts_wal_snapshot_before_cas(monkeypatch):
    """鎖等待期間模板升版時，舊寫入必須看到新 revision 並以 409 零寫入結束。"""
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id)
        stale_revision = project_template_revision(client, project_id)

        real_template_lock = revision_service.lock_template_write
        lock_attempted = threading.Event()

        @contextmanager
        def observed_template_lock(locked_template_id: int):
            lock_attempted.set()
            with real_template_lock(locked_template_id):
                yield

        monkeypatch.setattr(
            revision_service,
            "lock_template_write",
            observed_template_lock,
        )
        request_result: dict = {}

        def send_stale_write() -> None:
            try:
                request_result["response"] = client.put(
                    _stale_url(f"/api/projects/{project_id}/label_texts", stale_revision),
                    json={"0": {"1": "不得寫入"}},
                )
            except BaseException as error:
                request_result["error"] = error

        with lock_template_write(template_id):
            request_thread = threading.Thread(target=send_stale_write)
            request_thread.start()
            assert lock_attempted.wait(5)

            db = SessionLocal()
            try:
                template = db.get(Template, template_id)
                project = db.get(Project, project_id)
                template.revision = stale_revision + 1
                project.template_revision = stale_revision + 1
                db.commit()
            finally:
                db.close()

        request_thread.join(5)
        assert not request_thread.is_alive()
        if "error" in request_result:
            raise request_result["error"]
        _assert_revision_conflict(request_result["response"])

        db = SessionLocal()
        try:
            project = db.get(Project, project_id)
            assert project.template_revision == stale_revision + 1
            assert project.label_texts_json == "{}"
        finally:
            db.close()
