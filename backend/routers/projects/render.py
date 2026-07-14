# 預覽、渲染與下載路由
# 處理頁面預覽圖生成、相冊 PDF 渲染（單生 / 全班）、PDF 與 ZIP 下載

import io
import logging
import time

from fastapi import APIRouter, Depends, Path, Query
from fastapi import HTTPException
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db
from services.project_service import (
    build_combined_stem,
    build_content_disposition_header,
    build_zip_of_student_images,
    get_student_image_entries,
    get_template_page_layouts,
    merge_project_label_texts_into_pages,
    open_all_student_images_zip_stream,
    open_all_student_pdfs_zip_stream,
    render_and_save_student_album,
    student_pdf_key_for_mode,
)
from services.preview_cache import (
    get_or_render_preview,
    preview_scale_key,
    render_preview_jpeg_bytes,
)
from services.request_limiter import album_render_limiter, zip_build_limiter
from services.render_service import PREVIEW_RENDER_SCALE
from services.storage import get_storage

from ._helpers import (
    _parse_json_field,
    assert_project_readable,
    assert_project_writable,
)
from .schemas import RenderAllResult, RenderStudentResult

logger = logging.getLogger(__name__)

router = APIRouter()
# 前端預覽 URL 一律帶版本化的 ?t=（updated_at／編輯時間戳），內容變更即換 URL，
# 因此回應可以讓瀏覽器快取：來回切頁不再重新下載整面縮圖牆
PREVIEW_CACHE_HEADERS = {
    "Cache-Control": "private, max-age=604800",
}


def effective_download_mode(
    mode: str = Query("print", pattern="^(print|screen)$"),
    current_user: User = Depends(get_current_user),
) -> str:
    """下載畫質權限規則的唯一真相來源：非 admin 一律強制螢幕畫質。"""
    return mode if current_user.role == "admin" else "screen"


def _stored_preview_response(cache_prefix: str, payload: dict, render_bytes) -> Response:
    """組出預覽回應：快取讀寫與渲染細節在 services/preview_cache.py。"""
    image_bytes, cache_key, hit = get_or_render_preview(cache_prefix, payload, render_bytes)
    return Response(
        content=image_bytes,
        media_type="image/jpeg",
        headers={
            **PREVIEW_CACHE_HEADERS,
            "X-Preview-Cache-Key": cache_key,
            "X-Preview-Cache": "HIT" if hit else "MISS",
        },
    )


@router.get("/{project_id}/preview/{page_index}")
def preview_project_page(
    project_id: int,
    page_index: int,
    scale: float = Query(PREVIEW_RENDER_SCALE, ge=0.4, le=1.0),
    t: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """使用專案層級對應文字（label_texts）渲染頁面預覽，回傳 JPEG。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    page_layouts = get_template_page_layouts(project)
    if page_index < 0 or page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="頁面索引超出範圍")

    project_label_texts = _parse_json_field(project.label_texts_json or "{}", "label_texts_json")
    page_label_texts = project_label_texts.get(str(page_index), {})
    page_data = {"label_texts": page_label_texts}
    page_layout = page_layouts[page_index]
    cache_prefix = (
        f"projects/proj{project_id}/previews/project/"
        f"page{page_index}/scale{preview_scale_key(scale)}"
    )
    return _stored_preview_response(
        cache_prefix,
        # 純內容定址：layout 與 page_data 全文已在 hash 內，任何實質變更都會換 key；
        # 不混入 updated_at，避免無關的編輯（例如某位學生的照片）作廢這份快取
        {
            "kind": "project",
            "page_index": page_index,
            "scale": scale,
            "layout": page_layout,
            "page_data": page_data,
        },
        lambda: render_preview_jpeg_bytes(page_layout, "（姓名）", page_data, page_index, scale),
    )


@router.get("/{project_id}/students/{student_id}/preview/{page_index}")
def preview_student_page(
    project_id: int,
    student_id: int,
    page_index: int,
    scale: float = Query(PREVIEW_RENDER_SCALE, ge=0.4, le=1.0),
    t: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """渲染學生個人頁面預覽，回傳 JPEG。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index < 0 or page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="頁面索引超出範圍")

    project_label_texts = _parse_json_field(project.label_texts_json or "{}", "label_texts_json")
    student_pages_data = merge_project_label_texts_into_pages(
        _parse_json_field(student.pages_data_json, "pages_data_json"),
        project_label_texts,
        page_layouts,
    )

    page_data_by_index = {
        page_data["page_index"]: page_data
        for page_data in student_pages_data
    }
    current_page_data = page_data_by_index.get(page_index, {})
    page_layout = page_layouts[page_index]
    cache_prefix = (
        f"projects/proj{project_id}/previews/students/student{student_id}/"
        f"page{page_index}/scale{preview_scale_key(scale)}"
    )
    return _stored_preview_response(
        cache_prefix,
        # 純內容定址（不混 updated_at）：改一位學生的字不再作廢全班 60 份快取。
        # 同名重傳造成「key 相同、bytes 不同」由照片紀錄的 v 欄位負責換 hash
        {
            "kind": "student",
            "student_name": student.name,
            "page_index": page_index,
            "scale": scale,
            "layout": page_layout,
            "page_data": current_page_data,
        },
        lambda: render_preview_jpeg_bytes(page_layout, student.name, current_page_data, page_index, scale),
    )


@router.post("/{project_id}/students/{student_id}/render", response_model=RenderStudentResult)
def render_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """渲染單一學生的相冊，儲存為列印用 PDF、螢幕用 PDF 與單頁圖片。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    logger.info("開始渲染 project_id=%s student_id=%s student=%s", project_id, student_id, student.name)
    t0 = time.monotonic()
    with album_render_limiter.acquire("相本 PDF 正在產生中，請稍後再試"):
        result = render_and_save_student_album(project, student, project_id, db)
    logger.info("渲染完成 project_id=%s student_id=%s 耗時=%.2fs pages=%s",
                project_id, student_id, time.monotonic() - t0, result.get("pages"))
    return result


@router.post("/{project_id}/render/all", response_model=RenderAllResult)
def render_all_students(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次渲染專案中所有學生的相冊。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)

    render_results = []
    render_errors = []
    t_all = time.monotonic()
    logger.info("開始批次渲染 project_id=%s 共 %s 位學生", project_id, len(project.students))

    skipped_count = 0
    for student in project.students:
        t0 = time.monotonic()
        try:
            # 逐位取槽（而非整班佔住），其他老師的單本渲染可交錯進行
            with album_render_limiter.acquire_blocking():
                result = render_and_save_student_album(project, student, project_id, db)
            render_results.append({"student": student.name, "pdf": result["pdf"]})
            if result.get("skipped"):
                skipped_count += 1
            else:
                logger.info("  ✓ %s 耗時=%.2fs", student.name, time.monotonic() - t0)
        except Exception as render_error:
            db.rollback()
            render_errors.append({"student": student.name, "error": "產生失敗"})
            logger.error("  ✗ %s 失敗: %s", student.name, render_error)

    logger.info("批次渲染完成 project_id=%s 成功=%s（內容未變跳過=%s）失敗=%s 總耗時=%.2fs",
                project_id, len(render_results), skipped_count, len(render_errors), time.monotonic() - t_all)
    return {"rendered": render_results, "errors": render_errors}


@router.get("/{project_id}/students/{student_id}/pdf")
def download_student_pdf(
    project_id: int,
    student_id: int,
    effective_mode: str = Depends(effective_download_mode),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊 PDF。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    # 非 admin 強制降為螢幕畫質

    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生 PDF，請先渲染")

    # output_filename 為列印版 key，如 "projects/proj1/output/stem.pdf"
    pdf_key = student_pdf_key_for_mode(student.output_filename, effective_mode)

    storage = get_storage()
    if not storage.exists(pdf_key):
        raise HTTPException(status_code=404, detail="PDF file missing — please render first")

    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if effective_mode == "screen" else ""
    download_filename = f"{combined_stem}{screen_suffix}.pdf"
    content_disposition = build_content_disposition_header(download_filename)

    return Response(
        content=storage.get_bytes(pdf_key),
        media_type="application/pdf",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/students/{student_id}/images")
def download_student_images_as_zip(
    project_id: int,
    student_id: int,
    effective_mode: str = Depends(effective_download_mode),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊的單頁 JPG 圖片 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)


    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生圖片，請先渲染")

    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if effective_mode == "screen" else ""
    content_disposition = build_content_disposition_header(f"{combined_stem}{screen_suffix}_images.zip")

    with zip_build_limiter.acquire("圖片 ZIP 正在產生中，請稍後再試"):
        image_entries = get_student_image_entries(project, student, effective_mode)
        if not image_entries:
            raise HTTPException(status_code=404, detail="圖片檔案不存在，請重新渲染")
        zip_bytes = build_zip_of_student_images(project, student, effective_mode, image_entries)

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/students/{student_id}/images/{page_number}")
def download_student_image(
    project_id: int,
    student_id: int,
    page_number: int = Path(..., ge=1),
    effective_mode: str = Depends(effective_download_mode),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊的單頁 JPG。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)


    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生圖片，請先渲染")

    image_entries = get_student_image_entries(project, student, effective_mode)
    if not image_entries:
        raise HTTPException(status_code=404, detail="圖片檔案不存在，請重新渲染")
    if page_number > len(image_entries):
        raise HTTPException(status_code=404, detail="圖片頁碼超出範圍")

    filename, image_bytes = image_entries[page_number - 1]
    content_disposition = build_content_disposition_header(filename)

    return Response(
        content=image_bytes,
        media_type="image/jpeg",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/download/all")
def download_all_pdfs_as_zip(
    project_id: int,
    effective_mode: str = Depends(effective_download_mode),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """將所有已渲染的學生 PDF 打包為 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)


    zip_filename = f"{project.name}.zip"
    content_disposition = build_content_disposition_header(zip_filename)

    # 邊壓邊送：下載立即開始、峰值記憶體只有單本 PDF（zip 併發槽在產生器內取放）
    return StreamingResponse(
        open_all_student_pdfs_zip_stream(project, effective_mode),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/download/all/images")
def download_all_images_as_zip(
    project_id: int,
    effective_mode: str = Depends(effective_download_mode),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """將所有已渲染學生的單頁 JPG 圖片打包為 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)


    screen_suffix = "_screen" if effective_mode == "screen" else ""
    zip_filename = f"{project.name}{screen_suffix}_images.zip"
    content_disposition = build_content_disposition_header(zip_filename)

    # 邊壓邊送：下載立即開始、峰值記憶體只有單頁 JPG（zip 併發槽在產生器內取放）
    return StreamingResponse(
        open_all_student_images_zip_stream(project, effective_mode),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
