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
) -> tuple[int, int]:
    template_response = client.post("/api/templates/", data={"name": name or unique_name("template")})
    assert_status(template_response, 200)
    template_id = template_response.json()["id"]

    page_response = client.post(f"/api/templates/{template_id}/pages")
    assert_status(page_response, 200)
    page_id = page_response.json()["id"]

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
    layout_response = client.put(
        f"/api/templates/{template_id}/pages/{page_id}/layout",
        json=layout,
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
