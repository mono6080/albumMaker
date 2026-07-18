import hashlib
import json
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from database import SessionLocal, TemplatePage
from services import template_asset_service
from services.layout_groups import MAX_JAVASCRIPT_SAFE_INTEGER
from services.material_text_box import (
    DETECTOR_VERSION,
    analyze_material_text_box,
    decode_rgba_image,
    project_normalized_box_to_sticker,
    rgba_asset_revision,
)
from services.storage import get_storage
from tests.helpers import (
    USER_PASSWORD,
    assert_status,
    create_template_with_page,
    create_user,
    login,
    started_client,
    use_tmp_uploads,
)


def _material_png(size=(96, 64), color=(248, 205, 78, 255)) -> bytes:
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 4, size[0] - 5, size[1] - 5), radius=10, fill=color)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _expected_revision(data: bytes) -> str:
    with Image.open(BytesIO(data)) as image:
        rgba = decode_rgba_image(image)
    return "sha256:" + hashlib.sha256(rgba.tobytes()).hexdigest()


def test_revision_uses_decoded_rgba_pixels_and_detector_returns_bounded_box():
    data = _material_png()
    with Image.open(BytesIO(data)) as image:
        rgba = decode_rgba_image(image)

    result = analyze_material_text_box(rgba)

    assert rgba_asset_revision(rgba) == _expected_revision(data)
    assert result["status"] == "suggested"
    assert result["detector_version"] == DETECTOR_VERSION
    box = result["normalized_box"]
    assert box["x"] >= 0 and box["y"] >= 0
    assert box["width"] > 0 and box["height"] > 0
    assert box["x"] + box["width"] <= 1
    assert box["y"] + box["height"] <= 1


def test_normalized_box_projects_through_current_sticker_geometry():
    sticker = {
        "id": "sticker",
        "x": 80,
        "y": 700,
        "width": 600,
        "height": 200,
        "rotation": 30,
    }

    assert project_normalized_box_to_sticker(sticker, {
        "x": 0.1,
        "y": 0.2,
        "width": 0.8,
        "height": 0.6,
    }) == {
        "x": 140,
        "y": 740,
        "width": 480,
        "height": 120,
        "rotation": 30,
    }
    assert project_normalized_box_to_sticker({
        "x": 0,
        "y": 0,
        "width": 200,
        "height": 100,
        "rotation": 90,
    }, {
        "x": 0,
        "y": 0,
        "width": 0.5,
        "height": 0.5,
    }) == {
        "x": 75,
        "y": -25,
        "width": 100,
        "height": 50,
        "rotation": 90,
    }


def test_normalized_box_projection_rejects_out_of_bounds_box():
    with pytest.raises(ValueError, match="超出素材範圍"):
        project_normalized_box_to_sticker({
            "x": 0,
            "y": 0,
            "width": 200,
            "height": 100,
        }, {
            "x": 0.8,
            "y": 0,
            "width": 0.3,
            "height": 1,
        })


def test_normalized_box_projection_rejects_boolean_values():
    with pytest.raises(ValueError, match="有限數值"):
        project_normalized_box_to_sticker({
            "x": 0,
            "y": 0,
            "width": 200,
            "height": 100,
        }, {
            "x": True,
            "y": 0,
            "width": 0.5,
            "height": 1,
        })


def test_detector_reports_only_contract_unavailable_reasons():
    tiny = analyze_material_text_box(Image.new("RGBA", (4, 4), (255, 255, 255, 255)))
    empty = analyze_material_text_box(Image.new("RGBA", (32, 32), (0, 0, 0, 0)))

    assert tiny["status"] == "unavailable"
    assert tiny["reason"] == "image_too_small"
    assert empty["status"] == "unavailable"
    assert empty["reason"] == "no_shape"


def test_upload_returns_decoded_revision_and_same_filename_keeps_immutable_versions(
    monkeypatch, tmp_path
):
    use_tmp_uploads(monkeypatch, tmp_path)
    first_data = _material_png(color=(250, 80, 90, 255))
    second_data = _material_png(color=(70, 120, 250, 255))

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        first = client.post(
            f"/api/templates/{template_id}/stickers",
            files={"file": ("material.png", first_data, "image/png")},
        )
        second = client.post(
            f"/api/templates/{template_id}/stickers",
            files={"file": ("material.png", second_data, "image/png")},
        )

        assert_status(first, 200)
        assert_status(second, 200)
        first_payload = first.json()
        second_payload = second.json()
        assert first_payload["path"] != second_payload["path"]
        assert first_payload["asset_revision"] == _expected_revision(first_data)
        assert second_payload["asset_revision"] == _expected_revision(second_data)
        assert first_payload["asset_revision"] != second_payload["asset_revision"]
        storage = get_storage()
        assert storage.get_bytes(first_payload["path"]) == first_data
        assert storage.get_bytes(second_payload["path"]) == second_data

        stale = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": 91,
                "path": second_payload["path"],
                "source_revision": first_payload["asset_revision"],
                "request_token": "request-a",
            },
        )
        assert_status(stale, 409)
        assert stale.json()["detail"]["code"] == "asset_revision_stale"
        assert stale.json()["detail"]["source_revision"] == second_payload["asset_revision"]


def test_suggestion_echoes_token_and_does_not_mutate_media_or_layout(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    data = _material_png()

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        upload = client.post(
            f"/api/templates/{template_id}/stickers",
            files={"file": ("material.png", data, "image/png")},
        )
        assert_status(upload, 200)
        uploaded = upload.json()
        storage = get_storage()
        before_bytes = storage.get_bytes(uploaded["path"])
        db = SessionLocal()
        try:
            before_layout = db.get(TemplatePage, page_id).layout_json
        finally:
            db.close()

        response = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": "new-sticker",
                "path": uploaded["path"],
                "source_revision": uploaded["asset_revision"],
                "request_token": "request-123",
            },
        )

        assert_status(response, 200)
        payload = response.json()
        assert payload["status"] == "suggested"
        assert payload["request_token"] == "request-123"
        assert payload["source_revision"] == uploaded["asset_revision"]
        assert storage.get_bytes(uploaded["path"]) == before_bytes
        db = SessionLocal()
        try:
            assert db.get(TemplatePage, page_id).layout_json == before_layout
        finally:
            db.close()


class _ReadOnlyStorage:
    def __init__(self, data: bytes):
        self.data = data
        self.calls = []

    def get_bytes(self, key):
        self.calls.append(("get_bytes", key))
        return self.data

    def __getattr__(self, name):
        raise AssertionError(f"analysis attempted forbidden storage operation: {name}")


def test_suggestion_storage_adapter_is_strictly_read_only(monkeypatch):
    data = _material_png()
    fake_storage = _ReadOnlyStorage(data)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        path = f"templates/tmpl{template_id}/stickers/material.png"
        monkeypatch.setattr(template_asset_service, "get_storage", lambda: fake_storage)

        response = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": 1,
                "path": path,
                "source_revision": _expected_revision(data),
                "request_token": "read-only",
            },
        )
        unsafe_id = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": MAX_JAVASCRIPT_SAFE_INTEGER + 1,
                "path": path,
                "source_revision": None,
                "request_token": "unsafe-canonical-id",
            },
        )

        assert_status(response, 200)
        assert_status(unsafe_id, 422)
        assert unsafe_id.json()["detail"]["code"] == "invalid_sticker_reference"
        assert fake_storage.calls == [("get_bytes", path)]


def test_suggestion_converts_only_after_material_is_bounded(monkeypatch):
    data = _material_png(size=(1200, 800))
    fake_storage = _ReadOnlyStorage(data)
    decoded_sizes = []
    original_decode = template_asset_service.decode_rgba_image

    def tracked_decode(image):
        decoded_sizes.append(image.size)
        return original_decode(image)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        path = f"templates/tmpl{template_id}/stickers/material.png"
        monkeypatch.setattr(template_asset_service, "get_storage", lambda: fake_storage)
        monkeypatch.setattr(template_asset_service, "decode_rgba_image", tracked_decode)

        response = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": 1,
                "path": path,
                "source_revision": None,
                "request_token": "bounded-analysis",
            },
        )

        assert_status(response, 200)
        assert decoded_sizes == [(512, 341)]
        assert fake_storage.calls == [("get_bytes", path)]


def test_suggestion_rejects_cross_template_traversal_and_missing_media(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        first_template_id, _ = create_template_with_page(client)
        second_template_id, second_page_id = create_template_with_page(client)
        foreign_path = f"templates/tmpl{first_template_id}/stickers/a.png"
        traversal_path = f"templates/tmpl{second_template_id}/stickers/../a.png"
        base_payload = {
            "sticker_id": 1,
            "source_revision": None,
            "request_token": "negative",
        }

        cross = client.post(
            f"/api/templates/{second_template_id}/pages/{second_page_id}/material-text-box-suggestion",
            json={**base_payload, "path": foreign_path},
        )
        traversal = client.post(
            f"/api/templates/{second_template_id}/pages/{second_page_id}/material-text-box-suggestion",
            json={**base_payload, "path": traversal_path},
        )
        missing = client.post(
            f"/api/templates/{second_template_id}/pages/{second_page_id}/material-text-box-suggestion",
            json={
                **base_payload,
                "path": f"templates/tmpl{second_template_id}/stickers/missing.png",
            },
        )

        assert_status(cross, 422)
        assert cross.json()["detail"]["code"] == "invalid_sticker_reference"
        assert_status(traversal, 422)
        assert_status(missing, 404)


def test_saved_legacy_sticker_path_is_the_only_namespace_exception(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    data = _material_png()
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        legacy_path = "legacy/stickers/material.png"
        get_storage().put(legacy_path, data)
        db = SessionLocal()
        try:
            page = db.get(TemplatePage, page_id)
            layout = json.loads(page.layout_json)
            layout["stickers"] = [{"id": 44, "path": legacy_path}]
            page.layout_json = json.dumps(layout)
            db.commit()
        finally:
            db.close()

        accepted = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": "44",
                "path": legacy_path,
                "source_revision": None,
                "request_token": "legacy",
            },
        )
        rejected = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": 45,
                "path": legacy_path,
                "source_revision": None,
                "request_token": "legacy-wrong-id",
            },
        )
        unsafe_id = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={
                "sticker_id": MAX_JAVASCRIPT_SAFE_INTEGER + 1,
                "path": legacy_path,
                "source_revision": None,
                "request_token": "legacy-unsafe-id",
            },
        )

        assert_status(accepted, 200)
        assert accepted.json()["source_revision"] == _expected_revision(data)
        assert_status(rejected, 422)
        assert_status(unsafe_id, 422)
        assert unsafe_id.json()["detail"]["code"] == "invalid_sticker_reference"


def test_suggestion_requires_privileged_role_and_exact_payload(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        unprivileged, _ = create_user(client, "supervisor")
        path = f"templates/tmpl{template_id}/stickers/a.png"
        payload = {
            "sticker_id": 1,
            "path": path,
            "source_revision": None,
            "request_token": "auth",
        }

        client.cookies.clear()
        anonymous = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json=payload,
        )
        login(client, unprivileged["username"], USER_PASSWORD)
        forbidden = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json=payload,
        )
        login(client)
        extra = client.post(
            f"/api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion",
            json={**payload, "unexpected": True},
        )

        assert_status(anonymous, 401)
        assert_status(forbidden, 403)
        assert_status(extra, 422)
