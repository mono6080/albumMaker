# Storage adapter 基礎驗證
# 涵蓋 LocalStorageAdapter 的 put/get/exists/delete 完整生命週期，以及 path traversal 防護

import io

import pytest

from services.storage import LocalStorageAdapter, R2StorageAdapter


class FakeClientError(Exception):
    def __init__(self, code: str, status_code: int = 404):
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status_code},
        }


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
