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
    build_zip_of_all_student_images,
    build_zip_of_all_student_pdfs,
    build_zip_of_student_images,
    get_student_image_entries,
    get_template_page_layouts,
    merge_project_label_texts_into_pages,
    render_and_save_student_album,
)
from services.render_service import render_page
from services.storage import get_storage

from ._helpers import (
    _parse_json_field,
    assert_project_readable,
    assert_project_writable,
)
from .schemas import RenderAllResult, RenderStudentResult

logger = logging.getLogger(__name__)

router = APIRouter()
PREVIEW_JPEG_QUALITY = 72


@router.get("/{project_id}/preview/{page_index}")
def preview_project_page(
    project_id: int,
    page_index: int,
    db: Session = Depends(get_db),
):
    """使用專案層級對應文字（label_texts）渲染頁面預覽，回傳 JPEG。"""
    project = get_project_or_404(project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="頁面索引超出範圍")

    project_label_texts = _parse_json_field(project.label_texts_json or "{}", "label_texts_json")
    page_label_texts = project_label_texts.get(str(page_index), {})

    preview_image = render_page(
        page_layouts[page_index],
        "（姓名）",
        {"label_texts": page_label_texts},
        page_index=page_index,
    )

    image_buffer = io.BytesIO()
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=PREVIEW_JPEG_QUALITY)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")


@router.get("/{project_id}/students/{student_id}/preview/{page_index}")
def preview_student_page(
    project_id: int,
    student_id: int,
    page_index: int,
    db: Session = Depends(get_db),
):
    """渲染學生個人頁面預覽，回傳 JPEG。"""
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="頁面索引超出範圍")

    project_label_texts = _parse_json_field(project.label_texts_json or "{}", "label_texts_json")
    student_pages_data = merge_project_label_texts_into_pages(
        _parse_json_field(student.pages_data_json, "pages_data_json"),
        project_label_texts,
    )

    page_data_by_index = {
        page_data["page_index"]: page_data
        for page_data in student_pages_data
    }
    current_page_data = page_data_by_index.get(page_index, {})

    preview_image = render_page(
        page_layouts[page_index],
        student.name,
        current_page_data,
        page_index=page_index,
    )

    image_buffer = io.BytesIO()
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=PREVIEW_JPEG_QUALITY)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")


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

    # 迴圈外預先讀取模板佈局，避免每個學生重複查詢 N×1
    shared_page_layouts = get_template_page_layouts(project)

    for student in project.students:
        t0 = time.monotonic()
        try:
            result = render_and_save_student_album(project, student, project_id, db, shared_page_layouts)
            render_results.append({"student": student.name, "pdf": result["pdf"]})
            logger.info("  ✓ %s 耗時=%.2fs", student.name, time.monotonic() - t0)
        except Exception as render_error:
            db.rollback()
            render_errors.append({"student": student.name, "error": "渲染失敗"})
            logger.error("  ✗ %s 失敗: %s", student.name, render_error)

    logger.info("批次渲染完成 project_id=%s 成功=%s 失敗=%s 總耗時=%.2fs",
                project_id, len(render_results), len(render_errors), time.monotonic() - t_all)
    return {"rendered": render_results, "errors": render_errors}


@router.get("/{project_id}/students/{student_id}/pdf")
def download_student_pdf(
    project_id: int,
    student_id: int,
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊 PDF。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    # 非 admin 強制降為螢幕畫質
    effective_mode = mode if current_user.role == "admin" else "screen"

    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生 PDF，請先渲染")

    # output_filename 為 key，如 "projects/proj1/output/stem.pdf"
    base_key = student.output_filename
    pdf_key = (
        base_key[:-4] + "_screen.pdf"
        if effective_mode == "screen"
        else base_key
    )

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
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊的單頁 JPG 圖片 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    effective_mode = mode if current_user.role == "admin" else "screen"

    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生圖片，請先渲染")

    image_entries = get_student_image_entries(project, student, effective_mode)
    if not image_entries:
        raise HTTPException(status_code=404, detail="圖片檔案不存在，請重新渲染")

    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if effective_mode == "screen" else ""
    content_disposition = build_content_disposition_header(f"{combined_stem}{screen_suffix}_images.zip")

    return StreamingResponse(
        io.BytesIO(build_zip_of_student_images(project, student, effective_mode, image_entries)),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/students/{student_id}/images/{page_number}")
def download_student_image(
    project_id: int,
    student_id: int,
    page_number: int = Path(..., ge=1),
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """下載學生個人相冊的單頁 JPG。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    effective_mode = mode if current_user.role == "admin" else "screen"

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
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """將所有已渲染的學生 PDF 打包為 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    effective_mode = mode if current_user.role == "admin" else "screen"

    zip_bytes = build_zip_of_all_student_pdfs(project, effective_mode)

    zip_filename = f"{project.name}.zip"
    content_disposition = build_content_disposition_header(zip_filename)

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/download/all/images")
def download_all_images_as_zip(
    project_id: int,
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """將所有已渲染學生的單頁 JPG 圖片打包為 ZIP。非 admin 使用者強制使用螢幕畫質。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    effective_mode = mode if current_user.role == "admin" else "screen"

    zip_bytes = build_zip_of_all_student_images(project, effective_mode)

    screen_suffix = "_screen" if effective_mode == "screen" else ""
    zip_filename = f"{project.name}{screen_suffix}_images.zip"
    content_disposition = build_content_disposition_header(zip_filename)

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
