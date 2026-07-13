# 儲存層抽象介面
# 所有檔案讀寫、刪除、Serve 操作都透過此 adapter，
# 本地開發用 LocalStorageAdapter，日後換 S3 / R2 / GCS 只需新增實作並切換 get_storage()

import io
import mimetypes
import os
import posixpath
import shutil
from collections import OrderedDict
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
    def list_keys(self, key_prefix: str) -> list[str]:
        """列出所有以 key_prefix 開頭的 key（批次存在性檢查用，避免逐檔 exists）。"""

    @abstractmethod
    def get_bytes(self, key: str) -> bytes:
        """讀取 key 的完整內容並回傳 bytes。"""

    def copy(self, src_key: str, dst_key: str) -> None:
        """複製物件（共用照片全班展開用）。子類可覆寫為零傳輸的原生複製。"""
        self.put(dst_key, self.get_bytes(src_key))

    def get_cached_bytes(self, key: str) -> bytes | None:
        """只查快取層、不打遠端；缺檔回 None。

        本地後端磁碟即快取，get_bytes 就等價；R2 覆寫為只查記憶體/本機快取層。
        """
        try:
            return self.get_bytes(key)
        except FileNotFoundError:
            return None

    def put_cache_only(self, key: str, data: bytes) -> None:
        """只寫快取層（衍生物如預覽圖，可隨時重算）；本地後端沒有分層，等同 put。"""
        self.put(key, data)


class _ReadCache:
    """R2 讀取快取的三層組合：記憶體 LRU → 本機磁碟快取 → 唯讀鏡像。

    對外四個動作：load / store / delete / delete_prefix——adapter 的每個
    S3 操作只需呼叫一次，不再逐層手動同步（漏寫任一層即快取不一致）。
    key 一律使用已含命名空間前綴的 clean key。
    """

    def __init__(
        self,
        *,
        memory_max_bytes: int,
        local_cache_dir: Path | None,
        local_cache_max_bytes: int,
        local_mirror_dir: Path | None,
        prefix_matches,
    ):
        self._memory: OrderedDict[str, bytes] = OrderedDict()
        self._memory_bytes = 0
        self._memory_max_bytes = memory_max_bytes
        self._local_cache_dir = local_cache_dir
        self._local_cache_max_bytes = local_cache_max_bytes
        self._local_mirror_dir = local_mirror_dir
        self._prefix_matches = prefix_matches

    # ── 對外動作 ──────────────────────────────────────────────────────────

    def load(self, clean_key: str) -> bytes | None:
        """記憶體 → 本機快取/鏡像 逐層查；磁碟命中會回填記憶體。"""
        cached = self._memory_get(clean_key)
        if cached is not None:
            return cached
        local_data = self._read_local(clean_key)
        if local_data is not None:
            self._memory_put(clean_key, local_data)
            return local_data
        return None

    def store(self, clean_key: str, data: bytes) -> None:
        self._memory_put(clean_key, data)
        self._write_local(clean_key, data)

    def delete(self, clean_key: str) -> None:
        self._memory_delete(clean_key)
        self._delete_local(clean_key)

    def delete_prefix(self, prefix: str) -> None:
        for key in list(self._memory.keys()):
            if self._prefix_matches(prefix, key):
                self._memory_delete(key)
        self._delete_local_prefix(prefix)

    # ── 記憶體 LRU 層 ─────────────────────────────────────────────────────

    def _memory_get(self, key: str) -> bytes | None:
        data = self._memory.get(key)
        if data is None:
            return None
        self._memory.move_to_end(key)
        return data

    def _memory_put(self, key: str, data: bytes) -> None:
        if self._memory_max_bytes <= 0 or len(data) > self._memory_max_bytes:
            self._memory_delete(key)
            return
        old = self._memory.pop(key, None)
        if old is not None:
            self._memory_bytes -= len(old)
        self._memory[key] = data
        self._memory_bytes += len(data)
        while self._memory_bytes > self._memory_max_bytes and self._memory:
            _, removed = self._memory.popitem(last=False)
            self._memory_bytes -= len(removed)

    def _memory_delete(self, key: str) -> None:
        old = self._memory.pop(key, None)
        if old is not None:
            self._memory_bytes -= len(old)

    # ── 本機磁碟快取層（＋唯讀鏡像） ──────────────────────────────────────

    def _local_path(self, base_dir: Path | None, key: str) -> Path | None:
        if base_dir is None:
            return None
        resolved = (base_dir / key).resolve()
        try:
            resolved.relative_to(base_dir)
        except ValueError:
            raise ValueError(f"path traversal detected: {key!r}")
        return resolved

    def _read_local(self, key: str) -> bytes | None:
        for base_dir in (self._local_cache_dir, self._local_mirror_dir):
            path = self._local_path(base_dir, key)
            if path and path.is_file():
                return path.read_bytes()
        return None

    def _write_local(self, key: str, data: bytes) -> None:
        path = self._local_path(self._local_cache_dir, key)
        if not path or self._local_cache_max_bytes <= 0:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self._prune_local()

    def _delete_local(self, key: str) -> None:
        path = self._local_path(self._local_cache_dir, key)
        if path:
            path.unlink(missing_ok=True)

    def _delete_local_prefix(self, prefix: str) -> None:
        base_dir = self._local_cache_dir
        if not base_dir:
            return
        prefix_path = self._local_path(base_dir, prefix)
        if prefix_path and prefix_path.exists():
            if prefix_path.is_dir():
                shutil.rmtree(prefix_path)
            else:
                prefix_path.unlink(missing_ok=True)

    def _prune_local(self) -> None:
        base_dir = self._local_cache_dir
        max_bytes = self._local_cache_max_bytes
        if not base_dir or max_bytes <= 0 or not base_dir.exists():
            return

        files = []
        total_bytes = 0
        for path in base_dir.rglob("*"):
            if not path.is_file():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            total_bytes += stat.st_size
            files.append((stat.st_mtime, stat.st_size, path))

        if total_bytes <= max_bytes:
            return

        for _, size, path in sorted(files):
            try:
                path.unlink()
                total_bytes -= size
            except OSError:
                continue
            if total_bytes <= max_bytes:
                break


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

    def copy(self, src_key: str, dst_key: str) -> None:
        src = self._path(src_key)
        dst = self._path(dst_key)
        if not src.exists():
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def list_keys(self, key_prefix: str) -> list[str]:
        prefix_path = self._path(key_prefix)
        if not prefix_path.is_dir():
            return []
        base = self._base.resolve()
        return [
            file_path.relative_to(base).as_posix()
            for file_path in prefix_path.rglob("*")
            if file_path.is_file()
        ]

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
        key_prefix: str | None = None,
        local_cache_dir: str | None = None,
        local_mirror_dir: str | None = None,
        s3_client=None,
    ):
        if not bucket:
            raise ValueError("R2_BUCKET is required")
        self._bucket = bucket
        self._public_base_url = public_base_url.rstrip("/") if public_base_url else None
        self._serve_mode = serve_mode
        self._key_prefix = self._normalize_key_prefix(key_prefix)
        self._read_cache = _ReadCache(
            memory_max_bytes=int(os.getenv("R2_READ_CACHE_MAX_BYTES", str(150 * 1024 * 1024))),
            local_cache_dir=Path(local_cache_dir).resolve() if local_cache_dir else None,
            local_cache_max_bytes=int(os.getenv("R2_LOCAL_CACHE_MAX_BYTES", str(1024 * 1024 * 1024))),
            local_mirror_dir=Path(local_mirror_dir).resolve() if local_mirror_dir else None,
            prefix_matches=self._prefix_matches,
        )
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

    def _normalize_key_prefix(self, key_prefix: str | None) -> str:
        if not key_prefix:
            return ""
        if "\\" in key_prefix or key_prefix.startswith("/"):
            raise ValueError(f"invalid R2 key prefix: {key_prefix!r}")
        normalized = posixpath.normpath(key_prefix.strip("/"))
        if normalized == ".":
            return ""
        if normalized.startswith("../") or normalized == "..":
            raise ValueError(f"path traversal detected in R2 key prefix: {key_prefix!r}")
        return normalized

    def get_cached_bytes(self, key: str) -> bytes | None:
        return self._read_cache.load(self._key(key))

    def put_cache_only(self, key: str, data: bytes) -> None:
        self._read_cache.store(self._key(key), data)

    def _key(self, key: str) -> str:
        if not isinstance(key, str) or not key:
            raise ValueError("storage key must be a non-empty string")
        if "\\" in key or key.startswith("/"):
            raise ValueError(f"invalid storage key: {key!r}")
        normalized = posixpath.normpath(key)
        if normalized == "." or normalized.startswith("../") or normalized == "..":
            raise ValueError(f"path traversal detected: {key!r}")
        if self._key_prefix:
            return f"{self._key_prefix}/{normalized}"
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
        self._read_cache.store(clean_key, data)

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
        clean_key = self._key(key)
        self._s3.delete_object(Bucket=self._bucket, Key=clean_key)
        self._read_cache.delete(clean_key)

    def delete_prefix(self, key_prefix: str) -> None:
        prefix = self._key(key_prefix)
        self._read_cache.delete_prefix(prefix)
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
        try:
            self._s3.head_object(Bucket=self._bucket, Key=src)
        except Exception as exc:
            if self._is_not_found(exc):
                return
            raise
        self._s3.copy_object(
            Bucket=self._bucket,
            CopySource={"Bucket": self._bucket, "Key": src},
            Key=dst,
        )
        cached = self._read_cache.load(src)
        if cached is not None:
            self._read_cache.store(dst, cached)
        self._s3.delete_object(Bucket=self._bucket, Key=src)
        self._read_cache.delete(src)

    def copy(self, src_key: str, dst_key: str) -> None:
        # server-side copy：零資料傳輸，共用照片全班展開從 N 次上傳變 N 次輕量呼叫
        src = self._key(src_key)
        dst = self._key(dst_key)
        self._s3.copy_object(
            Bucket=self._bucket,
            CopySource={"Bucket": self._bucket, "Key": src},
            Key=dst,
        )
        cached = self._read_cache.load(src)
        if cached is not None:
            self._read_cache.store(dst, cached)

    def exists(self, key: str) -> bool:
        try:
            self._s3.head_object(Bucket=self._bucket, Key=self._key(key))
            return True
        except Exception as exc:
            if self._is_not_found(exc):
                return False
            raise

    def list_keys(self, key_prefix: str) -> list[str]:
        prefix = self._key(key_prefix)
        # 物件 key 含命名空間前綴，回傳前剝掉，與呼叫端使用的 key 形式一致
        namespace = f"{self._key_prefix}/" if self._key_prefix else ""
        matched_keys = []
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            matched_keys.extend(
                obj["Key"].removeprefix(namespace)
                for obj in page.get("Contents", [])
                if self._prefix_matches(prefix, obj["Key"])
            )
        return matched_keys

    def get_bytes(self, key: str) -> bytes:
        clean_key = self._key(key)
        cached = self._read_cache.load(clean_key)
        if cached is not None:
            return cached
        try:
            response = self._s3.get_object(Bucket=self._bucket, Key=clean_key)
        except Exception as exc:
            if self._is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise

        body = response["Body"]
        try:
            data = body.read()
            self._read_cache.store(clean_key, data)
            return data
        finally:
            close = getattr(body, "close", None)
            if close:
                close()


# ── 全域單例，透過環境變數切換 ──────────────────────────────────────────────────

_STORAGE_CACHE_KEY = None
_STORAGE_INSTANCE: StorageAdapter | None = None


def _storage_config_key(uploads_dir: Path):
    return (
        os.getenv("STORAGE_BACKEND", "local"),
        str(uploads_dir),
        os.getenv("R2_BUCKET"),
        os.getenv("R2_ACCOUNT_ID"),
        os.getenv("R2_ACCESS_KEY_ID"),
        os.getenv("R2_SECRET_ACCESS_KEY"),
        os.getenv("R2_ENDPOINT_URL"),
        os.getenv("R2_PUBLIC_BASE_URL"),
        os.getenv("R2_SERVE_MODE", "proxy"),
        os.getenv("R2_KEY_PREFIX"),
        os.getenv("R2_READ_CACHE_MAX_BYTES"),
        os.getenv("R2_LOCAL_CACHE_DIR"),
        os.getenv("R2_LOCAL_MIRROR_DIR"),
    )


def _resolve_storage_path(value: str | None, uploads_dir: Path) -> str | None:
    if not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return str(path)
    project_root = uploads_dir.parent.parent
    return str((project_root / path).resolve())


def _validate_r2_serve_mode(serve_mode: str, production: bool) -> None:
    if production and serve_mode == "redirect":
        raise RuntimeError(
            "正式環境不可使用 R2_SERVE_MODE=redirect：公開 URL 會繞過媒體登入權限；請使用 proxy"
        )

def get_storage() -> StorageAdapter:
    """
    回傳當前使用的 StorageAdapter 實例。

    STORAGE_BACKEND 環境變數：
      - 未設定 / "local"  → LocalStorageAdapter
      - "r2"              → R2StorageAdapter（需設定 R2_* 環境變數）
    """
    from services.render_service import UPLOADS_DIR  # 避免循環 import

    global _STORAGE_CACHE_KEY, _STORAGE_INSTANCE

    cache_key = _storage_config_key(UPLOADS_DIR)
    if _STORAGE_INSTANCE is not None and _STORAGE_CACHE_KEY == cache_key:
        return _STORAGE_INSTANCE

    backend = os.getenv("STORAGE_BACKEND", "local")
    if backend == "local":
        _STORAGE_INSTANCE = LocalStorageAdapter(UPLOADS_DIR)
        _STORAGE_CACHE_KEY = cache_key
        return _STORAGE_INSTANCE
    if backend == "r2":
        serve_mode = os.getenv("R2_SERVE_MODE", "proxy")
        production = os.getenv("PRODUCTION", "").strip().lower() in {"1", "true", "yes", "on"}
        _validate_r2_serve_mode(serve_mode, production)
        _STORAGE_INSTANCE = R2StorageAdapter(
            bucket=os.getenv("R2_BUCKET"),
            account_id=os.getenv("R2_ACCOUNT_ID"),
            access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
            secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
            endpoint_url=os.getenv("R2_ENDPOINT_URL"),
            public_base_url=os.getenv("R2_PUBLIC_BASE_URL"),
            serve_mode=serve_mode,
            key_prefix=os.getenv("R2_KEY_PREFIX"),
            local_cache_dir=_resolve_storage_path(os.getenv("R2_LOCAL_CACHE_DIR"), UPLOADS_DIR),
            local_mirror_dir=_resolve_storage_path(os.getenv("R2_LOCAL_MIRROR_DIR"), UPLOADS_DIR),
        )
        _STORAGE_CACHE_KEY = cache_key
        return _STORAGE_INSTANCE
    # 日後在此擴充其他後端
    raise ValueError(f"未知的 STORAGE_BACKEND: {backend!r}")
