"""Storage 公開相容 facade；實作分別位於 storage_* modules。"""

from services.storage_base import StorageAdapter
from services.storage_factory import (
    _validate_r2_serve_mode as _validate_r2_serve_mode,
    get_storage,
)
from services.storage_local import LocalStorageAdapter
from services.storage_r2 import R2StorageAdapter


__all__ = [
    "LocalStorageAdapter",
    "R2StorageAdapter",
    "StorageAdapter",
    "get_storage",
]
