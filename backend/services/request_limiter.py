import logging
import os
import threading
import time
from contextlib import contextmanager

from fastapi import HTTPException

logger = logging.getLogger("album_maker.limiters")


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name, str(default))))
    except ValueError:
        return default


class BusyLimiter:
    def __init__(self, name: str, env_name: str, default_limit: int):
        self.name = name
        self.limit = _env_int(env_name, default_limit)
        self.timeout = _env_float("HEAVY_REQUEST_QUEUE_TIMEOUT_SECONDS", 2.0)
        self._semaphore = threading.BoundedSemaphore(self.limit)

    @contextmanager
    def acquire(self, detail: str):
        started_at = time.monotonic()
        acquired = self._semaphore.acquire(timeout=self.timeout)
        waited = time.monotonic() - started_at
        if not acquired:
            logger.warning(
                "busy_limiter_rejected name=%s limit=%s timeout=%.3fs",
                self.name,
                self.limit,
                self.timeout,
            )
            raise HTTPException(
                status_code=503,
                detail=detail,
                headers={"Retry-After": str(max(1, int(self.timeout)))},
            )

        if waited >= 0.25:
            logger.warning(
                "busy_limiter_waited name=%s limit=%s waited=%.3fs",
                self.name,
                self.limit,
                waited,
            )
        try:
            yield
        finally:
            self._semaphore.release()


preview_render_limiter = BusyLimiter("preview_render", "PREVIEW_RENDER_CONCURRENCY", 2)
album_render_limiter = BusyLimiter("album_render", "ALBUM_RENDER_CONCURRENCY", 1)
zip_build_limiter = BusyLimiter("zip_build", "ZIP_BUILD_CONCURRENCY", 1)
photo_upload_limiter = BusyLimiter("photo_upload", "PHOTO_UPLOAD_CONCURRENCY", 1)


def require_photo_upload_slot():
    with photo_upload_limiter.acquire("照片處理中，請稍後再試"):
        yield
