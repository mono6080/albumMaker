# 專案路由模組
# 處理專案、學生、照片、氣泡文字、渲染、下載與審閱留言的所有 HTTP 端點，
# 路由層僅負責接收請求與組裝回應，所有業務邏輯委派給 crud / service 層

import io
import json
import shutil
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from database import Project, ProjectComment, Student, Template, User, get_db
from crud.project_crud import get_project_or_404, get_student_or_404
from crud.user_crud import get_subordinate_user_ids
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


# ── 存取權限輔助 ──────────────────────────────────────────────────────────────

def assert_project_readable(project: Project, current_user: User, db: Session):
    """
    確認目前使用者有權限讀取此專案，否則拋出 403。

    - admin：可讀全部
    - art_team：可讀全部（唯讀）
    - supervisor：只能讀自己管轄老師的專案
    - teacher：只能讀自己的專案
    """
    if current_user.role == "admin":
        return
    if current_user.role == "art_team":
        return
    if current_user.role == "supervisor":
        subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        if project.owner_id in subordinate_ids:
            return
    if current_user.role == "teacher" and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的存取權限")


def assert_project_writable(project: Project, current_user: User):
    """
    確認目前使用者有權限修改此專案，否則拋出 403。

    - admin：可修改全部
    - teacher：只能修改自己的專案
    - 其他角色：禁止
    """
    if current_user.role == "admin":
        return
    if current_user.role == "teacher" and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的編輯權限")


# ── 專案 CRUD ─────────────────────────────────────────────────────────────────

@router.get("/")
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """依角色回傳可存取的專案摘要清單（依建立時間降序）。"""
    query = db.query(Project)

    if current_user.role == "admin":
        pass  # 看全部
    elif current_user.role in ("art_team",):
        pass  # 看全部（唯讀）
    elif current_user.role == "supervisor":
        subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        query = query.filter(Project.owner_id.in_(subordinate_ids))
    elif current_user.role == "teacher":
        query = query.filter(Project.owner_id == current_user.id)
    else:
        return []

    all_projects = query.order_by(Project.created_at.desc()).all()
    return [
        {
            "id": project.id,
            "name": project.name,
            "template_id": project.template_id,
            "created_at": project.created_at,
            "student_count": len(project.students),
            "owner_id": project.owner_id,
            "owner_name": project.owner.display_name if project.owner else None,
        }
        for project in all_projects
    ]


@router.post("/")
def create_project(
    name: str = Form(...),
    template_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "teacher")),
):
    """建立新專案，需指定使用的模板，自動設定所有者為當前使用者。"""
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    new_project = Project(name=name, template_id=template_id, owner_id=current_user.id)
    db.add(new_project)
    db.commit()
    db.refresh(new_project)
    return {"id": new_project.id, "name": new_project.name}


@router.get("/{project_id}")
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳專案詳細資訊，包含所有學生與其頁面資料。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "created_at": project.created_at,
        "owner_id": project.owner_id,
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
    current_user: User = Depends(get_current_user),
):
    """修改專案名稱（行內編輯）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    project.name = name.strip()
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除指定專案及其所有學生資料與上傳檔案。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    db.delete(project)
    db.commit()
    # 刪除專案的照片目錄與 PDF 輸出目錄
    project_photo_dir = UPLOADS_DIR / "photos" / f"proj{project_id}"
    if project_photo_dir.exists():
        shutil.rmtree(project_photo_dir)
    project_output_dir = UPLOADS_DIR / "output" / f"proj{project_id}"
    if project_output_dir.exists():
        shutil.rmtree(project_output_dir)
    return {"ok": True}


# ── 學生管理 ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/batch")
def batch_add_students(
    project_id: int,
    names: list[str],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次新增多位學生，自動跳過空白名稱與重複名稱。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)

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
    current_user: User = Depends(get_current_user),
):
    """更新學生基本資料（目前支援修改姓名）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
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
    current_user: User = Depends(get_current_user),
):
    """刪除指定學生及其所有資料與照片檔案。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    db.delete(student)
    db.commit()
    # 刪除學生照片目錄（含所有頁面的照片）
    student_photo_dir = UPLOADS_DIR / "photos" / f"proj{project_id}" / f"student{student_id}"
    if student_photo_dir.exists():
        shutil.rmtree(student_photo_dir)
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
    current_user: User = Depends(get_current_user),
):
    """上傳學生照片至指定頁面的指定欄位，並更新頁面資料記錄。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = json.loads(student.pages_data_json)
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "bubble_texts": {},
        })

    # 若該 slot 已有舊照片，先刪除舊檔避免殘留
    old_record = pages_data[page_index]["photos"].get(str(slot_id))
    if old_record:
        old_path_str = old_record if isinstance(old_record, str) else old_record.get("path", "")
        if old_path_str:
            old_file = Path(old_path_str)
            if old_file.exists():
                old_file.unlink()

    destination_path = get_photo_destination_path(
        project_id, student_id, page_index, slot_id, file.filename
    )
    await save_uploaded_file(file, destination_path)

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
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = json.loads(student.pages_data_json)
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="Page not found")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_record:
        raise HTTPException(status_code=404, detail="Photo not found")

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


@router.put("/{project_id}/students/{student_id}/photos/mapping")
def update_photo_mapping(
    project_id: int,
    student_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """直接更新欄位→路徑的對應關係，支援重新排列與清除欄位。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    pages_data = json.loads(student.pages_data_json)

    for page_index_str, slot_updates in payload.get("pages", {}).items():
        page_index = int(page_index_str)
        while len(pages_data) <= page_index:
            pages_data.append({
                "page_index": len(pages_data),
                "photos": {},
                "bubble_texts": {},
            })
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is None:
                # 清除 slot：刪除實際檔案
                old_record = pages_data[page_index]["photos"].get(slot_id_str)
                if old_record:
                    old_path_str = old_record if isinstance(old_record, str) else old_record.get("path", "")
                    if old_path_str:
                        old_file = Path(old_path_str)
                        if old_file.exists():
                            old_file.unlink()
                pages_data[page_index]["photos"].pop(slot_id_str, None)
            else:
                pages_data[page_index]["photos"][slot_id_str] = photo_path

    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── 專案層級氣泡文字 ──────────────────────────────────────────────────────────

@router.get("/{project_id}/bubble_texts")
def get_project_bubble_texts(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案層級的氣泡文字設定。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    return json.loads(project.bubble_texts_json or "{}")


@router.put("/{project_id}/bubble_texts")
def update_project_bubble_texts(
    project_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新專案層級的氣泡文字設定。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
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
    current_user: User = Depends(get_current_user),
):
    """更新學生指定頁面的個人氣泡文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
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


@router.put("/{project_id}/batch/texts")
def batch_update_texts(
    project_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次更新多位學生的氣泡文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
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
    """使用專案層級氣泡文字渲染頁面預覽，回傳 JPEG。"""
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
    """渲染學生個人頁面預覽，回傳 JPEG。"""
    project = get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    page_layouts = get_template_page_layouts(project)
    if page_index >= len(page_layouts):
        raise HTTPException(status_code=404, detail="Page index out of range")

    project_bubble_texts = json.loads(project.bubble_texts_json or "{}")
    student_pages_data = merge_project_bubble_texts_into_pages(
        json.loads(student.pages_data_json),
        project_bubble_texts,
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
    preview_image.convert("RGB").save(image_buffer, format="JPEG", quality=85)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")


# ── 渲染 ──────────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/{student_id}/render")
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
    return render_and_save_student_album(project, student, project_id, db)


@router.post("/{project_id}/render/all")
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

    for student in project.students:
        try:
            result = render_and_save_student_album(project, student, project_id, db)
            render_results.append({"student": student.name, "pdf": result["pdf"]})
        except Exception as render_error:
            render_errors.append({"student": student.name, "error": str(render_error)})

    return {"rendered": render_results, "errors": render_errors}


# ── 下載（非 admin 強制 screen 模式）────────────────────────────────────────

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
        raise HTTPException(status_code=404, detail="PDF not generated yet")

    base_pdf_path = Path(student.output_filename)
    pdf_file_path = (
        base_pdf_path.parent / f"{base_pdf_path.stem}_screen.pdf"
        if effective_mode == "screen"
        else base_pdf_path
    )

    if not pdf_file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="PDF file missing — please render first"
        )

    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if effective_mode == "screen" else ""
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


# ── 審閱留言 ──────────────────────────────────────────────────────────────────

@router.get("/{project_id}/comments")
def list_comments(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案的所有審閱留言（依時間升序）。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    return [
        {
            "id": comment.id,
            "author_id": comment.author_id,
            "author_name": comment.author.display_name,
            "content": comment.content,
            "created_at": comment.created_at,
        }
        for comment in project.comments
    ]


@router.post("/{project_id}/comments", status_code=201)
def add_comment(
    project_id: int,
    content: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "art_team", "supervisor")),
):
    """新增審閱意見（限 admin、美學組、主管）。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    if not content.strip():
        raise HTTPException(status_code=400, detail="留言內容不可為空")

    new_comment = ProjectComment(
        project_id=project_id,
        author_id=current_user.id,
        content=content.strip(),
    )
    db.add(new_comment)
    db.commit()
    db.refresh(new_comment)

    return {
        "id": new_comment.id,
        "author_id": new_comment.author_id,
        "author_name": current_user.display_name,
        "content": new_comment.content,
        "created_at": new_comment.created_at,
    }


@router.delete("/{project_id}/comments/{comment_id}")
def delete_comment(
    project_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除留言（只能刪自己的留言，admin 可刪任何人的）。"""
    comment = db.query(ProjectComment).filter(
        ProjectComment.id == comment_id,
        ProjectComment.project_id == project_id,
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="留言不存在")
    if current_user.role != "admin" and comment.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="只能刪除自己的留言")
    db.delete(comment)
    db.commit()
    return {"ok": True}
