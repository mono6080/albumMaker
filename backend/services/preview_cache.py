# 預覽圖的內容定址快取（cache-aside）
#
# key = {prefix}/{payload 內容 hash}.jpg：layout 與 page_data 全文都在 hash 內，
# 任何實質變更都會換 key，因此不需要失效通知；無關的編輯（例如別的學生的照片）
# 不會作廢既有快取。讀寫細節（cache-only 寫入、limiter 內二次查）都在這裡，
# 路由層只負責權限檢查與組 Response。

import hashlib
import io
import json
import logging

from services.render_service import render_preview_page
from services.request_limiter import preview_render_limiter
from services.storage import get_storage

logger = logging.getLogger(__name__)

PREVIEW_JPEG_QUALITY = 80
# v5：nested-world-v2 會改變 leaf traversal，隔離舊 flat-world 預覽像素。
PREVIEW_CACHE_VERSION = "project-preview-v5-nested-groups"


def preview_scale_key(scale: float) -> str:
    """scale 轉成可放進 storage key 的片段（0.4 → "0_400"）。"""
    return f"{scale:.3f}".replace(".", "_")


def _preview_payload_hash(payload: dict) -> str:
    payload_json = json.dumps(
        {"version": PREVIEW_CACHE_VERSION, **payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()[:24]


def render_preview_jpeg_bytes(layout: dict, student_name: str, page_data: dict, page_index: int, scale: float) -> bytes:
    """渲染單頁預覽並編成 JPEG bytes。"""
    preview_image = render_preview_page(
        layout,
        student_name,
        page_data,
        page_index=page_index,
        scale=scale,
    )
    image_buffer = io.BytesIO()
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=PREVIEW_JPEG_QUALITY)
    return image_buffer.getvalue()


def _read_cached_preview_bytes(storage, cache_key: str):
    try:
        # get_cached_bytes 是 StorageAdapter 基類方法：只查快取層、缺檔回 None
        return storage.get_cached_bytes(cache_key)
    except Exception as cache_error:
        logger.warning("讀取預覽快取失敗 key=%s error=%s", cache_key, cache_error)
        return None


def get_or_render_preview(cache_prefix: str, payload: dict, render_bytes) -> tuple[bytes, str, bool]:
    """取得（或渲染並回填）內容定址的預覽 JPEG。

    回傳 (jpeg bytes, cache_key, 是否命中快取)。render_bytes 是無參數的
    渲染 callback，只在 miss 時於 preview limiter 內執行。
    """
    storage = get_storage()
    cache_key = f"{cache_prefix}/{_preview_payload_hash(payload)}.jpg"

    cached_bytes = _read_cached_preview_bytes(storage, cache_key)
    if cached_bytes is not None:
        return cached_bytes, cache_key, True

    with preview_render_limiter.acquire("預覽產生中，請稍後再試"):
        # 等待 limiter 期間可能已有其他請求補好同一張預覽。
        cached_bytes = _read_cached_preview_bytes(storage, cache_key)
        if cached_bytes is not None:
            return cached_bytes, cache_key, True

        image_bytes = render_bytes()
        try:
            storage.put_cache_only(cache_key, image_bytes)
        except Exception as cache_error:
            logger.warning("寫入預覽快取失敗 key=%s error=%s", cache_key, cache_error)

    return image_bytes, cache_key, False
