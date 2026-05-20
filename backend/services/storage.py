# 儲存層抽象介面
# 所有檔案讀寫、刪除、Serve 操作都透過此 adapter，
# 本地開發用 LocalStorageAdapter，日後換 S3 / R2 / GCS 只需新增實作並切換 get_storage()

import io
import mimetypes
import os
import posixpath
import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from urllib.parse import quote

from fastapi import Response
from fastapi.responses import FileResponse, RedirectResponse
from PIL import Image, ImageOps


class StorageAdapter(ABC):

    @abstractmethod
    def put(self, key: str, data: bytes) -> None:
        """將 bytes 寫入指定 key。"""

    @abstractmethod
    def open_image(self, key: str) -> Image.Image:
        """開啟並回傳 PIL Image，供渲染引擎使用。"""

    @abstractmethod
    def serve(self, key: str) -> Response:
        """回傳可直接從 HTTP 端點 return 的 Response（本地=FileResponse，Cloud=RedirectResponse）。"""

    @abstractmethod
    def delete(self, key: str) -> None:
        """刪除單一檔案，不存在時靜默忽略。"""

    @abstractmethod
    def delete_prefix(self, key_prefix: str) -> None:
        """刪除所有以 key_prefix 開頭的物件（等同刪除目錄）。"""

    @abstractmethod
    def move(self, src_key: str, dst_key: str) -> None:
        """移動 / 重命名，目標已存在時覆蓋。"""

    @abstractmethod
    def exists(self, key: str) -> bool:
        """檢查 key 是否存在。"""

    @abstractmethod
    def get_bytes(self, key: str) -> bytes:
        """讀取 key 的完整內容並回傳 bytes。"""


class LocalStorageAdapter(StorageAdapter):
    """本地磁碟實作，key 為相對於 base_dir 的路徑字串。"""

    def __init__(self, base_dir: Path):
        self._base = base_dir

    def _path(self, key: str) -> Path:
        """解析 key 為絕對路徑，並驗證結果在 base_dir 內，防止 path traversal。"""
        base = self._base.resolve()
        resolved = (base / key).resolve()
        try:
            resolved.relative_to(base)
        except ValueError:
            raise ValueError(f"path traversal detected: {key!r}")
        return resolved

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def open_image(self, key: str) -> Image.Image:
        img = Image.open(self._path(key))
        return ImageOps.exif_transpose(img)

    def serve(self, key: str) -> Response:
        return FileResponse(str(self._path(key)))

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, key_prefix: str) -> None:
        path = self._path(key_prefix)
        if path.exists():
            shutil.rmtree(path)

    def move(self, src_key: str, dst_key: str) -> None:
        src = self._path(src_key)
        dst = self._path(dst_key)
        if not src.exists():
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class R2StorageAdapter(StorageAdapter):
    """Cloudflare R2 實作，使用 S3-compatible API。"""

    _NOT_FOUND_CODES = {"404", "NoSuchKey", "NotFound"}

    def __init__(
        self,
        *,
        bucket: str | None,
        account_id: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        endpoint_url: str | None = None,
        public_base_url: str | None = None,
        serve_mode: str = "proxy",
        s3_client=None,
    ):
        if not bucket:
            raise ValueError("R2_BUCKET is required")
        self._bucket = bucket
        self._public_base_url = public_base_url.rstrip("/") if public_base_url else None
        self._serve_mode = serve_mode
        if self._serve_mode not in {"proxy", "redirect"}:
            raise ValueError("R2 serve_mode must be 'proxy' or 'redirect'")
        if self._serve_mode == "redirect" and not self._public_base_url:
            raise ValueError("R2_PUBLIC_BASE_URL is required when R2_SERVE_MODE=redirect")

        if s3_client is not None:
            self._s3 = s3_client
            return

        if not endpoint_url:
            if not account_id:
                raise ValueError("R2_ACCOUNT_ID is required when R2_ENDPOINT_URL is not set")
            endpoint_url = f"https://{account_id}.r2.cloudflarestorage.com"
        if not access_key_id or not secret_access_key:
            raise ValueError("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required")

        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError("boto3 is required for STORAGE_BACKEND=r2") from exc

        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

    def _key(self, key: str) -> str:
        if not isinstance(key, str) or not key:
            raise ValueError("storage key must be a non-empty string")
        if "\\" in key or key.startswith("/"):
            raise ValueError(f"invalid storage key: {key!r}")
        normalized = posixpath.normpath(key)
        if normalized == "." or normalized.startswith("../") or normalized == "..":
            raise ValueError(f"path traversal detected: {key!r}")
        return normalized

    def _is_not_found(self, error: Exception) -> bool:
        response = getattr(error, "response", None) or {}
        code = str(response.get("Error", {}).get("Code", ""))
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in self._NOT_FOUND_CODES or status == 404

    def _public_url(self, key: str) -> str:
        encoded_key = "/".join(quote(part, safe="") for part in self._key(key).split("/"))
        return f"{self._public_base_url}/{encoded_key}"

    def _prefix_matches(self, prefix: str, key: str) -> bool:
        return (
            key == prefix
            or key.startswith(prefix + "/")
            or key.startswith(prefix + ".")
            or key.startswith(prefix + "_")
        )

    def put(self, key: str, data: bytes) -> None:
        clean_key = self._key(key)
        self._s3.put_object(
            Bucket=self._bucket,
            Key=clean_key,
            Body=data,
            ContentType=mimetypes.guess_type(clean_key)[0] or "application/octet-stream",
        )

    def open_image(self, key: str) -> Image.Image:
        img = Image.open(io.BytesIO(self.get_bytes(key)))
        return ImageOps.exif_transpose(img)

    def serve(self, key: str) -> Response:
        if self._serve_mode == "redirect":
            return RedirectResponse(self._public_url(key))

        data = self.get_bytes(key)
        media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
        return Response(content=data, media_type=media_type)

    def delete(self, key: str) -> None:
        self._s3.delete_object(Bucket=self._bucket, Key=self._key(key))

    def delete_prefix(self, key_prefix: str) -> None:
        prefix = self._key(key_prefix)
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            objects = [
                {"Key": obj["Key"]}
                for obj in page.get("Contents", [])
                if self._prefix_matches(prefix, obj["Key"])
            ]
            for start in range(0, len(objects), 1000):
                batch = objects[start:start + 1000]
                if batch:
                    self._s3.delete_objects(Bucket=self._bucket, Delete={"Objects": batch})

    def move(self, src_key: str, dst_key: str) -> None:
        src = self._key(src_key)
        dst = self._key(dst_key)
        if not self.exists(src):
            return
        self._s3.copy_object(
            Bucket=self._bucket,
            CopySource={"Bucket": self._bucket, "Key": src},
            Key=dst,
        )
        self.delete(src)

    def exists(self, key: str) -> bool:
        try:
            self._s3.head_object(Bucket=self._bucket, Key=self._key(key))
            return True
        except Exception as exc:
            if self._is_not_found(exc):
                return False
            raise

    def get_bytes(self, key: str) -> bytes:
        try:
            response = self._s3.get_object(Bucket=self._bucket, Key=self._key(key))
        except Exception as exc:
            if self._is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise

        body = response["Body"]
        try:
            return body.read()
        finally:
            close = getattr(body, "close", None)
            if close:
                close()


# ── 全域單例，透過環境變數切換 ──────────────────────────────────────────────────

def get_storage() -> StorageAdapter:
    """
    回傳當前使用的 StorageAdapter 實例。

    STORAGE_BACKEND 環境變數：
      - 未設定 / "local"  → LocalStorageAdapter
      - "r2"              → R2StorageAdapter（需設定 R2_* 環境變數）
    """
    from services.render_service import UPLOADS_DIR  # 避免循環 import

    backend = os.getenv("STORAGE_BACKEND", "local")
    if backend == "local":
        return LocalStorageAdapter(UPLOADS_DIR)
    if backend == "r2":
        return R2StorageAdapter(
            bucket=os.getenv("R2_BUCKET"),
            account_id=os.getenv("R2_ACCOUNT_ID"),
            access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
            secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
            endpoint_url=os.getenv("R2_ENDPOINT_URL"),
            public_base_url=os.getenv("R2_PUBLIC_BASE_URL"),
            serve_mode=os.getenv("R2_SERVE_MODE", "proxy"),
        )
    # 日後在此擴充其他後端
    raise ValueError(f"未知的 STORAGE_BACKEND: {backend!r}")
