# API 負向與邊界契約測試
# 補足 smoke tests 沒涵蓋的 401 / 404 / 413 / 415 / 422 與渲染失敗路徑。

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from tests.helpers import (
    assert_status,
    create_user,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    started_client,
    unique_name,
    use_tmp_uploads,
)

from database import SessionLocal, Student


def create_student(client: TestClient, project_id: int, name: str = "Edge Student") -> int:
    response = client.post(f"/api/projects/{project_id}/students/batch", json=[name])
    assert_status(response, 200)

    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return detail.json()["students"][0]["id"]


def large_jpeg_bytes() -> bytes:
    image = Image.effect_noise((3000, 3000), 100).convert("RGB")
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=100)
    data = buffer.getvalue()
    assert len(data) > 10 * 1024 * 1024
    return data


def heif_bytes() -> bytes:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    image = Image.new("RGB", (96, 72), (80, 120, 220))
    buffer = BytesIO()
    image.save(buffer, format="HEIF")
    return buffer.getvalue()


def test_auth_missing_resource_and_validation_edges():
    with started_client() as client:
        templates_without_login = client.get("/api/templates/")
        assert_status(templates_without_login, 401)

        login(client)
        missing_template = client.get("/api/templates/999999")
        assert_status(missing_template, 404)

        project_with_missing_template = client.post(
            "/api/projects/",
            data={"name": unique_name("missing_template_project"), "template_id": "999999"},
        )
        assert_status(project_with_missing_template, 404)

        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id)
        student_id = create_student(client, project_id)

        project_page_out_of_range = client.get(f"/api/projects/{project_id}/preview/99")
        assert_status(project_page_out_of_range, 404)

        student_page_out_of_range = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/99")
        assert_status(student_page_out_of_range, 404)

        missing_student_preview = client.get(f"/api/projects/{project_id}/students/999999/preview/0")
        assert_status(missing_student_preview, 404)

        invalid_pdf_mode = client.get(f"/api/projects/{project_id}/students/{student_id}/pdf?mode=web")
        assert_status(invalid_pdf_mode, 422)
        invalid_image_mode = client.get(f"/api/projects/{project_id}/students/{student_id}/images?mode=web")
        assert_status(invalid_image_mode, 422)
        invalid_single_image_mode = client.get(f"/api/projects/{project_id}/students/{student_id}/images/1?mode=web")
        assert_status(invalid_single_image_mode, 422)

        pdf_before_render = client.get(f"/api/projects/{project_id}/students/{student_id}/pdf")
        assert_status(pdf_before_render, 404)
        images_before_render = client.get(f"/api/projects/{project_id}/students/{student_id}/images")
        assert_status(images_before_render, 404)
        single_image_before_render = client.get(f"/api/projects/{project_id}/students/{student_id}/images/1")
        assert_status(single_image_before_render, 404)


def test_upload_size_type_and_missing_photo_edges(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id)
        student_id = create_student(client, project_id)
        photo_url = f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"

        missing_photo = client.get(photo_url)
        assert_status(missing_photo, 404)
        missing_thumbnail = client.get(f"{photo_url}/thumbnail")
        assert_status(missing_thumbnail, 404)

        unsupported_type = client.post(
            photo_url,
            files={"file": ("note.txt", b"not an image", "text/plain")},
        )
        assert_status(unsupported_type, 415)

        oversized_photo = client.post(
            photo_url,
            files={"file": ("too-large.jpg", large_jpeg_bytes(), "image/jpeg")},
        )
        assert_status(oversized_photo, 200)
        oversized_payload = oversized_photo.json()
        assert oversized_payload["filename"].endswith(".jpg")
        oversized_path = tmp_path / "uploads" / oversized_payload["path"]
        assert oversized_path.stat().st_size <= 5 * 1024 * 1024
        with Image.open(oversized_path) as compressed_image:
            assert compressed_image.format == "JPEG"

        heic_upload = client.post(
            photo_url,
            files={"file": ("edge.heic", heif_bytes(), "image/heic")},
        )
        assert_status(heic_upload, 200)
        heic_payload = heic_upload.json()
        assert heic_payload["filename"].endswith(".jpg")
        heic_path = tmp_path / "uploads" / heic_payload["path"]
        with Image.open(heic_path) as converted_image:
            assert converted_image.format == "JPEG"

        valid_upload = client.post(
            photo_url,
            files={"file": ("edge.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(valid_upload, 200)

        thumbnail = client.get(f"{photo_url}/thumbnail")
        assert_status(thumbnail, 200)
        assert thumbnail.headers["content-type"].startswith("image/jpeg")
        assert thumbnail.headers["x-photo-thumbnail"] == "MISS"
        thumbnail_key = thumbnail.headers["x-photo-thumbnail-key"]
        assert (tmp_path / "uploads" / thumbnail_key).exists()
        assert thumbnail.content.startswith(b"\xff\xd8")

        cached_thumbnail = client.get(f"{photo_url}/thumbnail")
        assert_status(cached_thumbnail, 200)
        assert cached_thumbnail.headers["x-photo-thumbnail"] == "HIT"
        assert cached_thumbnail.content == thumbnail.content

        missing_page = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/99/photos/1")
        assert_status(missing_page, 404)

        missing_slot = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/2")
        assert_status(missing_slot, 404)


def test_render_failure_edges_for_templates_without_pages():
    with started_client() as client:
        login(client)
        template_response = client.post("/api/templates/", data={"name": unique_name("empty_template")})
        assert_status(template_response, 200)
        template_id = template_response.json()["id"]
        project_id = create_project(client, template_id, name=unique_name("empty_template_project"))
        student_id = create_student(client, project_id, name="No Page Student")

        render_student = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(render_student, 400)

        render_all = client.post(f"/api/projects/{project_id}/render/all")
        assert_status(render_all, 200)
        assert render_all.json()["rendered"] == []
        assert render_all.json()["errors"] == [{"student": "No Page Student", "error": "產生失敗"}]


def test_project_mutation_role_edges(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("role_edges_project"))
        student_id = create_student(client, project_id)

        supervisor, supervisor_password = create_user(client, "supervisor")
        teacher, teacher_password = create_user(client, "teacher", supervisor_id=supervisor["id"])
        art_team, art_team_password = create_user(client, "art_team")

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        teacher_upload_admin_project = client.post(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
            files={"file": ("blocked.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(teacher_upload_admin_project, 403)
        teacher_batch_admin_project = client.put(
            f"/api/projects/{project_id}/label_texts",
            json={"0": {"1": "blocked"}},
        )
        assert_status(teacher_batch_admin_project, 403)

        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        supervisor_batch_add = client.post(f"/api/projects/{project_id}/students/batch", json=["Blocked"])
        assert_status(supervisor_batch_add, 403)

        client.cookies.clear()
        login(client, art_team["username"], art_team_password)
        art_team_render = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(art_team_render, 403)

        client.cookies.clear()
        unauthenticated_comments = client.get(f"/api/projects/{project_id}/comments")
        assert_status(unauthenticated_comments, 401)


def test_photo_mapping_swap_keeps_both_files(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("mapping_swap_project"))
        student_id = create_student(client, project_id)

        first_upload = client.post(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
            files={"file": ("first.jpg", jpeg_bytes((240, 72, 72)), "image/jpeg")},
        )
        assert_status(first_upload, 200)
        first_path = first_upload.json()["path"]

        second_upload = client.post(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/2",
            files={"file": ("second.jpg", jpeg_bytes((72, 120, 240)), "image/jpeg")},
        )
        assert_status(second_upload, 200)
        second_path = second_upload.json()["path"]

        swap_response = client.put(
            f"/api/projects/{project_id}/students/{student_id}/photos/mapping",
            json={
                "pages": {
                    "0": {
                        "1": {"path": second_path, "scale": 1.1, "offset_x": 0.0, "offset_y": 0.0},
                        "2": {"path": first_path, "scale": 1.2, "offset_x": 0.0, "offset_y": 0.0},
                    }
                }
            },
        )
        assert_status(swap_response, 200)

        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        photos = detail.json()["students"][0]["pages_data"][0]["photos"]
        assert photos["1"]["path"] == second_path
        assert photos["2"]["path"] == first_path
        assert photos["1"]["scale"] == 1.1
        assert photos["2"]["scale"] == 1.2

        swapped_first_slot = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1")
        assert_status(swapped_first_slot, 200)
        swapped_second_slot = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/2")
        assert_status(swapped_second_slot, 200)


def test_corrupt_project_json_returns_422():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("corrupt_json_project"))
        student_id = create_student(client, project_id)

        db = SessionLocal()
        try:
            student = db.query(Student).filter(Student.id == student_id).one()
            student.pages_data_json = "{not-json"
            db.commit()
        finally:
            db.close()

        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 422)
