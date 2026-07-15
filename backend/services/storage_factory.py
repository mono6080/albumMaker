import os
from pathlib import Path

import app_paths
from services.storage_base import StorageAdapter
from services.storage_local import LocalStorageAdapter
from services.storage_r2 import R2StorageAdapter


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
        os.getenv("R2_LOCAL_CACHE_MAX_BYTES"),
        os.getenv("R2_LOCAL_MIRROR_DIR"),
        os.getenv("PRODUCTION"),
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
        raise RuntimeError("正式環境不可使用 R2_SERVE_MODE=redirect：公開 URL 會繞過媒體登入權限；請使用 proxy")


def get_storage() -> StorageAdapter:
    """依呼叫當下的 path/env 回傳對應 StorageAdapter。"""
    global _STORAGE_CACHE_KEY, _STORAGE_INSTANCE

    uploads_dir = app_paths.UPLOADS_DIR
    cache_key = _storage_config_key(uploads_dir)
    if _STORAGE_INSTANCE is not None and _STORAGE_CACHE_KEY == cache_key:
        return _STORAGE_INSTANCE

    backend = os.getenv("STORAGE_BACKEND", "local")
    if backend == "local":
        _STORAGE_INSTANCE = LocalStorageAdapter(uploads_dir)
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
            local_cache_dir=_resolve_storage_path(os.getenv("R2_LOCAL_CACHE_DIR"), uploads_dir),
            local_mirror_dir=_resolve_storage_path(os.getenv("R2_LOCAL_MIRROR_DIR"), uploads_dir),
        )
        _STORAGE_CACHE_KEY = cache_key
        return _STORAGE_INSTANCE
    raise ValueError(f"未知的 STORAGE_BACKEND: {backend!r}")
