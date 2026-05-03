# FastAPI API smoke tests
# These tests exercise the real app wiring, auth cookie flow, and core route
# contracts against the tmp SQLite database configured in conftest.py.

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import uuid4

from fastapi.testclient import TestClient

from auth import hash_password
from database import SessionLocal, User
from main import app


ADMIN_PASSWORD = "admin-password-123"
USER_PASSWORD = "user-password-123"


@contextmanager
def started_client() -> Iterator[TestClient]:
    with TestClient(app) as client:
        reset_admin_password()
        client.cookies.clear()
        yield client


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


def login(client: TestClient, username: str = "admin", password: str = ADMIN_PASSWORD) -> dict:
    response = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
    )
    assert_status(response, 200)
    return response.json()


def create_user(client: TestClient, role: str, supervisor_id: int | None = None) -> tuple[dict, str]:
    username = unique_name(role)
    payload = {
        "username": username,
        "display_name": f"{role} user",
        "password": USER_PASSWORD,
        "role": role,
    }
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
        data={"name": name or unique_name("project"), "template_id": template_id},
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
        assert client.cookies.get("access_token")

        me = client.get("/api/auth/me")
        assert_status(me, 200)
        assert me.json()["username"] == "admin"

        logout = client.post("/api/auth/logout")
        assert_status(logout, 200)
        assert "access_token=" in logout.headers["set-cookie"]

        client.cookies.clear()
        after_logout = client.get("/api/auth/me")
        assert_status(after_logout, 401)


def test_template_project_student_and_text_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)

        templates = client.get("/api/templates/")
        assert_status(templates, 200)
        assert any(template["id"] == template_id and template["page_count"] == 1 for template in templates.json())

        template_detail = client.get(f"/api/templates/{template_id}")
        assert_status(template_detail, 200)
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


def test_role_access_and_none_login_contracts():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        admin_project_id = create_project(client, template_id, name=unique_name("admin_project"))

        supervisor, supervisor_password = create_user(client, "supervisor")
        teacher, teacher_password = create_user(client, "teacher", supervisor_id=supervisor["id"])
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
        assert template_preview.content.startswith(b"\xff\xd8")

        project_preview = client.get(f"/api/projects/{project_id}/preview/0")
        assert_status(project_preview, 200)
        assert project_preview.headers["content-type"].startswith("image/jpeg")
        assert project_preview.content.startswith(b"\xff\xd8")
