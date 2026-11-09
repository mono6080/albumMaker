"""預覽與縮圖等重工作前必須先還 DB 連線，排隊中的請求不可把連線池佔滿。"""

import database
from services import preview_cache, project_photo_service
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    revisioned_project_url,
    started_client,
    use_tmp_uploads,
)


def _create_project_with_student(client) -> tuple[int, int]:
    template_id, _ = create_template_with_page(client)
    project_id = create_project(client, template_id, student_names=["連線測試"])
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return project_id, detail.json()["students"][0]["id"]


def test_thumbnail_releases_db_connection_before_heavy_work(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    original_build = project_photo_service.build_photo_thumbnail_jpeg
    checked_out_during_build: list[int] = []

    def tracked_build(storage, photo_key, size):
        checked_out_during_build.append(database.engine.pool.checkedout())
        return original_build(storage, photo_key, size)

    monkeypatch.setattr(
        project_photo_service,
        "build_photo_thumbnail_jpeg",
        tracked_build,
    )

    with started_client() as client:
        login(client)
        project_id, student_id = _create_project_with_student(client)
        photo_url = f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"
        upload = client.post(
            revisioned_project_url(client, project_id, photo_url),
            files={"file": ("photo.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload, 200)

        thumbnail = client.get(f"{photo_url}/thumbnail")

    assert_status(thumbnail, 200)
    assert thumbnail.headers["x-photo-thumbnail"] == "MISS"
    assert checked_out_during_build == [0]


def test_previews_release_db_connection_before_waiting_for_slot(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    limiter = preview_cache.preview_render_limiter
    original_acquire_slot = limiter.acquire_slot
    checked_out_while_queueing: list[int] = []

    def tracked_acquire_slot() -> bool:
        checked_out_while_queueing.append(database.engine.pool.checkedout())
        return original_acquire_slot()

    monkeypatch.setattr(limiter, "acquire_slot", tracked_acquire_slot)

    with started_client() as client:
        login(client)
        project_id, student_id = _create_project_with_student(client)

        project_preview = client.get(f"/api/projects/{project_id}/preview/0")
        student_preview = client.get(
            f"/api/projects/{project_id}/students/{student_id}/preview/0"
        )

    assert_status(project_preview, 200)
    assert_status(student_preview, 200)
    assert checked_out_while_queueing == [0, 0]
