import os
import shutil
from pathlib import Path, PurePath, PureWindowsPath

from fastapi import Response
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from services.storage_base import StorageAdapter


def _windows_comparison_path(path: PurePath) -> PureWindowsPath:
    """統一 Windows 一般路徑與 extended-length 路徑的比較拼法。"""
    path_text = str(path)
    if path_text.casefold().startswith("\\\\?\\unc\\"):
        path_text = "\\\\" + path_text[len("\\\\?\\UNC\\"):]
    elif path_text.startswith("\\\\?\\"):
        path_text = path_text[len("\\\\?\\"):]
    return PureWindowsPath(path_text)


def _relative_to_resolved_base(resolved: PurePath, base: PurePath):
    """只在 containment 比較時正規化 Windows extended prefix。"""
    if os.name == "nt":
        return _windows_comparison_path(resolved).relative_to(
            _windows_comparison_path(base)
        )
    return resolved.relative_to(base)


class LocalStorageAdapter(StorageAdapter):
    """本地磁碟實作，key 為相對於 base_dir 的路徑字串。"""

    def __init__(self, base_dir: Path):
        self._base = base_dir

    def _path(self, key: str) -> Path:
        base = self._base.resolve()
        resolved = (base / key).resolve()
        try:
            _relative_to_resolved_base(resolved, base)
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
        if path.is_dir():
            shutil.rmtree(path)
        elif path.is_file():
            path.unlink()

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
        base = self._base.resolve()
        if prefix_path.is_file():
            return [_relative_to_resolved_base(prefix_path, base).as_posix()]
        if not prefix_path.is_dir():
            return []
        return [
            _relative_to_resolved_base(file_path, base).as_posix()
            for file_path in prefix_path.rglob("*")
            if file_path.is_file()
        ]

    def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()
