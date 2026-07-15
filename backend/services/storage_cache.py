import shutil
from collections import OrderedDict
from pathlib import Path


class ReadCache:
    """R2 讀取快取：記憶體 LRU → 本機磁碟快取 → 唯讀鏡像。"""

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

    def load(self, clean_key: str) -> bytes | None:
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
