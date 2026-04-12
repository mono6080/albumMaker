# 專案路由模組
# 處理專案、學生、照片、氣泡文字、渲染與下載的所有 HTTP 端點，
# 路由層僅負責接收請求與組裝回應，所有業務邏輯委派給 crud / service 層

import io
import json
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from database import Project, Student, Template, get_db
from crud.project_crud import get_project_or_404, get_student_or_404
from services.file_service import get_photo_destination_path, save_uploaded_file
from services.project_service import (
    build_combined_stem,
    build_content_disposition_header,
    build_zip_of_all_student_pdfs,
    get_project_output_dir,
    get_template_page_layouts,
    merge_project_bubble_texts_into_pages,
    render_and_save_student_album,
)
from services.render_service import UPLOADS_DIR, render_page

router = APIRouter(prefix="/api/projects", tags=["projects"])


# ── 專案 CRUD ─────────────────────────────────────────────────────────────────

@router.get("/")
def list_projects(db: Session = Depends(get_db)):
    """回傳所有專案的摘要清單（依建立時間降序）。"""
    all_projects = db.query(Project).order_by(Project.created_at.desc()).all()
    return [
        {
            "id": project.id,
            "name": project.name,
            "template_id": project.template_id,
            "created_at": project.created_at,
            "student_count": len(project.students),
        }
        for project in all_projects
    ]


@router.post("/")
def create_project(
    name: str = Form(...),
    template_id: int = Form(...),
    db: Session = Depends(get_db),
):
    """建立新專案，需指定使用的模板。"""
    # 確認模板存在
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    new_project = Project(name=name, template_id=template_id)
    db.add(new_project)
    db.commit()
    db.refresh(new_project)
    return {"id": new_project.id, "name": new_project.name}


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db)):
    """回傳專案詳細資訊，包含所有學生與其頁面資料。"""
    project = get_project_or_404(project_id, db)
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "created_at": project.created_at,
        "bubble_texts": json.loads(project.bubble_texts_json or "{}"),
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "order_index": student.order_index,
                "pages_data": json.loads(student.pages_data_json),
                "output_filename": student.output_filename,
            }
            for student in project.students
        ],
    }


@router.patch("/{project_id}")
def rename_project(
    project_id: int,
    name: str = Form(...),
    db: Session = Depends(get_db),
):
    """修改專案名稱（行內編輯）。"""
    project = get_project_or_404(project_id, db)
    project.name = name.strip()
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    """刪除指定專案及其所有學生資料。"""
    project = get_project_or_404(project_id, db)
    db.delete(project)
    db.commit()
    return {"ok": True}


# ── 學生管理 ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/batch")
def batch_add_students(
    project_id: int,
    names: list[str],
    db: Session = Depends(get_db),
):
    """批次新增多位學生，自動跳過空白名稱與重複名稱。"""
    project = get_project_or_404(project_id, db)

    # 收集已存在的學生名稱，防止重複
    existing_names = {student.name for student in project.students}
    created_names = []
    skipped_names = []
    names_seen_in_batch = set()
    next_order_index = max(
        (student.order_index for student in project.students),
        default=-1
    ) + 1

    for raw_name in names:
        student_name = raw_name.strip()
        if not student_name:
            continue
        if student_name in existing_names or student_name in names_seen_in_batch:
            skipped_names.append(student_name)
            continue

        names_seen_in_batch.add(student_name)
        new_student = Student(
            project_id=project_id,
            name=student_name,
            order_index=next_order_index,
            pages_data_json="[]",
        )
        db.add(new_student)
        created_names.append(student_name)
        next_order_index += 1

    db.commit()
    return {"created": created_names, "skipped": skipped_names}


@router.put("/{project_id}/students/{student_id}")
def update_student(
    project_id: int,
    student_id: int,
    name: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """更新學生基本資料（目前支援修改姓名）。"""
    student = get_student_or_404(student_id, project_id, db)
    if name:
        student.name = name
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}/students/{student_id}")
def delete_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
):
    """刪除指定學生及其所有資料。"""
    student = get_student_or_404(student_id, project_id, db)
    db.delete(student)
    db.commit()
    return {"ok": True}


# ── 照片上傳與讀取 ────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
async def upload_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """上傳學生照片至指定頁面的指定欄位，並更新頁面資料記錄。"""
    student = get_student_or_404(student_id, project_id, db)

    # 計算儲存路徑並寫入檔案
    destination_path = get_photo_destination_path(
        project_id, student_id, page_index, slot_id, file.filename
    )
    await save_uploaded_file(file, destination_path)

    # 更新學生的頁面照片資料
    pages_data = json.loads(student.pages_data_json)

    # 確保頁面條目存在（不足時補齊空頁）
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "bubble_texts": {},
        })

    pages_data[page_index]["photos"][str(slot_id)] = {
        "path": str(destination_path),
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
    }
    student.pages_data_json = json.dumps(pages_data)
    db.commit()

    return {"filename": destination_path.name, "path": str(destination_path)}


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
def get_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session = Depends(get_db),
):
    """回傳學生指定欄位的照片檔案。"""
    student = get_student_or_404(student_id, project_id, db)

    pages_data = json.loads(student.pages_data_json)
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="Page not found")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_record:
        raise HTTPException(status_code=404, detail="Photo not found")

    # 相容舊格式（直接儲存路徑字串）與新格式（dict 含 path 鍵）
    photo_path_str = (
        photo_record
        if isinstance(photo_record, str)
        else photo_record.get("path", "")
    )
    if not photo_path_str:
        raise HTTPException(status_code=404, detail="Photo not found")

    photo_file_path = Path(photo_path_str)
    if not photo_file_path.exists():
        raise HTTPException(status_code=404, detail="Photo not found")

    return FileResponse(str(photo_file_path))


# ── 照片對應更新（重新排列 / 刪除，不需重新上傳） ────────────────────────────

@router.put("/{project_id}/students/{student_id}/photos/mapping")
def update_photo_mapping(
    project_id: int,
    student_id: int,
    payload: dict,
    db: Session = Depends(get_db),
):
    """
    直接更新欄位→路徑的對應關係，支援重新排列與清除欄位。

    payload 格式：{"pages": {"0": {"1": "/server/path", "2": null}, ...}}
    null 值表示清除該欄位的照片。
    """
    student = get_student_or_404(student_id, project_id, db)
    pages_data = json.loads(student.pages_data_json)

    for page_index_str, slot_updates in payload.get("pages", {}).items():
        page_index = int(page_index_str)

        # 確保頁面條目存在
        while len(pages_data) <= page_index:
            pages_data.append({
                "page_index": len(pages_data),
                "photos": {},
                "bubble_texts": {},
            })

        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is None:
                # 清除欄位
                pages_data[page_index]["photos"].pop(slot_id_str, None)
            else:
                pages_data[page_index]["photos"][slot_id_str] = photo_path

    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── 專案層級氣泡文字 ──────────────────────────────────────────────────────────

@router.get("/{project_id}/bubble_texts")
def get_project_bubble_texts(project_id: int, db: Session = Depends(get_db)):
    """取得專案層級的氣泡文字設定。"""
    project = get_project_or_404(project_id, db)
    return json.loads(project.bubble_texts_json or "{}")


@router.put("/{project_id}/bubble_texts")
def update_project_bubble_texts(
    project_id: int,
    payload: dict,
    db: Session = Depends(get_db),
):
    """
    更新專案層級的氣泡文字設定。

    payload 格式：{"<page_index>": {"<bubble_id>": "text", ...}, ...}
    """
    project = get_project_or_404(project_id, db)
    project.bubble_texts_json = json.dumps(payload)
    db.commit()
    return {"ok": True}


# ── 學生個人氣泡文字 ──────────────────────────────────────────────────────────

@router.put("/{project_id}/students/{student_id}/pages/{page_index}/texts")
def update_student_bubble_texts(
    project_id: int,
    student_id: int,
    page_index: int,
    texts: dict,
    db: Session = Depends(get_db),
):
    """
    更新學生指定頁面的個人氣泡文字。

    texts 格式：{"1": "文字內容...", "2": "..."}
    """
    student = get_student_or_404(student_id, project_id, db)

    pages_data = json.loads(student.pages_data_json)
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "bubble_texts": {},
        })

    pages_data[page_index]["bubble_texts"] = texts
    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── 批次文字填入 ──────────────────────────────────────────────────────────────

@router.put("/{project_id}/batch/texts")
def batch_update_texts(
    project_id: int,
    payload: dict,
    db: Session = Depends(get_db),
):
    """
    批次更新多位學生的氣泡文字。

    payload 格式：
    {
      "students": {
        "<student_id>": {
          "<page_index>": {"<bubble_id>": "text", ...},
          ...
        },
        ...
      }
    }
    """
    project = get_project_or_404(project_id, db)
    students_payload = payload.get("students", {})

    for student in project.students:
        student_id_str = str(student.id)
        if student_id_str not in students_payload:
            continue

        pages_data = json.loads(student.pages_data_json)
        for page_index_str, bubble_texts in students_payload[student_id_str].items():
            page_index = int(page_index_str)
            while len(pages_data) <= page_index:
                pages_data.append({
                    "page_index": len(pages_data),
                    "photos": {},
                    "bubble_texts": {},
                })
            pages_data[page_index]["bubble_texts"] = bubble_texts

        student.pages_data_json = json.dumps(pages_data)

    db.commit()
    return {"ok": True}


# ── 預覽 ──────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/preview/{page_index}")
def preview_project_page(
    project_id: int,
    page_index: int,
    db: Session = Depends(get_db),
):
    """使用專案層級氣泡文字渲染頁面預覽（姓名以佔位符顯示），回傳 JPEG。"""
    project = get_project_or_404(project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="Page index out of range")

    project_bubble_texts = json.loads(project.bubble_texts_json or "{}")
    page_bubble_texts = project_bubble_texts.get(str(page_index), {})

    preview_image = render_page(
        page_layouts[page_index],
        "（姓名）",
        {"bubble_texts": page_bubble_texts},
        page_index=page_index,
    )

    image_buffer = io.BytesIO()
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=85)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")


@router.get("/{project_id}/students/{student_id}/preview/{page_index}")
def preview_student_page(
    project_id: int,
    student_id: int,
    page_index: int,
    db: Session = Depends(get_db),
):
    """渲染學生個人頁面預覽（含照片與個人氣泡文字），回傳 JPEG。"""
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="Page index out of range")

    # 合併專案與學生的氣泡文字
    project_bubble_texts = json.loads(project.bubble_texts_json or "{}")
    student_pages_data = merge_project_bubble_texts_into_pages(
        json.loads(student.pages_data_json),
        project_bubble_texts,
    )

    # 依頁碼建立快速查表
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
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=85)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")


# ── 渲染 ──────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/{student_id}/render")
def render_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
):
    """渲染單一學生的相冊，儲存為列印用 PDF、螢幕用 PDF 與單頁圖片。"""
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)
    return render_and_save_student_album(project, student, project_id, db)


@router.post("/{project_id}/render/all")
def render_all_students(project_id: int, db: Session = Depends(get_db)):
    """批次渲染專案中所有學生的相冊。"""
    project = get_project_or_404(project_id, db)

    render_results = []
    render_errors = []

    for student in project.students:
        try:
            result = render_and_save_student_album(project, student, project_id, db)
            render_results.append({"student": student.name, "pdf": result["pdf"]})
        except Exception as render_error:
            render_errors.append({"student": student.name, "error": str(render_error)})

    return {"rendered": render_results, "errors": render_errors}


# ── 下載 ──────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/students/{student_id}/pdf")
def download_student_pdf(
    project_id: int,
    student_id: int,
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
):
    """下載學生個人相冊 PDF（支援列印與螢幕品質兩種模式）。"""
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    if not student.output_filename:
        raise HTTPException(status_code=404, detail="PDF not generated yet")

    base_pdf_path = Path(student.output_filename)
    pdf_file_path = (
        base_pdf_path.parent / f"{base_pdf_path.stem}_screen.pdf"
        if mode == "screen"
        else base_pdf_path
    )

    if not pdf_file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="PDF file missing — please render first"
        )

    # 組合下載檔名（含螢幕版後綴）
    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if mode == "screen" else ""
    download_filename = f"{combined_stem}{screen_suffix}.pdf"

    content_disposition = build_content_disposition_header(download_filename)
    return FileResponse(
        pdf_file_path,
        media_type="application/pdf",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/{project_id}/download/all")
def download_all_pdfs_as_zip(
    project_id: int,
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
):
    """將專案中所有已渲染的學生 PDF 打包為 ZIP 並下載。"""
    project = get_project_or_404(project_id, db)

    zip_bytes = build_zip_of_all_student_pdfs(project, mode)

    # 組合 ZIP 下載檔名
    zip_filename = f"{project.name}.zip"
    content_disposition = build_content_disposition_header(zip_filename)

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
