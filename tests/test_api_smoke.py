# FastAPI API smoke tests
# These tests exercise the real app wiring, auth cookie flow, and core route
# contracts against the tmp SQLite database configured in conftest.py.

import mimetypes
import threading
from datetime import datetime, timedelta, timezone
from io import BytesIO
from zipfile import ZipFile

from PIL import Image

from database import Project, SessionLocal, Student
from main import (
    FRONTEND_APP_CACHE_CONTROL,
    FRONTEND_ASSET_CACHE_CONTROL,
    FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL,
    apply_frontend_cache_headers,
)
from services.project_archive_service import purge_expired_archived_projects
from services.render_service import PRINT_OUTPUT_SIZE
from starlette.responses import Response

from tests.helpers import (
    assert_status,
    count_non_whiteish_pixels,
    create_project,
    create_project_for_owner,
    create_template_with_page,
    create_user,
    jpeg_bytes,
    login,
    png_bytes,
    replace_template_page_layout,
    revisioned_project_url,
    scale_box_for_image,
    smoke_layout,
    started_client,
    template_revision,
    unique_name,
    use_tmp_uploads,
    workbook_bytes,
)

def test_health_and_auth_cookie_roundtrip():
    with started_client() as client:
        health = client.get("/api/health")
        assert_status(health, 200)
        assert health.json() == {"status": "ok", "database": "ok"}

        unauthenticated = client.get("/api/auth/me")
        assert_status(unauthenticated, 401)

        login_payload = login(client)
        assert login_payload["username"] == "admin"
        assert login_payload["role"] == "admin"
        assert login_payload["ui_font_scale"] == 1.0
        assert client.cookies.get("access_token")

        me = client.get("/api/auth/me")
        assert_status(me, 200)
        assert me.json()["username"] == "admin"
        assert me.json()["ui_font_scale"] == 1.0

        settings = client.patch("/api/users/me/settings", json={"ui_font_scale": 1.15})
        assert_status(settings, 200)
        assert settings.json()["ui_font_scale"] == 1.15

        updated_me = client.get("/api/auth/me")
        assert_status(updated_me, 200)
        assert updated_me.json()["ui_font_scale"] == 1.15

        invalid_settings = client.patch("/api/users/me/settings", json={"ui_font_scale": 1.8})
        assert_status(invalid_settings, 422)

        logout = client.post("/api/auth/logout")
        assert_status(logout, 200)
        assert "access_token=" in logout.headers["set-cookie"]

        client.cookies.clear()
        after_logout = client.get("/api/auth/me")
        assert_status(after_logout, 401)


def test_frontend_static_cache_headers_policy():
    asset_response = Response()
    apply_frontend_cache_headers(asset_response, "/assets/index-a1b2c3.js")
    assert asset_response.headers["cache-control"] == FRONTEND_ASSET_CACHE_CONTROL

    font_response = Response()
    apply_frontend_cache_headers(font_response, "/fonts/NotoSansTC-VF.ttf")
    assert (
        font_response.headers["cache-control"]
        == FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL
    )

    shell_response = Response()
    apply_frontend_cache_headers(shell_response, "/projects/28/review")
    assert shell_response.headers["cache-control"] == FRONTEND_APP_CACHE_CONTROL
    assert shell_response.headers["pragma"] == "no-cache"
    assert shell_response.headers["expires"] == "0"

    sw_response = Response()
    apply_frontend_cache_headers(sw_response, "/sw.js")
    assert sw_response.headers["cache-control"] == FRONTEND_APP_CACHE_CONTROL
    assert sw_response.headers["service-worker-allowed"] == "/"

    api_response = Response()
    api_response.headers["Cache-Control"] = "no-store"
    apply_frontend_cache_headers(api_response, "/api/projects/1/preview/0")
    assert api_response.headers["cache-control"] == "no-store"


def test_frontend_font_static_files_support_conditional_revalidation():
    with started_client() as client:
        font_response = client.get("/fonts/NotoSansTC-VF.woff2")
        assert_status(font_response, 200)
        assert font_response.headers["content-type"] == "font/woff2"
        assert font_response.headers["cache-control"] == (
            FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL
        )
        assert font_response.headers["etag"]

        ttf_response = client.head("/fonts/NotoSansTC-VF.ttf")
        assert_status(ttf_response, 200)
        assert ttf_response.headers["content-type"] == "font/ttf"
        assert mimetypes.guess_type("font.woff")[0] == "font/woff"

        not_modified = client.get(
            "/fonts/NotoSansTC-VF.woff2",
            headers={"If-None-Match": font_response.headers["etag"]},
        )
        assert_status(not_modified, 304)
        assert not_modified.content == b""
        assert not_modified.headers["cache-control"] == (
            FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL
        )


def test_template_project_student_and_text_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)

        templates = client.get("/api/templates/")
        assert_status(templates, 200)
        assert any(
            template["id"] == template_id
            and template["page_count"] == 1
            and template["photo_count"] == 1
            for template in templates.json()
        )

        template_detail = client.get(f"/api/templates/{template_id}")
        assert_status(template_detail, 200)
        assert template_detail.json()["photo_count"] == 1
        assert template_detail.json()["pages"][0]["layout"]["text_labels"][0]["id"] == 1

        project_id = create_project(
            client,
            template_id,
            student_names=["Alice", "Bob"],
        )
        project_list = client.get("/api/projects/")
        assert_status(project_list, 200)
        assert any(project["id"] == project_id and project["student_count"] == 2 for project in project_list.json())

        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        students_by_name = {student["name"]: student for student in detail.json()["students"]}
        student_id = students_by_name["Alice"]["id"]

        db = SessionLocal()
        try:
            roster_child_id = db.get(Student, student_id).roster_child_id
        finally:
            db.close()
        update_album_name = client.patch(
            f"/api/organization/roster-children/{roster_child_id}/album-name",
            json={"album_name": "Alice Chen"},
        )
        assert_status(update_album_name, 200)

        skip_response = client.patch(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/skip"
            ),
            json={"skip": True},
        )
        assert_status(skip_response, 200)
        assert skip_response.json() == {"ok": True}

        project_label_texts = {"0": {"1": "Class label text"}}
        update_project_texts = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/label_texts"),
            json=project_label_texts,
        )
        assert_status(update_project_texts, 200)
        get_project_texts = client.get(f"/api/projects/{project_id}/label_texts")
        assert_status(get_project_texts, 200)
        assert get_project_texts.json() == project_label_texts

        update_student_texts = client.put(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/texts"
            ),
            json={"1": "Student label text"},
        )
        assert_status(update_student_texts, 200)

        batch_texts = {
            "students": {
                str(student_id): {
                    "0": {"1": "Batch label text"},
                }
            }
        }
        update_batch_texts = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/batch/texts"),
            json=batch_texts,
        )
        assert_status(update_batch_texts, 200)

        final_detail = client.get(f"/api/projects/{project_id}")
        assert_status(final_detail, 200)
        final_payload = final_detail.json()
        assert final_payload["label_texts"] == project_label_texts
        updated_student = next(student for student in final_payload["students"] if student["id"] == student_id)
        assert updated_student["name"] == "Alice"
        assert updated_student["album_name"] == "Alice Chen"
        assert updated_student["pages_data"][0]["skip"] is True
        assert updated_student["pages_data"][0]["label_texts"] == {"1": "Batch label text"}


def test_user_management_keeps_organization_scope_out_of_user_payloads():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, _ = create_user(client, "teacher")
        assert "supervisor_id" not in teacher
        assert "supervisor_ids" not in teacher

        users_response = client.get("/api/users/")
        assert_status(users_response, 200)
        listed_teacher = next(user for user in users_response.json() if user["id"] == teacher["id"])
        assert "supervisor_id" not in listed_teacher
        assert "supervisor_ids" not in listed_teacher

        rejected_create = client.post(
            "/api/users/",
            json={
                "username": unique_name("teacher"),
                "display_name": "teacher user",
                "password": "user-password-123",
                "role": "teacher",
                "supervisor_ids": [supervisor["id"]],
            },
        )
        assert_status(rejected_create, 422)
        rejected_update = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_id": supervisor["id"]},
        )
        assert_status(rejected_update, 422)


def test_project_delete_archives_and_restore_recovers(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("archive_project"),
            student_names=["Archived Student"],
        )
        project_detail = client.get(f"/api/projects/{project_id}")
        assert_status(project_detail, 200)
        student_id = project_detail.json()["students"][0]["id"]
        upload_response = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"
            ),
            files={"file": ("archived.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload_response, 200)
        project_storage_dir = tmp_path / "uploads" / "projects" / f"proj{project_id}"
        assert project_storage_dir.exists()

        delete_response = client.delete(f"/api/projects/{project_id}")
        assert_status(delete_response, 200)
        delete_payload = delete_response.json()
        assert delete_payload["ok"] is True
        assert delete_payload["archive_expires_at"]

        active_projects = client.get("/api/projects/")
        assert_status(active_projects, 200)
        assert project_id not in {project["id"] for project in active_projects.json()}

        direct_read = client.get(f"/api/projects/{project_id}")
        assert_status(direct_read, 404)

        archived_projects = client.get("/api/projects/archive")
        assert_status(archived_projects, 200)
        archived = next(project for project in archived_projects.json() if project["id"] == project_id)
        assert archived["deleted_at"]
        assert archived["archive_expires_at"]

        restore_response = client.post(f"/api/projects/{project_id}/restore")
        assert_status(restore_response, 200)
        assert restore_response.json() == {"ok": True}

        restored_detail = client.get(f"/api/projects/{project_id}")
        assert_status(restored_detail, 200)
        assert restored_detail.json()["id"] == project_id

        delete_again = client.delete(f"/api/projects/{project_id}")
        assert_status(delete_again, 200)
        db = SessionLocal()
        try:
            archived_project = db.query(Project).filter(Project.id == project_id).one()
            archived_project.archive_expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
            db.commit()
        finally:
            db.close()

        expired_archive = client.get("/api/projects/archive")
        assert_status(expired_archive, 200)
        assert project_id not in {project["id"] for project in expired_archive.json()}
        assert project_storage_dir.exists()
        db = SessionLocal()
        try:
            assert db.query(Project).filter(Project.id == project_id).first() is not None
            assert purge_expired_archived_projects(db) == [project_id]
        finally:
            db.close()
        assert not project_storage_dir.exists()
        db = SessionLocal()
        try:
            assert db.query(Project).filter(Project.id == project_id).first() is None
        finally:
            db.close()

        expired_restore = client.post(f"/api/projects/{project_id}/restore")
        assert_status(expired_restore, 404)


def test_admin_can_import_users_from_excel():
    with started_client() as client:
        login(client)
        supervisor_username = unique_name("bulk_supervisor")
        teacher_username = unique_name("bulk_teacher")
        invalid_role_username = unique_name("invalid_role")

        excel_payload = workbook_bytes([
            ["帳號", "顯示名稱", "初始密碼", "角色"],
            [supervisor_username, "匯入主管", "supervisor-pass", "主管"],
            [teacher_username, "匯入老師", "teacher-pass", "帶班老師"],
            ["admin", "Existing Admin", "password", "管理員"],
            [supervisor_username, "Duplicate Supervisor", "password", "主管"],
            [invalid_role_username, "錯誤角色", "teacher-pass", "不存在角色"],
        ])

        response = client.post(
            "/api/users/import",
            files={
                "file": (
                    "users.xlsx",
                    excel_payload,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert_status(response, 201)
        payload = response.json()
        assert payload["created_count"] == 2
        assert payload["skipped_count"] == 2
        assert payload["error_count"] == 1
        assert {item["username"] for item in payload["skipped"]} == {"admin", supervisor_username}
        assert payload["errors"][0]["username"] == invalid_role_username
        assert "無效角色" in payload["errors"][0]["error"]

        users_response = client.get("/api/users/")
        assert_status(users_response, 200)
        users_by_username = {user["username"]: user for user in users_response.json()}
        supervisor = users_by_username[supervisor_username]
        teacher = users_by_username[teacher_username]
        assert supervisor["role"] == "supervisor"
        assert teacher["role"] == "teacher"
        assert "supervisor_ids" not in teacher

        client.cookies.clear()
        login_payload = login(client, teacher_username, "teacher-pass")
        assert login_payload["role"] == "teacher"


def test_admin_password_reset_rejects_short_value_and_revokes_old_token():
    with started_client() as client:
        login(client)
        art_team, original_password = create_user(client, "art_team")

        client.cookies.clear()
        login(client, art_team["username"], original_password)
        old_access_token = client.cookies.get("access_token")

        client.cookies.clear()
        login(client)

        short_reset = client.patch(
            f"/api/users/{art_team['id']}",
            json={"new_password": "admin"},
        )
        assert_status(short_reset, 422)

        new_password = "new-password-456"
        reset_response = client.patch(
            f"/api/users/{art_team['id']}",
            json={"new_password": new_password},
        )
        assert_status(reset_response, 200)

        client.cookies.clear()
        client.cookies.set("access_token", old_access_token)
        assert_status(client.get("/api/auth/me"), 401)

        client.cookies.clear()
        login_payload = login(client, art_team["username"], new_password)
        assert login_payload["username"] == art_team["username"]
        assert login_payload["role"] == "art_team"


def test_admin_cannot_create_user_with_short_initial_password():
    with started_client() as client:
        login(client)
        username = unique_name("short_password_user")
        create_response = client.post(
            "/api/users/",
            json={
                "username": username,
                "display_name": "Short Password User",
                "password": "admin",
                "role": "art_team",
            },
        )
        assert_status(create_response, 422)


def test_role_access_and_none_login_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        admin_project_id = create_project(client, template_id, name=unique_name("admin_project"))

        supervisor, supervisor_password = create_user(client, "supervisor")
        second_supervisor, second_supervisor_password = create_user(client, "supervisor")
        teacher, teacher_password = create_user(client, "teacher")
        art_team, art_team_password = create_user(client, "art_team")
        none_user, none_password = create_user(client, "none")
        teacher_project_id = create_project_for_owner(
            client,
            template_id,
            teacher["id"],
            name=unique_name("teacher_project"),
        )

        db = SessionLocal()
        try:
            teacher_project = db.get(Project, teacher_project_id)
            campus_id = teacher_project.classroom.campus_id
        finally:
            db.close()
        supervisor_scope = client.put(
            f"/api/organization/campuses/{campus_id}/supervisors",
            json={
                "campus_supervisor_ids": [supervisor["id"], second_supervisor["id"]],
                "department_supervisors": [
                    {"department": "infant", "supervisor_ids": []},
                    {"department": "academy", "supervisor_ids": []},
                ],
            },
        )
        assert_status(supervisor_scope, 200)

        client.cookies.clear()
        none_login = client.post(
            "/api/auth/login",
            data={"username": none_user["username"], "password": none_password},
        )
        assert_status(none_login, 403)
        assert not client.cookies.get("access_token")

        login(client, teacher["username"], teacher_password)
        teacher_generic_create = client.post(
            "/api/projects/",
            data={"name": unique_name("teacher_project"), "template_id": template_id},
        )
        assert_status(teacher_generic_create, 405)

        teacher_projects = client.get("/api/projects/")
        assert_status(teacher_projects, 200)
        teacher_project_ids = {project["id"] for project in teacher_projects.json()}
        assert teacher_project_id in teacher_project_ids
        assert admin_project_id not in teacher_project_ids

        teacher_reads_admin = client.get(f"/api/projects/{admin_project_id}")
        assert_status(teacher_reads_admin, 403)
        teacher_writes_admin = client.patch(f"/api/projects/{admin_project_id}", data={"name": "blocked"})
        assert_status(teacher_writes_admin, 403)
        teacher_writes_own = client.patch(f"/api/projects/{teacher_project_id}", data={"name": "teacher updated"})
        assert_status(teacher_writes_own, 200)

        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        supervisor_projects = client.get("/api/projects/")
        assert_status(supervisor_projects, 200)
        supervisor_project_ids = {project["id"] for project in supervisor_projects.json()}
        assert teacher_project_id in supervisor_project_ids
        assert admin_project_id not in supervisor_project_ids
        supervisor_reads_teacher = client.get(f"/api/projects/{teacher_project_id}")
        assert_status(supervisor_reads_teacher, 200)
        supervisor_writes_teacher = client.patch(f"/api/projects/{teacher_project_id}", data={"name": "blocked"})
        assert_status(supervisor_writes_teacher, 403)

        client.cookies.clear()
        login(client, second_supervisor["username"], second_supervisor_password)
        second_supervisor_projects = client.get("/api/projects/")
        assert_status(second_supervisor_projects, 200)
        second_supervisor_project_ids = {project["id"] for project in second_supervisor_projects.json()}
        assert teacher_project_id in second_supervisor_project_ids
        second_supervisor_reads_teacher = client.get(f"/api/projects/{teacher_project_id}")
        assert_status(second_supervisor_reads_teacher, 200)

        client.cookies.clear()
        login(client, art_team["username"], art_team_password)
        art_template = client.post("/api/templates/", data={"name": unique_name("art_template")})
        assert_status(art_template, 200)
        art_project = client.post(
            "/api/projects/",
            data={"name": unique_name("art_project"), "template_id": template_id},
        )
        assert_status(art_project, 405)
        art_reads_admin = client.get(f"/api/projects/{admin_project_id}")
        assert_status(art_reads_admin, 200)
        art_writes_admin = client.patch(f"/api/projects/{admin_project_id}", data={"name": "blocked"})
        assert_status(art_writes_admin, 403)


def test_preview_endpoints_require_auth():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        project_id = create_project(client, template_id)

        client.cookies.clear()
        assert_status(client.get(f"/api/templates/{template_id}/pages/{page_id}/preview"), 401)
        assert_status(client.get(f"/api/templates/{template_id}/spread-preview/0"), 401)
        assert_status(client.get(f"/api/projects/{project_id}/preview/0"), 401)

        login(client)
        template_preview = client.get(f"/api/templates/{template_id}/pages/{page_id}/preview")
        assert_status(template_preview, 200)
        assert template_preview.headers["content-type"].startswith("image/png")
        assert "no-store" in template_preview.headers["cache-control"]
        assert template_preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        with Image.open(BytesIO(template_preview.content)) as preview_image:
            assert preview_image.format == "PNG"

        spread_preview = client.get(f"/api/templates/{template_id}/spread-preview/0")
        assert_status(spread_preview, 200)
        assert spread_preview.headers["content-type"].startswith("image/png")
        assert "no-store" in spread_preview.headers["cache-control"]
        assert spread_preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        with Image.open(BytesIO(spread_preview.content)) as spread_image:
            assert spread_image.format == "PNG"
            assert spread_image.size == (1588, 1123)

        project_preview = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_preview, 200)
        assert project_preview.headers["content-type"].startswith("image/png")
        assert "private" in project_preview.headers["cache-control"]
        assert "no-cache" in project_preview.headers["cache-control"]
        assert project_preview.headers["etag"]
        assert project_preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        with Image.open(BytesIO(project_preview.content)) as preview_image:
            assert preview_image.format == "PNG"


def test_student_editor_endpoint_only_returns_current_student_pages(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("student_editor"),
            student_names=["Current", "Sibling"],
        )
        detail = client.get(f"/api/projects/{project_id}").json()
        current = detail["students"][0]
        upload = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{current['id']}/pages/0/photos/1",
            ),
            files={"file": ("current.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload, 200)

        editor = client.get(f"/api/projects/{project_id}/students/{current['id']}/editor")
        assert_status(editor, 200)
        payload = editor.json()
        assert payload["student"]["id"] == current["id"]
        assert payload["student"]["pages_data"][0]["photos"]["1"]["path"] == upload.json()["path"]
        assert [student["name"] for student in payload["project"]["students"]] == ["Current", "Sibling"]
        assert all("pages_data" not in student for student in payload["project"]["students"])

        client.cookies.clear()
        assert_status(client.get(f"/api/projects/{project_id}/students/{current['id']}/editor"), 401)


def test_template_spread_preview_uses_page_background_column(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        blank_layout = {
            "canvas_width": 794,
            "canvas_height": 1123,
            "photo_slots": [],
            "text_labels": [],
            "stickers": [],
            "footer": None,
            "logo": None,
        }
        replace_template_page_layout(client, template_id, page_id, blank_layout)

        background_upload = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/background",
            params={"expected_revision": template_revision(client, template_id)},
            files={"file": ("red.png", png_bytes((20, 20), (230, 20, 20, 255)), "image/png")},
        )
        assert_status(background_upload, 200)
        background_url = f"/api/templates/{template_id}/pages/{page_id}/background"
        background = client.get(background_url)
        assert_status(background, 200)
        with Image.open(BytesIO(background.content)) as background_image:
            assert background_image.size == (20, 20)

        # 模擬 TemplateEditor 後續儲存版面時只送元素 layout，導致 layout_json 不含 background_filename。
        replace_template_page_layout(client, template_id, page_id, blank_layout)

        client.cookies.clear()
        assert_status(client.get(background_url), 401)
        assert_status(client.get(f"/api/templates/{template_id}/pages/{page_id}/preview"), 401)
        assert_status(client.get(f"/api/templates/{template_id}/spread-preview/0"), 401)
        login(client)
        template_preview = client.get(f"/api/templates/{template_id}/pages/{page_id}/preview")
        assert_status(template_preview, 200)
        spread_preview = client.get(f"/api/templates/{template_id}/spread-preview/0")
        assert_status(spread_preview, 200)

        with Image.open(BytesIO(template_preview.content)) as preview_image:
            red, green, blue = preview_image.getpixel((10, 10))
            assert red > 180
            assert green < 80
            assert blue < 80

        with Image.open(BytesIO(spread_preview.content)) as spread_image:
            red, green, blue = spread_image.getpixel((10, 10))
            assert red > 180
            assert green < 80
            assert blue < 80


def test_sticker_upload_returns_intrinsic_dimensions(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)

        upload = client.post(
            f"/api/templates/{template_id}/stickers",
            files={"file": ("wide.png", png_bytes((320, 120)), "image/png")},
        )
        assert_status(upload, 200)
        payload = upload.json()
        asset_revision = payload.pop("asset_revision")
        assert asset_revision.startswith("sha256:")
        assert len(asset_revision) == len("sha256:") + 64
        versioned_filename = payload["filename"]
        assert versioned_filename.startswith("wide_")
        assert versioned_filename.endswith(".png")
        assert payload == {
            "path": f"templates/tmpl{template_id}/stickers/{versioned_filename}",
            "filename": versioned_filename,
            "width": 320,
            "height": 120,
        }

        sticker = client.get(f"/api/templates/{template_id}/stickers/{versioned_filename}")
        assert_status(sticker, 200)
        with Image.open(BytesIO(sticker.content)) as sticker_image:
            assert sticker_image.size == (320, 120)
        client.cookies.clear()
        assert_status(client.get(f"/api/templates/{template_id}/stickers/{versioned_filename}"), 401)


def test_template_periods_and_copy_template_contract(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)

        departments = client.get("/api/templates/departments")
        assert_status(departments, 200)
        assert {department["code"] for department in departments.json()} == {"infant", "academy"}

        periods = client.get("/api/templates/periods")
        assert_status(periods, 200)
        default_periods = [
            period for period in periods.json()
            if period["name"] == "202605" and period["status"] == "active"
        ]
        assert {period["department"] for period in default_periods} == {"infant", "academy"}
        infant_period = next(period for period in default_periods if period["department"] == "infant")

        draft_period_response = client.post(
            "/api/templates/periods",
            data={"name": unique_name("period"), "department": "academy", "status": "draft"},
        )
        assert_status(draft_period_response, 200)
        draft_period = draft_period_response.json()

        draft_template = client.post(
            "/api/templates/",
            data={"name": unique_name("draft_template"), "period_id": str(draft_period["id"])},
        )
        assert_status(draft_template, 200)
        draft_template_id = draft_template.json()["id"]

        unavailable = client.get("/api/templates/", params={"available": "true"})
        assert_status(unavailable, 200)
        assert draft_template_id not in {template["id"] for template in unavailable.json()}

        lead_teacher, _ = create_user(client, "teacher")
        campus_response = client.post(
            "/api/organization/campuses",
            json={"name": unique_name("draft-campus"), "is_active": True},
        )
        assert_status(campus_response, 201)
        classroom_response = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus_response.json()["id"],
                "department": "academy",
                "name": unique_name("draft-classroom"),
                "is_active": True,
            },
        )
        assert_status(classroom_response, 201)
        classroom_id = classroom_response.json()["id"]
        assert_status(
            client.put(
                f"/api/organization/classrooms/{classroom_id}/teachers",
                json={
                    "teachers": [
                        {"teacher_id": lead_teacher["id"], "duty": "lead"}
                    ]
                },
            ),
            200,
        )
        overview_response = client.get("/api/organization/overview")
        assert_status(overview_response, 200)
        active_work_slot_id = next(
            work_slot["id"]
            for work_slot in overview_response.json()["work_slots"]
            if work_slot["classroom_id"] == classroom_id
            and work_slot["can_create_project"]
        )
        draft_project = client.post(
            f"/api/organization/classrooms/{classroom_id}/projects",
            json={
                "name": unique_name("draft_project"),
                "template_id": draft_template_id,
                "work_slot_id": active_work_slot_id,
                "owner_id": lead_teacher["id"],
            },
        )
        assert_status(draft_project, 422)
        assert draft_project.json()["detail"]["code"] == "work_slot_period_mismatch"

        source_template_id, source_page_id = create_template_with_page(client, name=unique_name("copy_source"))
        background_upload = client.post(
            f"/api/templates/{source_template_id}/pages/{source_page_id}/background",
            params={"expected_revision": template_revision(client, source_template_id)},
            files={"file": ("copy-bg.png", png_bytes((24, 24), (20, 160, 80, 255)), "image/png")},
        )
        assert_status(background_upload, 200)
        sticker_upload = client.post(
            f"/api/templates/{source_template_id}/stickers",
            files={"file": ("copy-sticker.png", png_bytes((80, 40)), "image/png")},
        )
        assert_status(sticker_upload, 200)

        copied_layout = smoke_layout()
        copied_layout["stickers"] = [{
            "id": 77,
            "path": sticker_upload.json()["path"],
            "filename": "copy-sticker.png",
            "x": 12,
            "y": 18,
            "width": 80,
            "height": 40,
        }]
        replace_template_page_layout(
            client,
            source_template_id,
            source_page_id,
            copied_layout,
        )

        copied_template = client.post(
            "/api/templates/",
            data={
                "name": unique_name("copy_target"),
                "period_id": str(infant_period["id"]),
                "source_template_id": str(source_template_id),
            },
        )
        assert_status(copied_template, 200)
        copied_template_id = copied_template.json()["id"]

        copied_detail = client.get(f"/api/templates/{copied_template_id}")
        assert_status(copied_detail, 200)
        copied_page = copied_detail.json()["pages"][0]
        assert copied_page["background_filename"].startswith(f"templates/tmpl{copied_template_id}/backgrounds/")
        assert copied_page["layout"]["background_filename"] == copied_page["background_filename"]
        copied_sticker_path = copied_page["layout"]["stickers"][0]["path"]
        assert copied_sticker_path.startswith(f"templates/tmpl{copied_template_id}/stickers/")

        copied_background = client.get(
            f"/api/templates/{copied_template_id}/pages/{copied_page['id']}/background"
        )
        assert_status(copied_background, 200)
        copied_sticker = client.get(
            f"/api/templates/{copied_template_id}/stickers/{copied_sticker_path.split('/')[-1]}"
        )
        assert_status(copied_sticker, 200)


def test_shared_project_photo_upload_applies_distinct_files(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("shared_photo_project"),
            student_names=["Ava", "Ben"],
        )
        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        student_ids = [student["id"] for student in detail.json()["students"]]

        shared_upload = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/photos/shared/pages/0/slots/1"
            ),
            files={"file": ("group.jpg", jpeg_bytes((60, 130, 220)), "image/jpeg")},
        )
        assert_status(shared_upload, 200)
        assert shared_upload.json()["updated"] == 2

        updated_detail = client.get(f"/api/projects/{project_id}")
        assert_status(updated_detail, 200)
        paths = [
            student["pages_data"][0]["photos"]["1"]["path"]
            for student in updated_detail.json()["students"]
        ]
        assert len(set(paths)) == 2
        assert all((tmp_path / "uploads" / path).exists() for path in paths)

        first_photo = client.get(f"/api/projects/{project_id}/students/{student_ids[0]}/pages/0/photos/1")
        assert_status(first_photo, 200)
        second_photo = client.get(f"/api/projects/{project_id}/students/{student_ids[1]}/pages/0/photos/1")
        assert_status(second_photo, 200)

        clear_first = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_ids[0]}/photos/mapping",
            ),
            json={"pages": {"0": {"1": None}}},
        )
        assert_status(clear_first, 200)
        first_missing = client.get(f"/api/projects/{project_id}/students/{student_ids[0]}/pages/0/photos/1")
        assert_status(first_missing, 404)
        second_still_exists = client.get(f"/api/projects/{project_id}/students/{student_ids[1]}/pages/0/photos/1")
        assert_status(second_still_exists, 200)


def test_hidden_group_photo_slot_is_not_counted_or_writable(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client, photo_slot_count=2)
        template_detail = client.get(f"/api/templates/{template_id}")
        assert_status(template_detail, 200)
        layout = template_detail.json()["pages"][0]["layout"]
        layout["group_contract"] = "nested-world-v2"
        layout["groups"] = [{
            "id": "hidden-slot-group",
            "z_index": 0,
            "selection_rotation": 0,
            "visible": False,
            "children": [
                {"type": "photo", "id": 1},
                {"type": "text", "id": 1},
            ],
        }]
        replace_template_page_layout(client, template_id, page_id, layout)

        templates = client.get("/api/templates/")
        assert_status(templates, 200)
        summary = next(item for item in templates.json() if item["id"] == template_id)
        assert summary["photo_count"] == 1
        refreshed_detail = client.get(f"/api/templates/{template_id}")
        assert_status(refreshed_detail, 200)
        assert refreshed_detail.json()["photo_count"] == 1

        project_id = create_project(
            client,
            template_id,
            student_names=["Hidden Slot Student"],
        )
        project_detail = client.get(f"/api/projects/{project_id}")
        assert_status(project_detail, 200)
        student_id = project_detail.json()["students"][0]["id"]

        hidden_upload = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"
            ),
            files={"file": ("hidden.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(hidden_upload, 404)

        visible_upload = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/2"
            ),
            files={"file": ("visible.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(visible_upload, 200)
        hidden_mapping = client.put(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/photos/mapping"
            ),
            json={"pages": {"0": {"1": {"path": visible_upload.json()["path"]}}}},
        )
        assert_status(hidden_mapping, 404)


def test_project_comments_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id)

        admin_comment = client.post(f"/api/projects/{project_id}/comments", data={"content": "  Admin note  "})
        assert_status(admin_comment, 201)
        admin_comment_payload = admin_comment.json()
        assert admin_comment_payload["content"] == "Admin note"
        assert admin_comment_payload["author_name"] == "系統管理員"

        empty_comment = client.post(f"/api/projects/{project_id}/comments", data={"content": "   "})
        assert_status(empty_comment, 400)

        art_team, art_team_password = create_user(client, "art_team")
        teacher, teacher_password = create_user(client, "teacher")

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        teacher_comment = client.post(f"/api/projects/{project_id}/comments", data={"content": "blocked"})
        assert_status(teacher_comment, 403)

        client.cookies.clear()
        login(client, art_team["username"], art_team_password)
        art_comment = client.post(f"/api/projects/{project_id}/comments", data={"content": "Art note"})
        assert_status(art_comment, 201)

        comments = client.get(f"/api/projects/{project_id}/comments")
        assert_status(comments, 200)
        assert [comment["content"] for comment in comments.json()] == ["Admin note", "Art note"]

        delete_other_comment = client.delete(f"/api/projects/{project_id}/comments/{admin_comment_payload['id']}")
        assert_status(delete_other_comment, 403)
        delete_own_comment = client.delete(f"/api/projects/{project_id}/comments/{art_comment.json()['id']}")
        assert_status(delete_own_comment, 200)

        client.cookies.clear()
        login(client)
        delete_remaining = client.delete(f"/api/projects/{project_id}/comments/{admin_comment_payload['id']}")
        assert_status(delete_remaining, 200)


def test_photo_render_and_download_contracts(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client, photo_slot_count=2)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("render_project"),
            student_names=["Render Student"],
        )
        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        student_id = detail.json()["students"][0]["id"]

        photo_upload = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"
            ),
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo_upload, 200)
        uploaded_path = photo_upload.json()["path"]
        uploaded_filename = uploaded_path.rsplit("/", 1)[-1]
        assert uploaded_filename.startswith("p0_slot1_smoke_")
        assert uploaded_filename.endswith(".jpg")

        get_photo = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1")
        assert_status(get_photo, 200)
        assert get_photo.headers["content-type"].startswith("image/jpeg")
        assert get_photo.content.startswith(b"\xff\xd8")

        student_preview = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_preview, 200)
        assert student_preview.headers["content-type"].startswith("image/png")
        assert student_preview.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert "private" in student_preview.headers["cache-control"]
        assert "no-cache" in student_preview.headers["cache-control"]
        assert student_preview.headers["etag"]

        stale_student_default = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/batch/texts"),
            json={"students": {str(student_id): {"0": {"1": "{name} smoke label"}}}},
        )
        assert_status(stale_student_default, 200)

        blank_texts = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/label_texts"),
            json={"0": {"1": ""}},
        )
        assert_status(blank_texts, 200)

        project_blank_preview = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_blank_preview, 200)
        assert "private" in project_blank_preview.headers["cache-control"]
        assert "no-cache" in project_blank_preview.headers["cache-control"]
        assert project_blank_preview.headers["x-preview-cache"] == "MISS"
        assert project_blank_preview.headers["etag"]
        project_preview_key = project_blank_preview.headers["x-preview-cache-key"]
        assert project_preview_key.endswith(".png")
        assert (tmp_path / "uploads" / project_preview_key).exists()
        with Image.open(BytesIO(project_blank_preview.content)) as preview_image:
            assert preview_image.format == "PNG"
            assert preview_image.size == (556, 786)
            assert count_non_whiteish_pixels(
                preview_image,
                scale_box_for_image((96, 340, 456, 436), preview_image),
            ) < 5

        project_blank_preview_cached = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_blank_preview_cached, 200)
        assert "no-cache" in project_blank_preview_cached.headers["cache-control"]
        assert project_blank_preview_cached.headers["x-preview-cache"] == "HIT"
        assert project_blank_preview_cached.content == project_blank_preview.content
        project_blank_preview_not_modified = client.get(
            f"/api/projects/{project_id}/preview/0",
            headers={"If-None-Match": project_blank_preview.headers["etag"]},
        )
        assert_status(project_blank_preview_not_modified, 304)
        assert project_blank_preview_not_modified.content == b""
        assert (
            project_blank_preview_not_modified.headers["etag"]
            == project_blank_preview.headers["etag"]
        )

        student_blank_preview = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_blank_preview, 200)
        assert "no-cache" in student_blank_preview.headers["cache-control"]
        assert student_blank_preview.headers["x-preview-cache"] == "MISS"
        assert student_blank_preview.headers["etag"]
        student_preview_key = student_blank_preview.headers["x-preview-cache-key"]
        assert student_preview_key.endswith(".png")
        assert (tmp_path / "uploads" / student_preview_key).exists()
        with Image.open(BytesIO(student_blank_preview.content)) as preview_image:
            assert preview_image.format == "PNG"
            assert preview_image.size == (556, 786)
            assert count_non_whiteish_pixels(
                preview_image,
                scale_box_for_image((96, 340, 456, 436), preview_image),
            ) < 5

        student_blank_preview_cached = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_blank_preview_cached, 200)
        assert "no-cache" in student_blank_preview_cached.headers["cache-control"]
        assert student_blank_preview_cached.headers["x-preview-cache"] == "HIT"
        assert student_blank_preview_cached.content == student_blank_preview.content
        student_blank_preview_not_modified = client.get(
            f"/api/projects/{project_id}/students/{student_id}/preview/0",
            headers={"If-None-Match": student_blank_preview.headers["etag"]},
        )
        assert_status(student_blank_preview_not_modified, 304)
        assert student_blank_preview_not_modified.content == b""

        render_response = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(render_response, 200)
        render_payload = render_response.json()
        assert render_payload["pages"] == 1
        assert render_payload["pdf"].endswith(".pdf")
        assert render_payload["skipped"] is False

        # dirty-skip：內容未變的重渲直接沿用既有輸出
        rerender_response = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(rerender_response, 200)
        assert rerender_response.json()["skipped"] is True
        assert rerender_response.json()["pdf"] == render_payload["pdf"]
        assert rerender_response.json()["pages"] == 1

        download_paths = [
            f"/api/projects/{project_id}/students/{student_id}/pdf?mode=print",
            f"/api/projects/{project_id}/students/{student_id}/images",
            f"/api/projects/{project_id}/students/{student_id}/images/1",
            f"/api/projects/{project_id}/download/all?mode=screen",
            f"/api/projects/{project_id}/download/all/images?mode=screen",
        ]
        for download_path in download_paths:
            download_before_completion = client.get(download_path)
            assert_status(download_before_completion, 409)
            assert download_before_completion.json()["detail"] == "請先標記全班完成，再下載 PDF 或圖片"

        complete = client.post(f"/api/projects/{project_id}/complete")
        assert_status(complete, 200)
        assert complete.json()["completed_at"] is not None

        download_pdf = client.get(f"/api/projects/{project_id}/students/{student_id}/pdf?mode=print")
        assert_status(download_pdf, 200)
        assert download_pdf.headers["content-type"].startswith("application/pdf")
        assert download_pdf.headers["content-disposition"].startswith("attachment;")
        assert download_pdf.content.startswith(b"%PDF")

        download_images = client.get(f"/api/projects/{project_id}/students/{student_id}/images")
        assert_status(download_images, 200)
        assert download_images.headers["content-type"].startswith("application/zip")
        assert download_images.headers["content-disposition"].startswith("attachment;")
        assert download_images.content.startswith(b"PK")
        with ZipFile(BytesIO(download_images.content)) as image_zip:
            image_names = image_zip.namelist()
            assert len(image_names) == 1
            assert image_names[0].endswith("_page1.jpg")
            image_bytes = image_zip.read(image_names[0])
            assert image_bytes.startswith(b"\xff\xd8")
            with Image.open(BytesIO(image_bytes)) as exported_image:
                assert exported_image.size == PRINT_OUTPUT_SIZE

        download_image = client.get(f"/api/projects/{project_id}/students/{student_id}/images/1")
        assert_status(download_image, 200)
        assert download_image.headers["content-type"].startswith("image/jpeg")
        assert download_image.headers["content-disposition"].startswith("attachment;")
        assert download_image.content.startswith(b"\xff\xd8")
        with Image.open(BytesIO(download_image.content)) as exported_image:
            assert exported_image.size == PRINT_OUTPUT_SIZE

        download_screen_images = client.get(f"/api/projects/{project_id}/students/{student_id}/images?mode=screen")
        assert_status(download_screen_images, 200)
        with ZipFile(BytesIO(download_screen_images.content)) as image_zip:
            image_names = image_zip.namelist()
            assert len(image_names) == 1
            assert image_names[0].endswith("_screen_page1.jpg")
            with Image.open(BytesIO(image_zip.read(image_names[0]))) as exported_image:
                assert exported_image.size == (794, 1123)

        download_screen_image = client.get(f"/api/projects/{project_id}/students/{student_id}/images/1?mode=screen")
        assert_status(download_screen_image, 200)
        with Image.open(BytesIO(download_screen_image.content)) as exported_image:
            assert exported_image.size == (794, 1123)
            assert count_non_whiteish_pixels(exported_image, (96, 340, 456, 436)) < 5

        missing_page_image = client.get(f"/api/projects/{project_id}/students/{student_id}/images/2")
        assert_status(missing_page_image, 404)

        render_all = client.post(f"/api/projects/{project_id}/render/all")
        assert_status(render_all, 200)
        assert render_all.json()["errors"] == []
        assert render_all.json()["rendered"][0]["student"] == "RenderStudent"

        download_all = client.get(f"/api/projects/{project_id}/download/all?mode=screen")
        assert_status(download_all, 200)
        assert download_all.headers["content-type"].startswith("application/zip")
        assert download_all.headers["content-disposition"].startswith("attachment;")
        assert download_all.content.startswith(b"PK")

        download_all_images = client.get(f"/api/projects/{project_id}/download/all/images?mode=screen")
        assert_status(download_all_images, 200)
        assert download_all_images.headers["content-type"].startswith("application/zip")
        assert download_all_images.headers["content-disposition"].startswith("attachment;")
        assert download_all_images.content.startswith(b"PK")
        with ZipFile(BytesIO(download_all_images.content)) as all_image_zip:
            all_image_names = all_image_zip.namelist()
            assert len(all_image_names) == 1
            assert all_image_names[0].count("/") == 1
            assert all_image_names[0].endswith("_screen_page1.jpg")

        reopen = client.post(f"/api/projects/{project_id}/reopen")
        assert_status(reopen, 200)
        download_after_reopen = client.get(f"/api/projects/{project_id}/students/{student_id}/pdf")
        assert_status(download_after_reopen, 409)
        assert download_after_reopen.json()["detail"] == "請先標記全班完成，再下載 PDF 或圖片"

        mapping_response = client.put(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_id}/photos/mapping"
            ),
            json={
                "pages": {
                    "0": {
                        "2": {"path": uploaded_path, "scale": 1.25, "offset_x": 0.1, "offset_y": -0.1},
                        "1": None,
                    }
                }
            },
        )
        assert_status(mapping_response, 200)
        assert mapping_response.json()["renames"] == {}

        final_detail = client.get(f"/api/projects/{project_id}")
        assert_status(final_detail, 200)
        photos = final_detail.json()["students"][0]["pages_data"][0]["photos"]
        assert "1" not in photos
        assert photos["2"]["path"] == uploaded_path
        assert photos["2"]["scale"] == 1.25

        missing_old_photo = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1")
        assert_status(missing_old_photo, 404)
        moved_photo = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/2")
        assert_status(moved_photo, 200)

        # 內容變更（照片換格）後 dirty-skip 失效，重渲會真的重做
        rerender_after_edit = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(rerender_after_edit, 200)
        assert rerender_after_edit.json()["skipped"] is False


def test_preview_cache_survives_other_student_edits(monkeypatch, tmp_path):
    """預覽快取為純內容定址：改 B 學生不作廢 A 學生的快取；改 A 自己才 MISS。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("cache_scope"),
            student_names=["Cache A", "Cache B"],
        )
        detail = client.get(f"/api/projects/{project_id}")
        student_a, student_b = [s["id"] for s in detail.json()["students"]]

        # 暖 A 的快取
        first = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert_status(first, 200)
        assert first.headers["x-preview-cache"] == "MISS"
        warmed = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert warmed.headers["x-preview-cache"] == "HIT"

        # 改 B 的文字（會 bump project.updated_at）→ A 的快取必須仍然 HIT
        edit_b = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/batch/texts"),
            json={"students": {str(student_b): {"0": {"1": "B 的字"}}}},
        )
        assert_status(edit_b, 200)
        still_hit = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert still_hit.headers["x-preview-cache"] == "HIT"

        # 改 A 自己的文字 → A 的快取換 key，MISS 重渲染
        edit_a = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/batch/texts"),
            json={"students": {str(student_a): {"0": {"1": "A 的字"}}}},
        )
        assert_status(edit_a, 200)
        after_own_edit = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert after_own_edit.headers["x-preview-cache"] == "MISS"

        # 同名重傳（key 不變、bytes 變）→ v 欄位換 hash，快取 MISS
        upload_1 = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_a}/pages/0/photos/1"
            ),
            files={"file": ("same.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload_1, 200)
        client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        warmed_photo = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert warmed_photo.headers["x-preview-cache"] == "HIT"
        upload_2 = client.post(
            revisioned_project_url(
                client, project_id, f"/api/projects/{project_id}/students/{student_a}/pages/0/photos/1"
            ),
            files={"file": ("same.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload_2, 200)
        after_reupload = client.get(f"/api/projects/{project_id}/students/{student_a}/preview/0")
        assert after_reupload.headers["x-preview-cache"] == "MISS"


def test_concurrent_photo_and_text_writes_do_not_clobber(monkeypatch, tmp_path):
    """pages_data 的併發寫入走學生寫鎖：照片上傳與文字自動儲存打同一學生不互相蓋寫。"""
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            name=unique_name("race_project"),
            student_names=["Race Student"],
        )
        student_id = client.get(f"/api/projects/{project_id}").json()["students"][0]["id"]

        request_errors = []
        photo_write_url = revisioned_project_url(
            client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1"
        )
        text_write_url = revisioned_project_url(
            client, project_id, f"/api/projects/{project_id}/students/{student_id}/pages/0/texts"
        )

        def upload_photo():
            try:
                response = client.post(
                    photo_write_url,
                    files={"file": ("race.jpg", jpeg_bytes(), "image/jpeg")},
                )
                assert response.status_code == 200, response.text
            except Exception as error:  # noqa: BLE001 — 執行緒內的失敗要帶回主執行緒
                request_errors.append(error)

        def save_texts(round_index: int):
            try:
                response = client.put(
                    text_write_url,
                    json={"1": f"race-text-{round_index}"},
                )
                assert response.status_code == 200, response.text
            except Exception as error:  # noqa: BLE001
                request_errors.append(error)

        # 多輪「照片上傳 × 文字儲存」同時打同一學生；沒有寫鎖時文字端會整包蓋掉照片格
        for round_index in range(4):
            photo_thread = threading.Thread(target=upload_photo)
            text_thread = threading.Thread(target=save_texts, args=(round_index,))
            photo_thread.start()
            text_thread.start()
            photo_thread.join()
            text_thread.join()

        assert request_errors == []
        page_data = client.get(f"/api/projects/{project_id}").json()["students"][0]["pages_data"][0]
        race_filename = page_data["photos"]["1"]["path"].rsplit("/", 1)[-1]
        assert race_filename.startswith("p0_slot1_race_")
        assert race_filename.endswith(".jpg")
        assert page_data["label_texts"]["1"] == "race-text-3"
