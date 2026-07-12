# 串流 ZIP 共用工具：邊壓邊送取代整包 BytesIO
# 峰值記憶體從整包 ZIP 降為單一檔案，下載立即開始而非等整包組完

import io


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
