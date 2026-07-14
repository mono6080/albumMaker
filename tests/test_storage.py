# Storage adapter 基礎驗證
# 涵蓋 LocalStorageAdapter 的 put/get/exists/delete 完整生命週期，以及 path traversal 防護

import io
import os
import uuid
from datetime import datetime

import pytest

from database import Student
from services.file_service import ProcessedImageUpload, content_versioned_filename
from services.student_pages import apply_photo_to_page
from services.storage import LocalStorageAdapter, R2StorageAdapter, _validate_r2_serve_mode
from services.project_service import _clear_student_render_outputs


class FakeClientError(Exception):
    def __init__(self, code: str, status_code: int = 404):
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status_code},
        }


def test_content_versioned_filename_preserves_hash_after_long_original_name():
    first = content_versioned_filename("a" * 240 + ".png", "1" * 64, "image")
    second = content_versioned_filename("a" * 240 + ".png", "2" * 64, "image")

    assert len(first) <= 180
    assert first.endswith("_" + "1" * 16 + ".png")
    assert second.endswith("_" + "2" * 16 + ".png")
    assert first != second


def test_reordered_page_photo_replacement_never_overwrites_other_page_asset(tmp_path):
    storage = LocalStorageAdapter(tmp_path / "uploads")
    other_page_key = "projects/proj1/photos/student1/p0_slot1_IMG.jpg"
    replaced_page_key = "projects/proj1/photos/student1/p1_slot1_IMG.jpg"
    storage.put(other_page_key, b"original-page-zero")
    storage.put(replaced_page_key, b"original-page-one")
    pages_data = [
        {"page_index": 0, "photos": {"1": {"path": replaced_page_key}}, "label_texts": {}},
        {"page_index": 1, "photos": {"1": {"path": other_page_key}}, "label_texts": {}},
    ]
    student = Student(id=1, project_id=1, name="孩子", pages_data_json="[]")

    new_key = apply_photo_to_page(
        pages_data,
        student,
        project_id=1,
        page_index=0,
        slot_id=1,
        processed_upload=ProcessedImageUpload(data=b"new-photo", filename="IMG.jpg"),
        storage=storage,
        now=datetime(2026, 7, 15),
    )

    assert new_key not in {other_page_key, replaced_page_key}
    assert storage.get_bytes(new_key) == b"new-photo"
    assert storage.get_bytes(other_page_key) == b"original-page-zero"
    assert storage.exists(replaced_page_key) is False
    assert pages_data[1]["photos"]["1"]["path"] == other_page_key


class FakePaginator:
    def __init__(self, objects: dict[str, bytes]):
        self._objects = objects

    def paginate(self, Bucket, Prefix):
        del Bucket
        yield {
            "Contents": [
                {"Key": key}
                for key in sorted(self._objects)
                if key.startswith(Prefix)
            ]
        }


class FakeS3Client:
    def __init__(self):
        self.objects = {}
        self.content_types = {}
        self.get_object_calls = []

    def put_object(self, Bucket, Key, Body, ContentType=None):
        del Bucket
        self.objects[Key] = Body
        self.content_types[Key] = ContentType

    def head_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise FakeClientError("404")
        return {}

    def get_object(self, Bucket, Key):
        del Bucket
        self.get_object_calls.append(Key)
        if Key not in self.objects:
            raise FakeClientError("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def delete_object(self, Bucket, Key):
        del Bucket
        self.objects.pop(Key, None)

    def copy_object(self, Bucket, CopySource, Key):
        del Bucket
        source_key = CopySource["Key"]
        if source_key not in self.objects:
            raise FakeClientError("NoSuchKey")
        self.objects[Key] = self.objects[source_key]
        self.content_types[Key] = self.content_types.get(source_key)

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return FakePaginator(self.objects)

    def delete_objects(self, Bucket, Delete):
        del Bucket
        for item in Delete["Objects"]:
            self.objects.pop(item["Key"], None)


def test_local_storage_put_get_delete(tmp_path):
    """put → exists → get_bytes → delete → exists False 的完整生命週期。"""
    adapter = LocalStorageAdapter(tmp_path)
    key = "foo/bar.txt"

    adapter.put(key, b"hi")
    assert adapter.exists(key) is True
    assert adapter.get_bytes(key) == b"hi"

    adapter.delete(key)
    assert adapter.exists(key) is False


def test_local_storage_path_traversal_blocked(tmp_path):
    """含 ../ 的 key 必須被 _path() 攔截並拋出 ValueError。"""
    adapter = LocalStorageAdapter(tmp_path)
    with pytest.raises(ValueError):
        adapter.put("../../etc/passwd", b"x")


def test_local_storage_shared_prefix_escape_blocked(tmp_path):
    """shared-prefix sibling 目錄不可繞過 base_dir 檢查。"""
    base_dir = tmp_path / "uploads"
    sibling_dir = tmp_path / "uploads_evil"
    adapter = LocalStorageAdapter(base_dir)

    with pytest.raises(ValueError):
        adapter.put("../uploads_evil/pwned.txt", b"x")

    assert not (sibling_dir / "pwned.txt").exists()


def test_r2_storage_put_get_move_delete_lifecycle():
    """R2 adapter 應符合 StorageAdapter 的基本生命週期合約。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)

    adapter.put("foo/bar.txt", b"hi")
    assert adapter.exists("foo/bar.txt") is True
    assert adapter.get_bytes("foo/bar.txt") == b"hi"
    assert client.content_types["foo/bar.txt"] == "text/plain"

    adapter.move("foo/bar.txt", "foo/baz.txt")
    assert adapter.exists("foo/bar.txt") is False
    assert adapter.get_bytes("foo/baz.txt") == b"hi"

    adapter.delete("foo/baz.txt")
    assert adapter.exists("foo/baz.txt") is False


def test_r2_storage_blocks_path_traversal_keys():
    """R2 key 也要拒絕 path traversal、絕對路徑與 Windows 反斜線。"""
    adapter = R2StorageAdapter(bucket="bucket", s3_client=FakeS3Client())

    for key in ("../evil.txt", "/evil.txt", "foo\\evil.txt"):
        with pytest.raises(ValueError):
            adapter.put(key, b"x")


def test_r2_delete_prefix_does_not_delete_shared_prefix_siblings():
    """刪 templates/tmpl1 時不可誤刪 templates/tmpl10。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    adapter.put("templates/tmpl1/backgrounds/a.jpg", b"a")
    adapter.put("templates/tmpl10/backgrounds/b.jpg", b"b")

    adapter.delete_prefix("templates/tmpl1")

    assert "templates/tmpl1/backgrounds/a.jpg" not in client.objects
    assert client.objects["templates/tmpl10/backgrounds/b.jpg"] == b"b"


def test_r2_delete_prefix_removes_render_output_variants():
    """輸出清理需要同時移除 stem.pdf、stem_screen.pdf 與 stem/images/*。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    adapter.put("projects/proj1/output/demo.pdf", b"print")
    adapter.put("projects/proj1/output/demo_screen.pdf", b"screen")
    adapter.put("projects/proj1/output/demo/images/print/demo_page1.jpg", b"jpg")
    adapter.put("projects/proj1/output/demo-other.pdf", b"other")

    adapter.delete_prefix("projects/proj1/output/demo")

    assert "projects/proj1/output/demo.pdf" not in client.objects
    assert "projects/proj1/output/demo_screen.pdf" not in client.objects
    assert "projects/proj1/output/demo/images/print/demo_page1.jpg" not in client.objects
    assert client.objects["projects/proj1/output/demo-other.pdf"] == b"other"


def test_student_output_cleanup_keeps_same_prefix_student():
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    prefix = "projects/proj1/output"
    adapter.put(f"{prefix}/班級-小明.pdf", b"print")
    adapter.put(f"{prefix}/班級-小明_screen.pdf", b"screen")
    adapter.put(f"{prefix}/班級-小明/images/print/page.jpg", b"image")
    adapter.put(f"{prefix}/班級-小明二.pdf", b"other")

    _clear_student_render_outputs(adapter, prefix, "班級-小明")

    assert f"{prefix}/班級-小明.pdf" not in client.objects
    assert f"{prefix}/班級-小明_screen.pdf" not in client.objects
    assert f"{prefix}/班級-小明/images/print/page.jpg" not in client.objects
    assert client.objects[f"{prefix}/班級-小明二.pdf"] == b"other"


def test_r2_serve_proxy_returns_file_bytes_with_content_type():
    """proxy 模式維持原本由後端回傳檔案的 API 行為。"""
    adapter = R2StorageAdapter(bucket="bucket", s3_client=FakeS3Client())
    adapter.put("photos/a.jpg", b"jpg-bytes")

    response = adapter.serve("photos/a.jpg")

    assert response.body == b"jpg-bytes"
    assert response.media_type == "image/jpeg"


def test_r2_serve_redirect_uses_public_base_url_and_encoded_key():
    """redirect 模式可給未來 custom domain / CDN 直出使用。"""
    adapter = R2StorageAdapter(
        bucket="bucket",
        s3_client=FakeS3Client(),
        serve_mode="redirect",
        public_base_url="https://assets.example.com/base/",
    )

    response = adapter.serve("templates/tmpl1/backgrounds/page1_感官世界.jpg")

    assert response.headers["location"] == (
        "https://assets.example.com/base/templates/tmpl1/backgrounds/"
        "page1_%E6%84%9F%E5%AE%98%E4%B8%96%E7%95%8C.jpg"
    )


def test_production_rejects_public_r2_redirect_mode():
    with pytest.raises(RuntimeError, match="繞過媒體登入權限"):
        _validate_r2_serve_mode("redirect", production=True)
    _validate_r2_serve_mode("proxy", production=True)
    _validate_r2_serve_mode("redirect", production=False)


def test_r2_key_prefix_is_applied_to_remote_objects_but_not_public_keys():
    """R2_KEY_PREFIX 可隔離測試物件，不改變應用程式內部使用的 storage key。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client, key_prefix="__e2e/run1")

    adapter.put("projects/proj1/photos/a.jpg", b"photo")

    assert "__e2e/run1/projects/proj1/photos/a.jpg" in client.objects
    assert adapter.exists("projects/proj1/photos/a.jpg") is True
    assert adapter.get_bytes("projects/proj1/photos/a.jpg") == b"photo"
    assert client.get_object_calls == []


def test_r2_key_prefix_move_uses_single_prefix():
    """R2_KEY_PREFIX 下 move 仍只應套用一次 prefix。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client, key_prefix="__e2e/run1")

    adapter.put("foo/bar.txt", b"hi")
    adapter.move("foo/bar.txt", "foo/baz.txt")

    assert "__e2e/run1/foo/bar.txt" not in client.objects
    assert client.objects["__e2e/run1/foo/baz.txt"] == b"hi"
    assert adapter.exists("foo/baz.txt") is True


def test_r2_real_bucket_smoke_when_enabled():
    """本機手動驗證用：RUN_R2_INTEGRATION=1 時才打到真實 R2 bucket。"""
    if os.getenv("RUN_R2_INTEGRATION") != "1":
        pytest.skip("set RUN_R2_INTEGRATION=1 to run real R2 smoke test")

    required_env = [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
    ]
    missing = [name for name in required_env if not os.getenv(name)]
    if missing:
        pytest.skip(f"missing R2 env vars: {', '.join(missing)}")

    adapter = R2StorageAdapter(
        bucket=os.environ["R2_BUCKET"],
        account_id=os.environ["R2_ACCOUNT_ID"],
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        endpoint_url=os.getenv("R2_ENDPOINT_URL"),
        serve_mode="proxy",
    )
    key = f"__integration_tests/storage_smoke/{uuid.uuid4().hex}.txt"
    payload = b"album-maker-r2-smoke"

    try:
        adapter.put(key, payload)
        assert adapter.exists(key) is True
        assert adapter.get_bytes(key) == payload
        assert adapter.serve(key).body == payload
    finally:
        adapter.delete(key)

    assert adapter.exists(key) is False
