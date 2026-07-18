# pytest 共用 helpers：TestClient 啟動、登入、建模板/專案/使用者、影像工具
# 供 test_api_smoke / test_api_edges / test_roster 等 API 測試檔具名 import

from collections.abc import Iterator
from contextlib import contextmanager
from io import BytesIO
from uuid import uuid4

from fastapi.testclient import TestClient
from openpyxl import Workbook
from PIL import Image

from auth import hash_password
from database import SessionLocal, User
from main import app, limiter as app_limiter
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


def project_template_revision(client: TestClient, project_id: int) -> int:
    response = client.get(f"/api/projects/{project_id}")
    assert_status(response, 200)
    return response.json()["template_revision"]


def template_revision(client: TestClient, template_id: int) -> int:
    response = client.get(f"/api/templates/{template_id}")
    assert_status(response, 200)
    return response.json()["revision"]


def revisioned_project_url(client: TestClient, project_id: int, url: str) -> str:
    separator = "&" if "?" in url else "?"
    revision = project_template_revision(client, project_id)
    return f"{url}{separator}expected_template_revision={revision}"


def use_tmp_uploads(monkeypatch, tmp_path) -> None:
    import app_paths

    monkeypatch.setattr(app_paths, "UPLOADS_DIR", tmp_path / "uploads")


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
        any(channel < threshold for channel in pixel)
        for pixel in sample.get_flattened_data()
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
) -> tuple[dict, str]:
    username = unique_name(role)
    payload = {
        "username": username,
        "display_name": f"{role} user",
        "password": USER_PASSWORD,
        "role": role,
    }
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


def create_template_with_page(
    client: TestClient,
    name: str | None = None,
    *,
    photo_slot_count: int = 1,
    period_id: int | None = None,
) -> tuple[int, int]:
    template_data = {"name": name or unique_name("template")}
    if period_id is not None:
        template_data["period_id"] = str(period_id)
    template_response = client.post("/api/templates/", data=template_data)
    assert_status(template_response, 200)
    template_payload = template_response.json()
    template_id = template_payload["id"]

    layout = smoke_layout()
    if photo_slot_count >= 2:
        layout["photo_slots"].append({
            "id": 2,
            "x": 360,
            "y": 96,
            "width": 240,
            "height": 180,
            "border": True,
            "border_width": 8,
        })
    snapshot_response = client.put(
        f"/api/templates/{template_id}/pages",
        json={
            "expected_page_ids": [],
            "expected_revision": template_payload["revision"],
            "pages": [{"client_id": unique_name("fixture-page"), "layout": layout}],
        },
    )
    assert_status(snapshot_response, 200)
    page_id = snapshot_response.json()["pages"][0]["id"]

    return template_id, page_id


def append_template_page_with_layout(client: TestClient, template_id: int, layout: dict) -> int:
    """正式測資一律以完整 snapshot 追加頁面。"""
    template_response = client.get(f"/api/templates/{template_id}")
    assert_status(template_response, 200)
    template = template_response.json()
    client_id = unique_name("fixture-page")
    snapshot_response = client.put(
        f"/api/templates/{template_id}/pages",
        json={
            "expected_page_ids": [page["id"] for page in template["pages"]],
            "expected_revision": template["revision"],
            "pages": [
                {"id": page["id"], "layout": page["layout"]}
                for page in template["pages"]
            ] + [{"client_id": client_id, "layout": layout}],
        },
    )
    assert_status(snapshot_response, 200)
    return next(
        page["id"]
        for page in snapshot_response.json()["pages"]
        if page["client_id"] == client_id
    )


def replace_template_page_layout(
    client: TestClient,
    template_id: int,
    page_id: int,
    layout: dict,
):
    """正式測資一律以完整 snapshot 更新單頁 layout。"""
    snapshot_payload = template_page_snapshot_payload(
        client,
        template_id,
        page_id,
        layout,
    )
    snapshot_response = client.put(
        f"/api/templates/{template_id}/pages",
        json=snapshot_payload,
    )
    assert_status(snapshot_response, 200)
    return snapshot_response


def template_page_snapshot_payload(
    client: TestClient,
    template_id: int,
    page_id: int,
    layout: dict,
) -> dict:
    """建立保留其他頁面的單頁 layout snapshot payload。"""
    template_response = client.get(f"/api/templates/{template_id}")
    assert_status(template_response, 200)
    template = template_response.json()
    return {
        "expected_page_ids": [page["id"] for page in template["pages"]],
        "expected_revision": template["revision"],
        "pages": [
            {
                "id": page["id"],
                "layout": layout if page["id"] == page_id else page["layout"],
            }
            for page in template["pages"]
        ],
    }


def _create_classroom_with_lead(
    client: TestClient,
    template_id: int,
    lead_teacher_id: int | None = None,
    student_names: list[str] | None = None,
) -> tuple[int, int, list[int]]:
    template_response = client.get(f"/api/templates/{template_id}")
    assert_status(template_response, 200)
    template = template_response.json()
    assert template["period_status"] == "active"
    department = template["department"]
    assert department in {"infant", "academy"}

    if lead_teacher_id is None:
        lead_teacher, _ = create_user(client, "teacher")
        lead_teacher_id = lead_teacher["id"]
    else:
        db = SessionLocal()
        try:
            lead_teacher = db.get(User, lead_teacher_id)
            assert lead_teacher is not None
            assert lead_teacher.role == "teacher"
        finally:
            db.close()

    campus_response = client.post(
        "/api/organization/campuses",
        json={"name": unique_name("fixture-campus"), "is_active": True},
    )
    assert_status(campus_response, 201)
    classroom_response = client.post(
        "/api/organization/classrooms",
        json={
            "campus_id": campus_response.json()["id"],
            "department": department,
            "name": unique_name("fixture-classroom"),
            "is_active": True,
        },
    )
    assert_status(classroom_response, 201)
    classroom_id = classroom_response.json()["id"]
    teachers_response = client.put(
        f"/api/organization/classrooms/{classroom_id}/teachers",
        json={"teachers": [{"teacher_id": lead_teacher_id, "duty": "lead"}]},
    )
    assert_status(teachers_response, 200)
    member_ids: list[int] = []
    if student_names:
        members_response = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/batch",
            json={"members": [{"name": name} for name in student_names]},
        )
        assert_status(members_response, 201)
        member_ids = [member["id"] for member in members_response.json()["created"]]
        assert len(member_ids) == len(student_names)
    return classroom_id, lead_teacher_id, member_ids


def _end_fixture_roster_members(
    client: TestClient,
    classroom_id: int,
    member_ids: list[int],
) -> None:
    """相本快照建立後結束測試名單，讓跨測試固定姓名可再次入班。"""
    for member_id in member_ids:
        response = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/{member_id}",
            json={"status": "ended", "end_reason": "departed"},
        )
        assert_status(response, 200)


def _find_classroom_work_slot_id(
    client: TestClient,
    classroom_id: int,
    template_id: int,
) -> int:
    """找出指定班級與版型尚未啟動的正式工作槽。"""
    overview_response = client.get("/api/organization/overview")
    assert_status(overview_response, 200)
    return next(
        work_slot["id"]
        for work_slot in overview_response.json()["work_slots"]
        if work_slot["classroom_id"] == classroom_id
        and template_id in work_slot["template_ids"]
        and work_slot["can_create_project"]
    )


def create_project(
    client: TestClient,
    template_id: int,
    name: str | None = None,
    *,
    student_names: list[str] | None = None,
) -> int:
    effective_student_names = (
        student_names
        if student_names is not None
        else [unique_name("fixture_student")]
    )
    classroom_id, lead_teacher_id, member_ids = _create_classroom_with_lead(
        client,
        template_id,
        student_names=effective_student_names,
    )
    work_slot_id = _find_classroom_work_slot_id(client, classroom_id, template_id)
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json={
            "name": name or unique_name("project"),
            "template_id": template_id,
            "work_slot_id": work_slot_id,
            "owner_id": lead_teacher_id,
        },
    )
    assert_status(response, 201)
    _end_fixture_roster_members(client, classroom_id, member_ids)
    return response.json()["id"]


def create_project_for_owner(
    client: TestClient,
    template_id: int,
    owner_id: int,
    name: str | None = None,
    *,
    student_names: list[str] | None = None,
) -> int:
    """建立由指定目前老師帶班的班級相本。"""
    effective_student_names = (
        student_names
        if student_names is not None
        else [unique_name("fixture_student")]
    )
    classroom_id, _, member_ids = _create_classroom_with_lead(
        client,
        template_id,
        owner_id,
        effective_student_names,
    )
    work_slot_id = _find_classroom_work_slot_id(client, classroom_id, template_id)
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json={
            "name": name or unique_name("project"),
            "template_id": template_id,
            "work_slot_id": work_slot_id,
            "owner_id": owner_id,
        },
    )
    assert_status(response, 201)
    _end_fixture_roster_members(client, classroom_id, member_ids)
    return response.json()["id"]
