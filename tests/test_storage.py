# Storage adapter 基礎驗證
# 涵蓋 LocalStorageAdapter 的 put/get/exists/delete 完整生命週期，以及 path traversal 防護

import io
import os
import uuid
from datetime import datetime
from pathlib import Path, PureWindowsPath

import pytest
from PIL import Image

from database import Student
import app_paths
from services import storage_factory
from services.file_service import ProcessedImageUpload, content_versioned_filename
from services.student_pages import apply_photo_to_page
from services.storage import LocalStorageAdapter, R2StorageAdapter, _validate_r2_serve_mode
from services.storage_local import (
    _relative_to_resolved_base,
    _windows_comparison_path,
)
from services.student_render_service import (
    _clear_legacy_student_render_outputs,
    _clear_student_render_outputs,
)


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


def test_windows_extended_length_path_compares_with_same_canonical_base():
    """合法的 Windows extended-length path 不可誤判 traversal，sibling 仍須拒絕。"""
    base = PureWindowsPath(r"E:\projects\album_maker\uploads")
    extended_target = PureWindowsPath(
        r"\\?\E:\projects\album_maker\uploads"
        r"\projects\proj1\photos\student1\thumbnails\360\photo.jpg"
    )
    extended_sibling = PureWindowsPath(
        r"\\?\E:\projects\album_maker\uploads_evil\photo.jpg"
    )

    relative_target = _windows_comparison_path(extended_target).relative_to(
        _windows_comparison_path(base)
    )

    assert relative_target == PureWindowsPath(
        r"projects\proj1\photos\student1\thumbnails\360\photo.jpg"
    )
    if os.name == "nt":
        assert _relative_to_resolved_base(
            extended_target,
            base,
        ) == relative_target
    with pytest.raises(ValueError):
        _windows_comparison_path(extended_sibling).relative_to(
            _windows_comparison_path(base)
        )


def test_windows_extended_unc_path_is_case_insensitive_and_stays_in_share():
    """UNC token/server/share 大小寫不同仍可比對，shared-prefix sibling 不可。"""
    base = PureWindowsPath(r"\\Server\Share\uploads")
    extended_target = PureWindowsPath(
        r"\\?\unc\SERVER\SHARE\uploads\projects\proj1\photo.jpg"
    )
    extended_sibling = PureWindowsPath(
        r"\\?\UNC\server\share\uploads_evil\photo.jpg"
    )

    relative_target = _windows_comparison_path(extended_target).relative_to(
        _windows_comparison_path(base)
    )

    assert relative_target == PureWindowsPath(r"projects\proj1\photo.jpg")
    with pytest.raises(ValueError):
        _windows_comparison_path(extended_sibling).relative_to(
            _windows_comparison_path(base)
        )


@pytest.mark.skipif(os.name != "nt", reason="Windows extended-length path integration")
def test_local_storage_windows_long_path_put_get_list_delete(tmp_path):
    """超過 260 字元的合法 key 可完成 LocalStorage 全生命週期。"""
    extended_base = Path("\\\\?\\" + str((tmp_path / "uploads").resolve()))
    adapter = LocalStorageAdapter(extended_base)
    long_segments = [
        f"segment_{segment_index}_" + "x" * 40
        for segment_index in range(7)
    ]
    directory_key = "/".join(long_segments)
    key = f"{directory_key}/photo.jpg"
    assert len(str(adapter._path(key))) > 260

    adapter.put(key, b"long-path-photo")

    assert adapter.get_bytes(key) == b"long-path-photo"
    assert adapter.list_keys(directory_key) == [key]
    adapter.delete(key)
    assert adapter.exists(key) is False
    assert adapter.list_keys(directory_key) == []
    adapter.delete_prefix(long_segments[0])


def test_local_storage_symlink_cannot_escape_base(tmp_path):
    """resolve 後落到 base 外的 symlink 必須維持 traversal 拒絕。"""
    base_dir = tmp_path / "uploads"
    outside_dir = tmp_path / "outside"
    base_dir.mkdir()
    outside_dir.mkdir()
    link_path = base_dir / "outside-link"
    try:
        link_path.symlink_to(outside_dir, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"目前環境不可建立 directory symlink：{error}")

    adapter = LocalStorageAdapter(base_dir)
    with pytest.raises(ValueError):
        adapter.put("outside-link/escaped.txt", b"x")
    assert not (outside_dir / "escaped.txt").exists()


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


def test_r2_delete_prefix_stays_within_namespace_boundary():
    """R2 prefix 只能匹配 exact key／子路徑，不可跨到 .、_ 或文字 sibling。"""
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    adapter.put("projects/proj1/output/demo.pdf", b"print")
    adapter.put("projects/proj1/output/demo_screen.pdf", b"screen")
    adapter.put("projects/proj1/output/demo/images/print/demo_page1.jpg", b"jpg")
    adapter.put("projects/proj1/output/demo-other.pdf", b"other")

    adapter.delete_prefix("projects/proj1/output/demo")

    assert client.objects["projects/proj1/output/demo.pdf"] == b"print"
    assert client.objects["projects/proj1/output/demo_screen.pdf"] == b"screen"
    assert "projects/proj1/output/demo/images/print/demo_page1.jpg" not in client.objects
    assert client.objects["projects/proj1/output/demo-other.pdf"] == b"other"


def test_legacy_student_output_cleanup_protects_sibling_collision():
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    prefix = "projects/proj1/output"
    adapter.put(f"{prefix}/班級-小明.pdf", b"print")
    adapter.put(f"{prefix}/班級-小明_screen.pdf", b"sibling-print")
    adapter.put(f"{prefix}/班級-小明_screen_screen.pdf", b"sibling-screen")
    adapter.put(f"{prefix}/班級-小明/images/print/page.jpg", b"first-image")
    adapter.put(f"{prefix}/班級-小明_screen/images/print/page.jpg", b"sibling-image")

    _clear_legacy_student_render_outputs(
        adapter,
        f"{prefix}/班級-小明.pdf",
        (f"{prefix}/班級-小明_screen.pdf",),
    )

    assert f"{prefix}/班級-小明.pdf" not in client.objects
    assert client.objects[f"{prefix}/班級-小明_screen.pdf"] == b"sibling-print"
    assert client.objects[f"{prefix}/班級-小明_screen_screen.pdf"] == b"sibling-screen"
    assert f"{prefix}/班級-小明/images/print/page.jpg" not in client.objects
    assert client.objects[f"{prefix}/班級-小明_screen/images/print/page.jpg"] == b"sibling-image"


def test_canonical_student_output_cleanup_keeps_similar_student_id_namespace():
    client = FakeS3Client()
    adapter = R2StorageAdapter(bucket="bucket", s3_client=client)
    first_prefix = "projects/proj1/output/students/student2"
    sibling_prefix = "projects/proj1/output/students/student20"
    adapter.put(f"{first_prefix}/pdf/print.pdf", b"first")
    adapter.put(f"{sibling_prefix}/pdf/print.pdf", b"sibling")

    _clear_student_render_outputs(adapter, first_prefix)

    assert f"{first_prefix}/pdf/print.pdf" not in client.objects
    assert client.objects[f"{sibling_prefix}/pdf/print.pdf"] == b"sibling"


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


def test_storage_factory_reuses_only_matching_call_time_path_and_environment(monkeypatch, tmp_path):
    """factory 每次都讀取目前 path/env；只有完整設定相同時才重用 adapter。"""
    monkeypatch.setattr(storage_factory, "_STORAGE_CACHE_KEY", None)
    monkeypatch.setattr(storage_factory, "_STORAGE_INSTANCE", None)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    first_uploads = tmp_path / "backend" / "uploads-first"
    second_uploads = tmp_path / "backend" / "uploads-second"
    monkeypatch.setattr(app_paths, "UPLOADS_DIR", first_uploads)

    first_local = storage_factory.get_storage()
    assert storage_factory.get_storage() is first_local

    monkeypatch.setattr(app_paths, "UPLOADS_DIR", second_uploads)
    second_local = storage_factory.get_storage()
    assert second_local is not first_local
    second_local.put("factory/pin.txt", b"second")
    assert (second_uploads / "factory" / "pin.txt").read_bytes() == b"second"

    created_configs = []

    def fake_r2_adapter(**config):
        instance = object()
        created_configs.append((config, instance))
        return instance

    monkeypatch.setattr(storage_factory, "R2StorageAdapter", fake_r2_adapter)
    monkeypatch.setenv("STORAGE_BACKEND", "r2")
    monkeypatch.setenv("R2_BUCKET", "bucket-one")
    monkeypatch.setenv("R2_ACCOUNT_ID", "account")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_LOCAL_CACHE_DIR", "cache/r2")
    monkeypatch.setenv("R2_LOCAL_MIRROR_DIR", "mirror/r2")
    monkeypatch.setenv("R2_READ_CACHE_MAX_BYTES", "100")

    first_r2 = storage_factory.get_storage()
    assert storage_factory.get_storage() is first_r2
    assert created_configs[0][0]["bucket"] == "bucket-one"
    assert created_configs[0][0]["local_cache_dir"] == str((tmp_path / "cache" / "r2").resolve())
    assert created_configs[0][0]["local_mirror_dir"] == str((tmp_path / "mirror" / "r2").resolve())

    monkeypatch.setenv("R2_BUCKET", "bucket-two")
    second_r2 = storage_factory.get_storage()
    assert second_r2 is not first_r2
    assert created_configs[-1][0]["bucket"] == "bucket-two"

    monkeypatch.setenv("R2_READ_CACHE_MAX_BYTES", "200")
    third_r2 = storage_factory.get_storage()
    assert third_r2 is not second_r2
    assert len(created_configs) == 3

    monkeypatch.setenv("R2_LOCAL_CACHE_MAX_BYTES", "300")
    fourth_r2 = storage_factory.get_storage()
    assert fourth_r2 is not third_r2

    monkeypatch.setenv("PRODUCTION", "1")
    fifth_r2 = storage_factory.get_storage()
    assert fifth_r2 is not fourth_r2
    assert len(created_configs) == 5

    monkeypatch.delenv("PRODUCTION")
    monkeypatch.setenv("R2_SERVE_MODE", "redirect")
    monkeypatch.setenv("R2_PUBLIC_BASE_URL", "https://assets.example.com")
    storage_factory.get_storage()
    monkeypatch.setenv("PRODUCTION", "true")
    with pytest.raises(RuntimeError, match="繞過媒體登入權限"):
        storage_factory.get_storage()


def test_r2_read_cache_hits_memory_then_local_then_mirror_before_remote(tmp_path):
    """讀取順序固定為 memory → writable local cache → read-only mirror → R2。"""
    local_cache = tmp_path / "cache"
    mirror = tmp_path / "mirror"
    local_key = "photos/local.jpg"
    mirror_key = "photos/mirror.jpg"
    remote_key = "photos/remote.jpg"
    (local_cache / local_key).parent.mkdir(parents=True)
    (local_cache / local_key).write_bytes(b"local")
    (mirror / local_key).parent.mkdir(parents=True)
    (mirror / local_key).write_bytes(b"mirror-shadowed")
    (mirror / mirror_key).write_bytes(b"mirror")

    client = FakeS3Client()
    client.objects[remote_key] = b"remote"
    adapter = R2StorageAdapter(
        bucket="bucket",
        s3_client=client,
        local_cache_dir=str(local_cache),
        local_mirror_dir=str(mirror),
    )

    assert adapter.get_bytes(local_key) == b"local"
    (local_cache / local_key).write_bytes(b"changed-on-disk")
    assert adapter.get_bytes(local_key) == b"local"
    assert adapter.get_bytes(mirror_key) == b"mirror"
    (mirror / mirror_key).unlink()
    assert adapter.get_bytes(mirror_key) == b"mirror"
    assert client.get_object_calls == []

    assert adapter.get_bytes(remote_key) == b"remote"
    assert client.get_object_calls == [remote_key]
    assert (local_cache / remote_key).read_bytes() == b"remote"


def test_r2_mutations_keep_memory_and_local_cache_in_sync(tmp_path):
    """put/move/delete/delete_prefix 都同步 invalidation，不留下舊 cache bytes。"""
    local_cache = tmp_path / "cache"
    client = FakeS3Client()
    adapter = R2StorageAdapter(
        bucket="bucket",
        s3_client=client,
        local_cache_dir=str(local_cache),
    )

    adapter.put("photos/source.jpg", b"old")
    adapter.put("photos/source.jpg", b"new")
    assert adapter.get_cached_bytes("photos/source.jpg") == b"new"
    assert (local_cache / "photos" / "source.jpg").read_bytes() == b"new"

    adapter.move("photos/source.jpg", "photos/moved.jpg")
    assert adapter.get_cached_bytes("photos/source.jpg") is None
    assert adapter.get_cached_bytes("photos/moved.jpg") == b"new"

    adapter.delete("photos/moved.jpg")
    assert adapter.get_cached_bytes("photos/moved.jpg") is None

    adapter.put("templates/tmpl1/backgrounds/a.jpg", b"one")
    adapter.put("templates/tmpl10/backgrounds/b.jpg", b"ten")
    adapter.delete_prefix("templates/tmpl1")
    assert adapter.get_cached_bytes("templates/tmpl1/backgrounds/a.jpg") is None
    assert adapter.get_cached_bytes("templates/tmpl10/backgrounds/b.jpg") == b"ten"


def _exif_rotated_jpeg_bytes() -> bytes:
    image = Image.new("RGB", (2, 3), (30, 90, 180))
    exif = Image.Exif()
    exif[274] = 6
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


@pytest.mark.parametrize("backend", ["local", "r2"])
def test_storage_open_image_applies_exif_orientation(backend, tmp_path):
    """Local 與 R2 都必須在交給 renderer 前套用 EXIF transpose。"""
    payload = _exif_rotated_jpeg_bytes()
    if backend == "local":
        adapter = LocalStorageAdapter(tmp_path / "uploads")
    else:
        adapter = R2StorageAdapter(bucket="bucket", s3_client=FakeS3Client())
    adapter.put("photos/oriented.jpg", payload)

    with adapter.open_image("photos/oriented.jpg") as image:
        assert image.size == (3, 2)
        assert image.getexif().get(274) in (None, 1)


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
