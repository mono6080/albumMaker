# 串流 ZIP 共用工具：邊壓邊送取代整包 BytesIO
# 峰值記憶體從整包 ZIP 降為單一檔案，下載立即開始而非等整包組完

import io
import zipfile

from services.request_limiter import zip_build_limiter


def open_zip_stream(write_entries, busy_detail: str):
    """串流 ZIP 骨架：先佔 zip 併發槽（滿載回 503），回傳逐段 chunk 產生器。

    write_entries(zip_archive) 為產生器，每 yield 一次代表寫入了一個檔案。
    產生器結束（含中斷）時釋放併發槽。內容多為 PDF/JPG 等已壓縮格式，
    一律 ZIP_STORED（再 DEFLATE 只耗 CPU 幾乎不減量）。
    """
    limiter_context = zip_build_limiter.acquire(busy_detail)
    limiter_context.__enter__()

    def stream_zip_chunks():
        try:
            zip_buffer = StreamingZipBuffer()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zip_archive:
                for _ in write_entries(zip_archive):
                    yield from zip_buffer.drain()
            yield from zip_buffer.drain()
        finally:
            limiter_context.__exit__(None, None, None)

    return stream_zip_chunks()


class StreamingZipBuffer(io.RawIOBase):
    """收集 zipfile 寫出的 bytes 供逐段吐出（非 seekable，zipfile 自動改走 data descriptor）。"""

    def __init__(self):
        self._pending_chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        self._pending_chunks.append(bytes(data))
        return len(data)

    def drain(self) -> list[bytes]:
        drained_chunks, self._pending_chunks = self._pending_chunks, []
        return drained_chunks
