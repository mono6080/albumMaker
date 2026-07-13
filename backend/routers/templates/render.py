# 模板頁面預覽路由
# 單頁預覽與跨頁（spread）預覽的渲染與 JPEG 回應，
# 路由層僅負責 HTTP 接收與回應，渲染委派給 services/render_service

import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.template_crud import get_template_or_404, get_template_page_or_404
from database import User, get_db
from services.render_service import render_page

from ._helpers import _template_page_layout_with_background

router = APIRouter()

TEMPLATE_PREVIEW_JPEG_QUALITY = 72  # 模板編輯預覽（與專案預覽的 80 不同檔不同值，改名避免混淆）
PREVIEW_RESPONSE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
}


def _jpeg_response(image: Image.Image, quality: int = TEMPLATE_PREVIEW_JPEG_QUALITY) -> StreamingResponse:
    image_buffer = io.BytesIO()
    image.convert("RGB").save(image_buffer, format="JPEG", quality=quality)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg", headers=PREVIEW_RESPONSE_HEADERS)


@router.get("/{template_id}/pages/{page_id}/preview")
def preview_template_page(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """渲染模板頁面預覽圖（以「姓名」佔位符代替學生姓名），回傳 JPEG。"""
    template_page = get_template_page_or_404(page_id, template_id, db)

    page_layout = _template_page_layout_with_background(template_page)
    preview_image = render_page(
        page_layout,
        "（姓名）",
        {},
        page_index=template_page.page_number,
    )

    return _jpeg_response(preview_image)


@router.get("/{template_id}/spread-preview/{start_page_index}")
def preview_template_spread(
    template_id: int,
    start_page_index: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """將模板中連續兩頁合併為橫向預覽圖，回傳 JPEG。"""
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
                "（姓名）",
                {},
                page_index=template_page.page_number,
            ).convert("RGB")
        )

    page_width, page_height = rendered_pages[0].size
    spread_image = Image.new("RGB", (page_width * 2, page_height), "white")
    spread_image.paste(rendered_pages[0], (0, 0))
    spread_image.paste(rendered_pages[1], (page_width, 0))

    return _jpeg_response(spread_image)
