# 模板頁面預覽路由
# 單頁預覽與跨頁（spread）預覽的渲染與 PNG 回應，
# 路由層僅負責 HTTP 接收與回應，渲染委派給 services/render_service

import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from PIL import Image
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.template_crud import get_template_or_404, get_template_page_or_404
from database import User, get_db
from services.render_service import render_page
from services.request_limiter import require_preview_render_slot
from services.text_variables import (
    ALBUM_NAME_PREVIEW_PLACEHOLDER,
    FULL_NAME_PREVIEW_PLACEHOLDER,
)

from ._helpers import _template_page_layout_with_background

router = APIRouter()

PREVIEW_RESPONSE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
}


def _png_response(image: Image.Image) -> Response:
    image_buffer = io.BytesIO()
    image.save(image_buffer, format="PNG")
    # 不可用 StreamingResponse(BytesIO):file-like 逐「行」迭代,二進位 PNG
    # 被切成數千小塊各過一次 threadpool;bytes 已在記憶體,直接一次送出
    return Response(
        content=image_buffer.getvalue(),
        media_type="image/png",
        headers=PREVIEW_RESPONSE_HEADERS,
    )


@router.get("/{template_id}/pages/{page_id}/preview")
def preview_template_page(
    template_id: int,
    page_id: int,
    _limit: None = Depends(require_preview_render_slot),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """以相本稱呼與完整姓名的可辨識佔位符渲染模板預覽。"""
    template_page = get_template_page_or_404(page_id, template_id, db)

    page_layout = _template_page_layout_with_background(template_page)
    preview_image = render_page(
        page_layout,
        FULL_NAME_PREVIEW_PLACEHOLDER,
        {},
        page_index=template_page.page_number,
        album_name=ALBUM_NAME_PREVIEW_PLACEHOLDER,
    )

    return _png_response(preview_image)


@router.get("/{template_id}/spread-preview/{start_page_index}")
def preview_template_spread(
    template_id: int,
    start_page_index: int,
    _limit: None = Depends(require_preview_render_slot),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """將模板中連續兩頁合併為橫向預覽圖，回傳 PNG。"""
    template = get_template_or_404(template_id, db)
    pages = list(template.pages)
    if start_page_index < 0 or start_page_index >= len(pages):
        raise HTTPException(status_code=404, detail="頁面索引超出範圍")

    rendered_pages = []
    for offset in range(2):
        page_index = start_page_index + offset
        if page_index >= len(pages):
            rendered_pages.append(Image.new("RGB", rendered_pages[0].size, "white"))
            continue

        template_page = pages[page_index]
        page_layout = _template_page_layout_with_background(template_page)
        rendered_pages.append(
            render_page(
                page_layout,
                FULL_NAME_PREVIEW_PLACEHOLDER,
                {},
                page_index=template_page.page_number,
                album_name=ALBUM_NAME_PREVIEW_PLACEHOLDER,
            ).convert("RGB")
        )

    page_width, page_height = rendered_pages[0].size
    spread_image = Image.new("RGB", (page_width * 2, page_height), "white")
    spread_image.paste(rendered_pages[0], (0, 0))
    spread_image.paste(rendered_pages[1], (page_width, 0))

    return _png_response(spread_image)
