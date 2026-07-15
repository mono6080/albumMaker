import shutil
from pathlib import Path

from fastapi import Response
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from services.storage_base import StorageAdapter


class LocalStorageAdapter(StorageAdapter):
    """本地磁碟實作，key 為相對於 base_dir 的路徑字串。"""

    def __init__(self, base_dir: Path):
        self._base = base_dir

    def _path(self, key: str) -> Path:
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
        image = Image.open(self._path(key))
        return ImageOps.exif_transpose(image)

    def serve(self, key: str) -> Response:
        return FileResponse(str(self._path(key)))

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, key_prefix: str) -> None:
        path = self._path(key_prefix)
        if path.exists():
            shutil.rmtree(path)

    def move(self, src_key: str, dst_key: str) -> None:
        source = self._path(src_key)
        destination = self._path(dst_key)
        if not source.exists():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)

    def copy(self, src_key: str, dst_key: str) -> None:
        source = self._path(src_key)
        destination = self._path(dst_key)
        if not source.exists():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def list_keys(self, key_prefix: str) -> list[str]:
        prefix_path = self._path(key_prefix)
        if not prefix_path.is_dir():
            return []
        base = self._base.resolve()
        return [file_path.relative_to(base).as_posix() for file_path in prefix_path.rglob("*") if file_path.is_file()]

    def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()
