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
        # 排隊逾時要大於單一重任務的時間（預覽渲染 0.3-3s、HEIC 轉檔 1-2s），
        # 否則兩人同時操作時排隊者必吃 503（審閱頁破圖、上傳的照片消失）
        self.timeout = _env_float("HEAVY_REQUEST_QUEUE_TIMEOUT_SECONDS", 10.0)
        self._semaphore = threading.BoundedSemaphore(self.limit)

    def acquire_slot(self) -> bool:
        """排隊直到取得槽或逾時；回傳是否取得。

        給 async 路由在 to_thread 中呼叫：取得後呼叫端須自行 release_slot()，
        以便在持槽期間穿插 await（例如 client 斷線檢查）。
        """
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
            return False

        if waited >= 0.25:
            logger.warning(
                "busy_limiter_waited name=%s limit=%s waited=%.3fs",
                self.name,
                self.limit,
                waited,
            )
        return True

    def release_slot(self) -> None:
        self._semaphore.release()

    def busy_http_exception(self, detail: str) -> HTTPException:
        return HTTPException(
            status_code=503,
            detail=detail,
            headers={"Retry-After": str(max(1, int(self.timeout)))},
        )

    @contextmanager
    def acquire(self, detail: str):
        if not self.acquire_slot():
            raise self.busy_http_exception(detail)
        try:
            yield
        finally:
            self._semaphore.release()

    @contextmanager
    def acquire_blocking(self):
        """背景 job 用：等到有槽為止、不丟 503。

        讓 job 逐位取槽（而非整個 job 佔住），互動請求得以與 job 交錯執行。
        """
        self._semaphore.acquire()
        try:
            yield
        finally:
            self._semaphore.release()


preview_render_limiter = BusyLimiter("preview_render", "PREVIEW_RENDER_CONCURRENCY", 4)
album_render_limiter = BusyLimiter("album_render", "ALBUM_RENDER_CONCURRENCY", 1)
zip_build_limiter = BusyLimiter("zip_build", "ZIP_BUILD_CONCURRENCY", 1)
photo_upload_limiter = BusyLimiter("photo_upload", "PHOTO_UPLOAD_CONCURRENCY", 2)


def require_photo_upload_slot():
    with photo_upload_limiter.acquire("照片處理中，請稍後再試"):
        yield


def require_preview_render_slot():
    with preview_render_limiter.acquire("預覽產生中，請稍後再試"):
        yield
