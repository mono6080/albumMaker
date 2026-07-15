from abc import ABC, abstractmethod

from fastapi import Response
from PIL import Image


class StorageAdapter(ABC):
    @abstractmethod
    def put(self, key: str, data: bytes) -> None:
        """將 bytes 寫入指定 key。"""

    @abstractmethod
    def open_image(self, key: str) -> Image.Image:
        """開啟並回傳 PIL Image，供渲染引擎使用。"""

    @abstractmethod
    def serve(self, key: str) -> Response:
        """回傳可直接從 HTTP 端點 return 的 Response。"""

    @abstractmethod
    def delete(self, key: str) -> None:
        """刪除單一檔案，不存在時靜默忽略。"""

    @abstractmethod
    def delete_prefix(self, key_prefix: str) -> None:
        """刪除所有以 key_prefix 開頭的物件。"""

    @abstractmethod
    def move(self, src_key: str, dst_key: str) -> None:
        """移動或重命名，目標已存在時覆蓋。"""

    @abstractmethod
    def exists(self, key: str) -> bool:
        """檢查 key 是否存在。"""

    @abstractmethod
    def list_keys(self, key_prefix: str) -> list[str]:
        """列出所有以 key_prefix 開頭的 key。"""

    @abstractmethod
    def get_bytes(self, key: str) -> bytes:
        """讀取 key 的完整內容並回傳 bytes。"""

    def copy(self, src_key: str, dst_key: str) -> None:
        """複製物件；子類可覆寫為原生複製。"""
        self.put(dst_key, self.get_bytes(src_key))

    def get_cached_bytes(self, key: str) -> bytes | None:
        """只查快取層、不打遠端；缺檔回 None。"""
        try:
            return self.get_bytes(key)
        except FileNotFoundError:
            return None

    def put_cache_only(self, key: str, data: bytes) -> None:
        """只寫快取層；本地後端等同 put。"""
        self.put(key, data)
