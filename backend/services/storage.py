# 儲存層抽象介面
# 所有檔案讀寫、刪除、Serve 操作都透過此 adapter，
# 本地開發用 LocalStorageAdapter，日後換 S3 / R2 / GCS 只需新增實作並切換 get_storage()

import io
import shutil
from abc import ABC, abstractmethod
from pathlib import Path

from fastapi import Response
from fastapi.responses import FileResponse
from PIL import Image


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
        return self._base / key

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def open_image(self, key: str) -> Image.Image:
        return Image.open(self._path(key))

    def serve(self, key: str) -> Response:
        return FileResponse(str(self._path(key)))

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.exists():
            path.unlink()

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


# ── 未來 Cloud 實作範例（尚未啟用）────────────────────────────────────────────
#
# class S3StorageAdapter(StorageAdapter):
#     def __init__(self, bucket: str, cdn_base_url: str):
#         import boto3
#         self._s3 = boto3.client("s3")
#         self._bucket = bucket
#         self._cdn = cdn_base_url.rstrip("/")
#
#     def put(self, key, data):
#         self._s3.put_object(Bucket=self._bucket, Key=key, Body=data)
#
#     def open_image(self, key):
#         resp = self._s3.get_object(Bucket=self._bucket, Key=key)
#         return Image.open(io.BytesIO(resp["Body"].read()))
#
#     def serve(self, key):
#         from fastapi.responses import RedirectResponse
#         return RedirectResponse(f"{self._cdn}/{key}")
#
#     def delete(self, key):
#         self._s3.delete_object(Bucket=self._bucket, Key=key)
#
#     def delete_prefix(self, key_prefix):
#         paginator = self._s3.get_paginator("list_objects_v2")
#         for page in paginator.paginate(Bucket=self._bucket, Prefix=key_prefix):
#             objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
#             if objects:
#                 self._s3.delete_objects(Bucket=self._bucket, Delete={"Objects": objects})
#
#     def move(self, src_key, dst_key):
#         self._s3.copy_object(Bucket=self._bucket,
#                              CopySource={"Bucket": self._bucket, "Key": src_key},
#                              Key=dst_key)
#         self._delete(src_key)
#
#     def exists(self, key):
#         import botocore
#         try:
#             self._s3.head_object(Bucket=self._bucket, Key=key)
#             return True
#         except botocore.exceptions.ClientError:
#             return False


# ── 全域單例，透過環境變數切換 ──────────────────────────────────────────────────

import os

def get_storage() -> StorageAdapter:
    """
    回傳當前使用的 StorageAdapter 實例。

    STORAGE_BACKEND 環境變數：
      - 未設定 / "local"  → LocalStorageAdapter
      - "s3"              → S3StorageAdapter（需設定 S3_BUCKET / CDN_BASE_URL）
    """
    from services.render_service import UPLOADS_DIR  # 避免循環 import

    backend = os.getenv("STORAGE_BACKEND", "local")
    if backend == "local":
        return LocalStorageAdapter(UPLOADS_DIR)
    # 日後在此擴充其他後端
    raise ValueError(f"未知的 STORAGE_BACKEND: {backend!r}")
