import io
import mimetypes
import os
import posixpath
from pathlib import Path
from urllib.parse import quote

from fastapi import Response
from fastapi.responses import RedirectResponse
from PIL import Image, ImageOps

from services.storage_base import StorageAdapter
from services.storage_cache import ReadCache


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
        self._read_cache = ReadCache(
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
        return key == prefix or key.startswith(prefix + "/")

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
        image = Image.open(io.BytesIO(self.get_bytes(key)))
        return ImageOps.exif_transpose(image)

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
                {"Key": obj["Key"]} for obj in page.get("Contents", []) if self._prefix_matches(prefix, obj["Key"])
            ]
            for start in range(0, len(objects), 1000):
                batch = objects[start : start + 1000]
                if batch:
                    response = self._s3.delete_objects(Bucket=self._bucket, Delete={"Objects": batch})
                    errors = response.get("Errors", [])
                    if errors:
                        raise RuntimeError(
                            f"R2 delete_prefix failed for {len(errors)} object(s)"
                        )

    def move(self, src_key: str, dst_key: str) -> None:
        source = self._key(src_key)
        destination = self._key(dst_key)
        try:
            self._s3.head_object(Bucket=self._bucket, Key=source)
        except Exception as exc:
            if self._is_not_found(exc):
                return
            raise
        self._s3.copy_object(
            Bucket=self._bucket,
            CopySource={"Bucket": self._bucket, "Key": source},
            Key=destination,
        )
        cached = self._read_cache.load(source)
        if cached is not None:
            self._read_cache.store(destination, cached)
        self._s3.delete_object(Bucket=self._bucket, Key=source)
        self._read_cache.delete(source)

    def copy(self, src_key: str, dst_key: str) -> None:
        source = self._key(src_key)
        destination = self._key(dst_key)
        self._s3.copy_object(
            Bucket=self._bucket,
            CopySource={"Bucket": self._bucket, "Key": source},
            Key=destination,
        )
        cached = self._read_cache.load(source)
        if cached is not None:
            self._read_cache.store(destination, cached)

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
