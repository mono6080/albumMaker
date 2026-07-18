"""照片縮圖 cache miss 的 bounded decode、limiter 與 single-flight。"""

import io
import struct
import threading
import zlib

import pytest
from PIL import Image, ImageOps

from services import file_service, project_photo_service
from services.render_image_loader import OversizedRenderImageError


class _MemoryStorage:
    def __init__(self, source_bytes: bytes = b""):
        self.source_bytes = source_bytes
        self.cached: dict[str, bytes] = {}
        self._lock = threading.Lock()

    def get_bytes(self, key: str) -> bytes:
        with self._lock:
            if key in self.cached:
                return self.cached[key]
        if "/thumbnails/" in key:
            raise FileNotFoundError(key)
        return self.source_bytes

    def put(self, key: str, data: bytes) -> None:
        with self._lock:
            self.cached[key] = data


def _jpeg_bytes(size: tuple[int, int]) -> bytes:
    image = Image.new("RGB", size, (40, 120, 220))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def _png_header(width: int, height: int) -> bytes:
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return (
            struct.pack(">I", len(data))
            + chunk_type
            + data
            + struct.pack(">I", checksum)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IEND", b"")
    )


def _start_call(call, results: list, errors: list) -> threading.Thread:
    def run() -> None:
        try:
            results.append(call())
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    return thread


def test_thumbnail_flattens_only_after_bounded_resize(monkeypatch):
    storage = _MemoryStorage(_jpeg_bytes((1600, 1200)))
    flattened_sizes = []
    original_flatten = file_service._flatten_to_rgb

    def tracked_flatten(image):
        flattened_sizes.append(image.size)
        return original_flatten(image)

    monkeypatch.setattr(file_service, "_flatten_to_rgb", tracked_flatten)

    thumbnail_bytes = file_service.build_photo_thumbnail_jpeg(
        storage,
        "projects/proj1/photos/student1/photo.jpg",
        360,
    )

    with Image.open(io.BytesIO(thumbnail_bytes)) as thumbnail:
        assert thumbnail.size == (360, 270)
    assert flattened_sizes == [(360, 270)]


def test_thumbnail_rejects_oversized_non_jpeg_before_pixel_allocation(monkeypatch):
    storage = _MemoryStorage(_png_header(10_000, 6_000))

    def unexpected_operation(*_args, **_kwargs):
        raise AssertionError("oversized thumbnail source must fail before allocation")

    monkeypatch.setattr(Image.Image, "load", unexpected_operation)
    monkeypatch.setattr(Image.Image, "resize", unexpected_operation)
    monkeypatch.setattr(Image.Image, "copy", unexpected_operation)
    monkeypatch.setattr(Image.Image, "convert", unexpected_operation)
    monkeypatch.setattr(Image.Image, "draft", unexpected_operation)
    monkeypatch.setattr(Image.Image, "getexif", unexpected_operation)
    monkeypatch.setattr(ImageOps, "exif_transpose", unexpected_operation)

    with pytest.raises(OversizedRenderImageError):
        file_service.build_photo_thumbnail_jpeg(
            storage,
            "projects/proj1/photos/student1/oversized.png",
            360,
        )


def test_thumbnail_same_key_cache_miss_builds_once(monkeypatch):
    storage = _MemoryStorage()
    build_started = threading.Event()
    allow_build = threading.Event()
    build_calls = []

    monkeypatch.setattr(
        project_photo_service,
        "_get_photo_key_or_404",
        lambda *_args, **_kwargs: "projects/proj1/photos/student1/photo.jpg",
    )
    monkeypatch.setattr(project_photo_service, "get_storage", lambda: storage)

    def controlled_build(_storage, photo_key, size):
        build_calls.append((photo_key, size))
        build_started.set()
        assert allow_build.wait(5)
        return b"thumbnail"

    monkeypatch.setattr(
        project_photo_service,
        "build_photo_thumbnail_jpeg",
        controlled_build,
    )

    results = []
    errors = []

    def call():
        return project_photo_service.serve_student_photo_thumbnail(
            None,
            None,
            1,
            1,
            0,
            1,
            360,
        )

    first = _start_call(call, results, errors)
    assert build_started.wait(5)
    second = _start_call(call, results, errors)
    allow_build.set()
    first.join(5)
    second.join(5)

    assert not first.is_alive()
    assert not second.is_alive()
    assert errors == []
    assert build_calls == [("projects/proj1/photos/student1/photo.jpg", 360)]
    assert sorted(
        response.headers["x-photo-thumbnail"]
        for response in results
    ) == ["HIT", "MISS"]
    assert project_photo_service._thumbnail_build_locks == {}
    assert project_photo_service._thumbnail_build_lock_users == {}


def test_thumbnail_different_sizes_share_heavy_work_limiter(monkeypatch):
    storage = _MemoryStorage()
    active_builds = 0
    maximum_active_builds = 0
    active_guard = threading.Lock()
    limiter_full = threading.Event()
    allow_builds = threading.Event()
    limiter_limit = project_photo_service.photo_upload_limiter.limit

    monkeypatch.setattr(
        project_photo_service,
        "_get_photo_key_or_404",
        lambda *_args, **_kwargs: "projects/proj1/photos/student1/photo.jpg",
    )
    monkeypatch.setattr(project_photo_service, "get_storage", lambda: storage)

    def controlled_build(_storage, _photo_key, _size):
        nonlocal active_builds, maximum_active_builds
        with active_guard:
            active_builds += 1
            maximum_active_builds = max(maximum_active_builds, active_builds)
            if active_builds == limiter_limit:
                limiter_full.set()
        try:
            assert allow_builds.wait(5)
            return b"thumbnail"
        finally:
            with active_guard:
                active_builds -= 1

    monkeypatch.setattr(
        project_photo_service,
        "build_photo_thumbnail_jpeg",
        controlled_build,
    )

    results = []
    errors = []
    threads = [
        _start_call(
            lambda size=size: project_photo_service.serve_student_photo_thumbnail(
                None,
                None,
                1,
                1,
                0,
                1,
                size,
            ),
            results,
            errors,
        )
        for size in range(360, 360 + limiter_limit + 1)
    ]
    assert limiter_full.wait(5)
    with active_guard:
        assert maximum_active_builds == limiter_limit
    allow_builds.set()
    for thread in threads:
        thread.join(5)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    assert len(results) == limiter_limit + 1
    assert maximum_active_builds == limiter_limit
