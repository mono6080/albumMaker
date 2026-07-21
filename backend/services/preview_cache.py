# 預覽圖的內容定址快取（cache-aside）
#
# key = {prefix}/{payload 內容 hash}.jpg：layout 與 page_data 全文都在 hash 內，
# 任何實質變更都會換 key，因此不需要失效通知；無關的編輯（例如別的學生的照片）
# 不會作廢既有快取。讀寫細節（cache-only 寫入、limiter 內二次查）都在這裡，
# 路由層只負責權限檢查與組 Response。
#
# 讀寫走 async：blocking 步驟（storage 讀寫、limiter 排隊、PIL 渲染）都丟
# to_thread，取得渲染槽後先檢查 client 是否已斷線——快速切頁被放棄的 <img>
# 請求會直接讓出槽位，不再替沒人看的頁面渲染。

import asyncio
import hashlib
import io
import json
import logging

from services.layout_group_traversal import layout_for_render_fingerprint
from services.render_service import render_preview_page
from services.request_limiter import preview_render_limiter
from services.storage import get_storage

logger = logging.getLogger(__name__)

# v11：預覽輸出改 JPEG（照片內容 PNG 肥 3-5 倍;quality=80 介於 screen 72 與 print 95）。
PREVIEW_CACHE_VERSION = "project-preview-v11-jpeg"
PREVIEW_JPEG_QUALITY = 80


def preview_scale_key(scale: float) -> str:
    """scale 轉成可放進 storage key 的片段（0.4 → "0_400"）。"""
    return f"{scale:.3f}".replace(".", "_")


def _preview_payload_hash(payload: dict) -> str:
    hash_payload = {**payload}
    if isinstance(hash_payload.get("layout"), dict):
        hash_payload["layout"] = layout_for_render_fingerprint(hash_payload["layout"])
    payload_json = json.dumps(
        {"version": PREVIEW_CACHE_VERSION, **hash_payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()[:24]


def render_preview_jpeg_bytes(
    layout: dict,
    student_name: str,
    page_data: dict,
    page_index: int,
    scale: float,
    *,
    album_name: str | None = None,
) -> bytes:
    """渲染單頁預覽並編成 JPEG bytes（手機分享直接以此檔分享給家長）。"""
    preview_image = render_preview_page(
        layout,
        student_name,
        page_data,
        page_index=page_index,
        scale=scale,
        album_name=album_name,
    )
    image_buffer = io.BytesIO()
    preview_image.convert("RGB").save(
        image_buffer, format="JPEG", quality=PREVIEW_JPEG_QUALITY
    )
    return image_buffer.getvalue()


def preview_cache_key(cache_prefix: str, payload: dict) -> str:
    """內容定址 cache key：只靠 payload hash，不需讀 storage 即可算出。"""
    return f"{cache_prefix}/{_preview_payload_hash(payload)}.jpg"


def _read_cached_preview_bytes(storage, cache_key: str):
    try:
        # get_cached_bytes 是 StorageAdapter 基類方法：只查快取層、缺檔回 None
        return storage.get_cached_bytes(cache_key)
    except Exception as cache_error:
        logger.warning("讀取預覽快取失敗 key=%s error=%s", cache_key, cache_error)
        return None


def _render_and_store_preview(storage, cache_key: str, render_bytes) -> bytes:
    image_bytes = render_bytes()
    try:
        storage.put_cache_only(cache_key, image_bytes)
    except Exception as cache_error:
        logger.warning("寫入預覽快取失敗 key=%s error=%s", cache_key, cache_error)
    return image_bytes


async def get_or_render_preview(
    cache_key: str,
    render_bytes,
    *,
    is_disconnected,
) -> tuple[bytes | None, bool]:
    """取得（或渲染並回填）內容定址的預覽圖。

    回傳 (image bytes 或 None, 是否命中快取)；None 表示 client 已斷線且尚未
    渲染，呼叫端應直接放棄回應。render_bytes 是無參數的渲染 callback，
    只在 miss 且 client 仍在線時於 preview limiter 內執行。
    """
    storage = get_storage()

    cached_bytes = await asyncio.to_thread(_read_cached_preview_bytes, storage, cache_key)
    if cached_bytes is not None:
        return cached_bytes, True

    if await is_disconnected():
        return None, False

    if not await asyncio.to_thread(preview_render_limiter.acquire_slot):
        raise preview_render_limiter.busy_http_exception("預覽產生中，請稍後再試")
    try:
        # 排到槽時 client 可能早已放棄（快速切頁）：跳過渲染，把槽讓給還在等的人
        if await is_disconnected():
            return None, False

        # 等待 limiter 期間可能已有其他請求補好同一張預覽。
        cached_bytes = await asyncio.to_thread(_read_cached_preview_bytes, storage, cache_key)
        if cached_bytes is not None:
            return cached_bytes, True

        image_bytes = await asyncio.to_thread(
            _render_and_store_preview, storage, cache_key, render_bytes
        )
        return image_bytes, False
    finally:
        preview_render_limiter.release_slot()
