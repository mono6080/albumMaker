# FastAPI API smoke tests
# These tests exercise the real app wiring, auth cookie flow, and core route
# contracts against the tmp SQLite database configured in conftest.py.

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from io import BytesIO
from uuid import uuid4
from zipfile import ZipFile

from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image
from starlette.responses import Response

from auth import hash_password
from database import Project, SessionLocal, User
from main import (
    FRONTEND_APP_CACHE_CONTROL,
    FRONTEND_ASSET_CACHE_CONTROL,
    app,
    apply_frontend_cache_headers,
    limiter as app_limiter,
)
from routers.auth import limiter as auth_limiter


ADMIN_PASSWORD = "admin-password-123"
USER_PASSWORD = "user-password-123"


@contextmanager
def started_client() -> Iterator[TestClient]:
    reset_rate_limits()
    with TestClient(app) as client:
        reset_admin_password()
        client.cookies.clear()
        yield client


def reset_rate_limits() -> None:
    for limiter in (app_limiter, auth_limiter):
        storage = getattr(limiter, "_storage", None)
        if storage is not None:
            storage.reset()


def reset_admin_password() -> None:
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").one()
        admin.hashed_password = hash_password(ADMIN_PASSWORD)
        db.commit()
    finally:
        db.close()


def unique_name(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:8]}"


def assert_status(response, status_code: int) -> None:
    assert response.status_code == status_code, response.text


def use_tmp_uploads(monkeypatch, tmp_path) -> None:
    from services import render_service

    monkeypatch.setattr(render_service, "UPLOADS_DIR", tmp_path / "uploads")


def jpeg_bytes(color: tuple[int, int, int] = (240, 72, 72)) -> bytes:
    image = Image.new("RGB", (96, 72), color)
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def png_bytes(size: tuple[int, int], color: tuple[int, int, int, int] = (240, 72, 72, 255)) -> bytes:
    image = Image.new("RGBA", size, color)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def count_non_whiteish_pixels(image: Image.Image, box: tuple[int, int, int, int], threshold: int = 245) -> int:
    sample = image.crop(box).convert("RGB")
    return sum(
        1
        for pixel in sample.getdata()
        if any(channel < threshold for channel in pixel)
    )


def scale_box_for_image(box: tuple[int, int, int, int], image: Image.Image) -> tuple[int, int, int, int]:
    scale_x = image.width / 794
    scale_y = image.height / 1123
    return (
        round(box[0] * scale_x),
        round(box[1] * scale_y),
        round(box[2] * scale_x),
        round(box[3] * scale_y),
    )


def workbook_bytes(rows: list[list[object]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def login(client: TestClient, username: str = "admin", password: str = ADMIN_PASSWORD) -> dict:
    response = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
    )
    assert_status(response, 200)
    return response.json()


def create_user(
    client: TestClient,
    role: str,
    supervisor_id: int | None = None,
    supervisor_ids: list[int] | None = None,
) -> tuple[dict, str]:
    username = unique_name(role)
    payload: dict[str, object] = {
        "username": username,
        "display_name": f"{role} user",
        "password": USER_PASSWORD,
        "role": role,
    }
    if supervisor_ids is not None:
        payload["supervisor_ids"] = supervisor_ids
    if supervisor_id is not None:
        payload["supervisor_id"] = supervisor_id

    response = client.post("/api/users/", json=payload)
    assert_status(response, 201)
    return response.json(), USER_PASSWORD


def smoke_layout() -> dict:
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "photo_slots": [
            {
                "id": 1,
                "x": 48,
                "y": 96,
                "width": 240,
                "height": 180,
                "border": True,
                "border_width": 8,
            }
        ],
        "text_bubbles": [],
        "text_labels": [
            {
                "id": 1,
                "x": 96,
                "y": 340,
                "width": 360,
                "height": 96,
                "text": "{name} smoke label",
                "font_size": 24,
                "font_color": "#333333",
            }
        ],
        "stickers": [],
        "footer": None,
        "logo": None,
    }


def create_template_with_page(client: TestClient, name: str | None = None) -> tuple[int, int]:
    template_response = client.post("/api/templates/", data={"name": name or unique_name("template")})
    assert_status(template_response, 200)
    template_id = template_response.json()["id"]

    page_response = client.post(f"/api/templates/{template_id}/pages")
    assert_status(page_response, 200)
    page_id = page_response.json()["id"]

    layout_response = client.put(
        f"/api/templates/{template_id}/pages/{page_id}/layout",
        json=smoke_layout(),
    )
    assert_status(layout_response, 200)
    assert layout_response.json() == {"ok": True}

    return template_id, page_id


def create_project(client: TestClient, template_id: int, name: str | None = None) -> int:
    response = client.post(
        "/api/projects/",
        data={"name": name or unique_name("project"), "template_id": str(template_id)},
    )
    assert_status(response, 201)
    return response.json()["id"]


def test_health_and_auth_cookie_roundtrip():
    with started_client() as client:
        health = client.get("/api/health")
        assert_status(health, 200)
        assert health.json() == {"status": "ok"}

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

        project_id = create_project(client, template_id)
        project_list = client.get("/api/projects/")
        assert_status(project_list, 200)
        assert any(project["id"] == project_id and project["student_count"] == 0 for project in project_list.json())

        batch_response = client.post(
            f"/api/projects/{project_id}/students/batch",
            json=[" Alice ", "Bob", "Alice", ""],
        )
        assert_status(batch_response, 200)
        assert batch_response.json() == {"created": ["Alice", "Bob"], "skipped": ["Alice"]}

        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        students_by_name = {student["name"]: student for student in detail.json()["students"]}
        student_id = students_by_name["Alice"]["id"]

        rename_student = client.put(
            f"/api/projects/{project_id}/students/{student_id}",
            data={"name": "Alice Chen"},
        )
        assert_status(rename_student, 200)

        skip_response = client.patch(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/skip",
            json={"skip": True},
        )
        assert_status(skip_response, 200)
        assert skip_response.json() == {"ok": True}

        project_label_texts = {"0": {"1": "Class label text"}}
        update_project_texts = client.put(
            f"/api/projects/{project_id}/label_texts",
            json=project_label_texts,
        )
        assert_status(update_project_texts, 200)
        get_project_texts = client.get(f"/api/projects/{project_id}/label_texts")
        assert_status(get_project_texts, 200)
        assert get_project_texts.json() == project_label_texts

        update_student_texts = client.put(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/texts",
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
        update_batch_texts = client.put(f"/api/projects/{project_id}/batch/texts", json=batch_texts)
        assert_status(update_batch_texts, 200)

        final_detail = client.get(f"/api/projects/{project_id}")
        assert_status(final_detail, 200)
        final_payload = final_detail.json()
        assert final_payload["label_texts"] == project_label_texts
        renamed_student = next(student for student in final_payload["students"] if student["id"] == student_id)
        assert renamed_student["name"] == "Alice Chen"
        assert renamed_student["pages_data"][0]["skip"] is True
        assert renamed_student["pages_data"][0]["label_texts"] == {"1": "Batch label text"}


def test_user_management_allows_multiple_teacher_supervisors():
    with started_client() as client:
        login(client)
        first_supervisor, _ = create_user(client, "supervisor")
        second_supervisor, _ = create_user(client, "supervisor")
        teacher, _ = create_user(
            client,
            "teacher",
            supervisor_ids=[first_supervisor["id"], second_supervisor["id"]],
        )

        assert teacher["supervisor_id"] == first_supervisor["id"]
        assert teacher["supervisor_ids"] == [first_supervisor["id"], second_supervisor["id"]]
        assert teacher["supervisor_names"] == [
            first_supervisor["display_name"],
            second_supervisor["display_name"],
        ]

        users_response = client.get("/api/users/")
        assert_status(users_response, 200)
        listed_teacher = next(user for user in users_response.json() if user["id"] == teacher["id"])
        assert listed_teacher["supervisor_ids"] == [first_supervisor["id"], second_supervisor["id"]]

        third_supervisor, _ = create_user(client, "supervisor")
        update_response = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_ids": [second_supervisor["id"], third_supervisor["id"]]},
        )
        assert_status(update_response, 200)
        updated_teacher = update_response.json()
        assert updated_teacher["supervisor_id"] == second_supervisor["id"]
        assert updated_teacher["supervisor_ids"] == [second_supervisor["id"], third_supervisor["id"]]

        legacy_update = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_id": first_supervisor["id"]},
        )
        assert_status(legacy_update, 200)
        assert legacy_update.json()["supervisor_ids"] == [first_supervisor["id"]]

        invalid_supervisor = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_ids": [teacher["id"]]},
        )
        assert_status(invalid_supervisor, 400)

        restore_multiple = client.patch(
            f"/api/users/{teacher['id']}",
            json={"supervisor_ids": [first_supervisor["id"], second_supervisor["id"]]},
        )
        assert_status(restore_multiple, 200)
        demote_first_supervisor = client.patch(
            f"/api/users/{first_supervisor['id']}",
            json={"role": "none"},
        )
        assert_status(demote_first_supervisor, 200)
        after_demote_users = client.get("/api/users/")
        assert_status(after_demote_users, 200)
        teacher_after_demote = next(user for user in after_demote_users.json() if user["id"] == teacher["id"])
        assert teacher_after_demote["supervisor_ids"] == [second_supervisor["id"]]


def test_project_delete_archives_and_restore_recovers():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("archive_project"))

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
            archived_project.archive_expires_at = datetime.utcnow() - timedelta(days=1)
            db.commit()
        finally:
            db.close()

        expired_archive = client.get("/api/projects/archive")
        assert_status(expired_archive, 200)
        assert project_id not in {project["id"] for project in expired_archive.json()}

        expired_restore = client.post(f"/api/projects/{project_id}/restore")
        assert_status(expired_restore, 410)


def test_admin_can_import_users_from_excel():
    with started_client() as client:
        login(client)
        supervisor_username = unique_name("bulk_supervisor")
        teacher_username = unique_name("bulk_teacher")
        bad_teacher_username = unique_name("bad_teacher")

        excel_payload = workbook_bytes([
            ["帳號", "顯示名稱", "初始密碼", "角色", "主管帳號"],
            [supervisor_username, "匯入主管", "supervisor-pass", "主管", ""],
            [teacher_username, "匯入老師", "teacher-pass", "帶班老師", supervisor_username],
            ["admin", "Existing Admin", "password", "管理員", ""],
            [supervisor_username, "Duplicate Supervisor", "password", "主管", ""],
            [bad_teacher_username, "錯誤老師", "teacher-pass", "老師", "missing_supervisor"],
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
        assert payload["errors"][0]["username"] == bad_teacher_username
        assert "找不到主管" in payload["errors"][0]["error"]

        users_response = client.get("/api/users/")
        assert_status(users_response, 200)
        users_by_username = {user["username"]: user for user in users_response.json()}
        supervisor = users_by_username[supervisor_username]
        teacher = users_by_username[teacher_username]
        assert supervisor["role"] == "supervisor"
        assert teacher["role"] == "teacher"
        assert teacher["supervisor_ids"] == [supervisor["id"]]

        client.cookies.clear()
        login_payload = login(client, teacher_username, "teacher-pass")
        assert login_payload["role"] == "teacher"


def test_admin_can_reset_user_password_to_short_value():
    with started_client() as client:
        login(client)
        art_team, _ = create_user(client, "art_team")

        reset_response = client.patch(
            f"/api/users/{art_team['id']}",
            json={"new_password": "admin"},
        )
        assert_status(reset_response, 200)

        client.cookies.clear()
        login_payload = login(client, art_team["username"], "admin")
        assert login_payload["username"] == art_team["username"]
        assert login_payload["role"] == "art_team"


def test_admin_can_create_user_with_short_initial_password():
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
        assert_status(create_response, 201)

        client.cookies.clear()
        login_payload = login(client, username, "admin")
        assert login_payload["username"] == username
        assert login_payload["role"] == "art_team"


def test_role_access_and_none_login_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        admin_project_id = create_project(client, template_id, name=unique_name("admin_project"))

        supervisor, supervisor_password = create_user(client, "supervisor")
        second_supervisor, second_supervisor_password = create_user(client, "supervisor")
        teacher, teacher_password = create_user(
            client,
            "teacher",
            supervisor_ids=[supervisor["id"], second_supervisor["id"]],
        )
        art_team, art_team_password = create_user(client, "art_team")
        none_user, none_password = create_user(client, "none")

        client.cookies.clear()
        none_login = client.post(
            "/api/auth/login",
            data={"username": none_user["username"], "password": none_password},
        )
        assert_status(none_login, 403)
        assert not client.cookies.get("access_token")

        login(client, teacher["username"], teacher_password)
        teacher_project_id = create_project(client, template_id, name=unique_name("teacher_project"))

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
        supervisor_own_project_id = create_project(client, template_id, name=unique_name("supervisor_project"))
        supervisor_writes_own = client.patch(
            f"/api/projects/{supervisor_own_project_id}",
            data={"name": "supervisor updated"},
        )
        assert_status(supervisor_writes_own, 200)
        supervisor_adds_own_students = client.post(
            f"/api/projects/{supervisor_own_project_id}/students/batch",
            json=["Supervisor Student"],
        )
        assert_status(supervisor_adds_own_students, 200)

        client.cookies.clear()
        login(client, second_supervisor["username"], second_supervisor_password)
        second_supervisor_projects = client.get("/api/projects/")
        assert_status(second_supervisor_projects, 200)
        second_supervisor_project_ids = {project["id"] for project in second_supervisor_projects.json()}
        assert teacher_project_id in second_supervisor_project_ids
        assert supervisor_own_project_id not in second_supervisor_project_ids
        second_supervisor_reads_teacher = client.get(f"/api/projects/{teacher_project_id}")
        assert_status(second_supervisor_reads_teacher, 200)

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        teacher_projects_after_supervisor_create = client.get("/api/projects/")
        assert_status(teacher_projects_after_supervisor_create, 200)
        teacher_project_ids_after_supervisor_create = {
            project["id"] for project in teacher_projects_after_supervisor_create.json()
        }
        assert supervisor_own_project_id not in teacher_project_ids_after_supervisor_create

        client.cookies.clear()
        login(client, art_team["username"], art_team_password)
        art_template = client.post("/api/templates/", data={"name": unique_name("art_template")})
        assert_status(art_template, 200)
        art_project = client.post(
            "/api/projects/",
            data={"name": unique_name("art_project"), "template_id": template_id},
        )
        assert_status(art_project, 403)
        art_reads_admin = client.get(f"/api/projects/{admin_project_id}")
        assert_status(art_reads_admin, 200)
        art_writes_admin = client.patch(f"/api/projects/{admin_project_id}", data={"name": "blocked"})
        assert_status(art_writes_admin, 403)


def test_public_preview_endpoints_do_not_require_auth():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        project_id = create_project(client, template_id)

        client.cookies.clear()
        template_preview = client.get(f"/api/templates/{template_id}/pages/{page_id}/preview")
        assert_status(template_preview, 200)
        assert template_preview.headers["content-type"].startswith("image/jpeg")
        assert "no-store" in template_preview.headers["cache-control"]
        assert template_preview.content.startswith(b"\xff\xd8")

        spread_preview = client.get(f"/api/templates/{template_id}/spread-preview/0")
        assert_status(spread_preview, 200)
        assert spread_preview.headers["content-type"].startswith("image/jpeg")
        assert "no-store" in spread_preview.headers["cache-control"]
        assert spread_preview.content.startswith(b"\xff\xd8")
        with Image.open(BytesIO(spread_preview.content)) as spread_image:
            assert spread_image.size == (1588, 1123)

        project_preview = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_preview, 200)
        assert project_preview.headers["content-type"].startswith("image/jpeg")
        assert "no-store" in project_preview.headers["cache-control"]
        assert project_preview.content.startswith(b"\xff\xd8")


def test_template_spread_preview_uses_page_background_column(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        blank_layout = {
            "canvas_width": 794,
            "canvas_height": 1123,
            "photo_slots": [],
            "text_bubbles": [],
            "text_labels": [],
            "stickers": [],
            "footer": None,
            "logo": None,
        }
        layout_response = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            json=blank_layout,
        )
        assert_status(layout_response, 200)

        background_upload = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/background",
            files={"file": ("red.png", png_bytes((20, 20), (230, 20, 20, 255)), "image/png")},
        )
        assert_status(background_upload, 200)

        # 模擬 TemplateEditor 後續儲存版面時只送元素 layout，導致 layout_json 不含 background_filename。
        layout_without_background = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            json=blank_layout,
        )
        assert_status(layout_without_background, 200)

        client.cookies.clear()
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
        assert payload == {
            "path": f"templates/tmpl{template_id}/stickers/wide.png",
            "filename": "wide.png",
            "width": 320,
            "height": 120,
        }

        sticker = client.get(f"/api/templates/{template_id}/stickers/wide.png")
        assert_status(sticker, 200)
        with Image.open(BytesIO(sticker.content)) as sticker_image:
            assert sticker_image.size == (320, 120)


def test_shared_project_photo_upload_applies_distinct_files(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("shared_photo_project"))

        batch_response = client.post(f"/api/projects/{project_id}/students/batch", json=["Ava", "Ben"])
        assert_status(batch_response, 200)
        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        student_ids = [student["id"] for student in detail.json()["students"]]

        shared_upload = client.post(
            f"/api/projects/{project_id}/photos/shared/pages/0/slots/1",
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
            f"/api/projects/{project_id}/students/{student_ids[0]}/photos/mapping",
            json={"pages": {"0": {"1": None}}},
        )
        assert_status(clear_first, 200)
        first_missing = client.get(f"/api/projects/{project_id}/students/{student_ids[0]}/pages/0/photos/1")
        assert_status(first_missing, 404)
        second_still_exists = client.get(f"/api/projects/{project_id}/students/{student_ids[1]}/pages/0/photos/1")
        assert_status(second_still_exists, 200)


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
        supervisor, _ = create_user(client, "supervisor")
        teacher, teacher_password = create_user(client, "teacher", supervisor_id=supervisor["id"])

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
        template_id, _ = create_template_with_page(client)
        project_id = create_project(client, template_id, name=unique_name("render_project"))

        batch_response = client.post(f"/api/projects/{project_id}/students/batch", json=["Render Student"])
        assert_status(batch_response, 200)
        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        student_id = detail.json()["students"][0]["id"]

        photo_upload = client.post(
            f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo_upload, 200)
        uploaded_path = photo_upload.json()["path"]
        assert uploaded_path.endswith("/p0_slot1_smoke.jpg")

        get_photo = client.get(f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1")
        assert_status(get_photo, 200)
        assert get_photo.headers["content-type"].startswith("image/jpeg")
        assert get_photo.content.startswith(b"\xff\xd8")

        student_preview = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_preview, 200)
        assert student_preview.headers["content-type"].startswith("image/jpeg")
        assert "no-store" in student_preview.headers["cache-control"]

        stale_student_default = client.put(
            f"/api/projects/{project_id}/batch/texts",
            json={"students": {str(student_id): {"0": {"1": "{name} smoke label"}}}},
        )
        assert_status(stale_student_default, 200)

        blank_texts = client.put(
            f"/api/projects/{project_id}/label_texts",
            json={"0": {"1": ""}},
        )
        assert_status(blank_texts, 200)

        project_blank_preview = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_blank_preview, 200)
        assert "no-store" in project_blank_preview.headers["cache-control"]
        assert project_blank_preview.headers["x-preview-cache"] == "MISS"
        project_preview_key = project_blank_preview.headers["x-preview-cache-key"]
        assert (tmp_path / "uploads" / project_preview_key).exists()
        with Image.open(BytesIO(project_blank_preview.content)) as preview_image:
            assert preview_image.size == (556, 786)
            assert count_non_whiteish_pixels(
                preview_image,
                scale_box_for_image((96, 340, 456, 436), preview_image),
            ) < 5

        project_blank_preview_cached = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_blank_preview_cached, 200)
        assert "no-store" in project_blank_preview_cached.headers["cache-control"]
        assert project_blank_preview_cached.headers["x-preview-cache"] == "HIT"
        assert project_blank_preview_cached.content == project_blank_preview.content

        student_blank_preview = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_blank_preview, 200)
        assert "no-store" in student_blank_preview.headers["cache-control"]
        assert student_blank_preview.headers["x-preview-cache"] == "MISS"
        student_preview_key = student_blank_preview.headers["x-preview-cache-key"]
        assert (tmp_path / "uploads" / student_preview_key).exists()
        with Image.open(BytesIO(student_blank_preview.content)) as preview_image:
            assert preview_image.size == (556, 786)
            assert count_non_whiteish_pixels(
                preview_image,
                scale_box_for_image((96, 340, 456, 436), preview_image),
            ) < 5

        student_blank_preview_cached = client.get(f"/api/projects/{project_id}/students/{student_id}/preview/0")
        assert_status(student_blank_preview_cached, 200)
        assert "no-store" in student_blank_preview_cached.headers["cache-control"]
        assert student_blank_preview_cached.headers["x-preview-cache"] == "HIT"
        assert student_blank_preview_cached.content == student_blank_preview.content

        render_response = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
        assert_status(render_response, 200)
        render_payload = render_response.json()
        assert render_payload["pages"] == 1
        assert render_payload["pdf"].endswith(".pdf")

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
                assert exported_image.size == (1240, 1754)

        download_image = client.get(f"/api/projects/{project_id}/students/{student_id}/images/1")
        assert_status(download_image, 200)
        assert download_image.headers["content-type"].startswith("image/jpeg")
        assert download_image.headers["content-disposition"].startswith("attachment;")
        assert download_image.content.startswith(b"\xff\xd8")
        with Image.open(BytesIO(download_image.content)) as exported_image:
            assert exported_image.size == (1240, 1754)

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
        assert render_all.json()["rendered"][0]["student"] == "Render Student"

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

        mapping_response = client.put(
            f"/api/projects/{project_id}/students/{student_id}/photos/mapping",
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
