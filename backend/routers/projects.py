# 專案路由模組
# 處理專案、學生、照片、氣泡文字、渲染、下載與審閱留言的所有 HTTP 端點，
# 路由層僅負責接收請求與組裝回應，所有業務邏輯委派給 crud / service 層

import io
import json
import logging
import time
from typing import Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user, require_role
from database import Project, ProjectComment, Student, Template, User, get_db
from crud.project_crud import get_project_or_404, get_student_or_404
from crud.user_crud import get_subordinate_user_ids
from services.file_service import get_photo_key, rename_photo_to_slot, save_uploaded_file
from services.project_service import (
    build_combined_stem,
    build_content_disposition_header,
    build_zip_of_all_student_pdfs,
    get_template_page_layouts,
    merge_project_label_texts_into_pages,
    render_and_save_student_album,
)
from services.render_service import render_page
from services.storage import get_storage

router = APIRouter(prefix="/api/projects", tags=["projects"])

# label_texts 格式：{label_id_str: text_str}，值必須為字串
LabelTextsPayload = dict[str, str]


def _parse_json_field(raw: str, field_name: str = "欄位") -> any:
    """安全解析 JSON 欄位，格式損壞時回傳 422 而非 500。"""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=422, detail=f"資料庫中的 {field_name} JSON 格式損壞，請聯絡管理員")


# ── 存取權限輔助 ──────────────────────────────────────────────────────────────

def assert_project_readable(
    project: Project,
    current_user: User,
    db: Session,
    subordinate_ids: set[int] | None = None,
):
    """
    確認目前使用者有權限讀取此專案，否則拋出 403。

    - admin：可讀全部
    - art_team：可讀全部（唯讀）
    - supervisor：只能讀自己管轄老師的專案
    - teacher：只能讀自己的專案

    subordinate_ids 可由外部傳入（已查好時），避免同一 request 重複查詢。
    """
    if current_user.role == "admin":
        return
    if current_user.role == "art_team":
        return
    if current_user.role == "supervisor":
        if subordinate_ids is None:
            subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        if project.owner_id in subordinate_ids:
            return
    if current_user.role == "teacher" and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的存取權限")


def assert_comment_deletable(comment: "ProjectComment", current_user: User):
    """確認目前使用者有權限刪除此留言，否則拋出 403。admin 可刪任何人的留言。"""
    if current_user.role == "admin":
        return
    if comment.author_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="只能刪除自己的留言")


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
    query = db.query(Project).options(joinedload(Project.owner), joinedload(Project.students))

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
    name: str = Form(..., max_length=100),
    template_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "teacher")),
):
    """建立新專案，需指定使用的模板，自動設定所有者為當前使用者。"""
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="找不到模板")

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
        "label_texts": _parse_json_field(project.label_texts_json or "{}", "label_texts_json"),
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "order_index": student.order_index,
                "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
                "output_filename": student.output_filename,
            }
            for student in project.students
        ],
    }


@router.patch("/{project_id}")
def rename_project(
    project_id: int,
    name: str = Form(..., max_length=100),
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
    # 先刪檔案再 commit：避免 DB 已提交但檔案刪除失敗造成孤立記錄
    get_storage().delete_prefix(f"projects/proj{project_id}")
    db.delete(project)
    db.commit()
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
    get_storage().delete_prefix(f"projects/proj{project_id}/photos/student{student_id}")
    return {"ok": True}


# ── 頁面跳過（個別學生刪除頁） ───────────────────────────────────────────────

@router.patch("/{project_id}/students/{student_id}/pages/{page_index}/skip")
def set_page_skip(
    project_id: int,
    student_id: int,
    page_index: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """設定或取消學生某頁的跳過旗標（渲染時略過此頁）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })
    pages_data[page_index]["skip"] = bool(payload.get("skip", True))
    student.pages_data_json = json.dumps(pages_data)
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
    current_user: User = Depends(get_current_user),
):
    """上傳學生照片至指定頁面的指定欄位，並更新頁面資料記錄。"""
    _ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
    _MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > _MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="檔案過大，上限 10 MB")
    await file.seek(0)

    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })

    # 若該 slot 已有舊照片，先刪除避免殘留（delete 已處理不存在的情況）
    old_record = pages_data[page_index]["photos"].get(str(slot_id))
    if old_record:
        old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
        get_storage().delete(old_key)

    key = get_photo_key(project_id, student_id, page_index, slot_id, file.filename)
    await save_uploaded_file(key, file)

    pages_data[page_index]["photos"][str(slot_id)] = {
        "path": key,
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
    }
    student.pages_data_json = json.dumps(pages_data)
    db.commit()

    return {"filename": key.split("/")[-1], "path": key}


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

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="找不到頁面")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_record:
        raise HTTPException(status_code=404, detail="找不到照片")

    photo_key = (
        photo_record
        if isinstance(photo_record, str)
        else photo_record.get("path", "")
    )
    if not photo_key:
        raise HTTPException(status_code=404, detail="找不到照片")

    storage = get_storage()
    if not storage.exists(photo_key):
        raise HTTPException(status_code=404, detail="找不到照片")

    return storage.serve(photo_key)


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
    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")

    renames = {}  # 記錄所有重命名結果，供前端同步 serverPath
    all_pages = payload.get("pages", {})

    # 跨頁統一收集所有「即將被寫入」的路徑，防止跨頁互換時先刪後找不到
    incoming_paths: set[str] = set()
    for slot_updates in all_pages.values():
        for photo_path in slot_updates.values():
            if photo_path is not None:
                path_str = photo_path if isinstance(photo_path, str) else photo_path.get("path", "")
                if path_str:
                    incoming_paths.add(path_str)

    # 第一步：所有頁面的非 null 項目先重命名並寫入
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        while len(pages_data) <= page_index:
            pages_data.append({
                "page_index": len(pages_data),
                "photos": {},
                "label_texts": {},
            })
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is None:
                continue
            if isinstance(photo_path, dict) and photo_path.get("path"):
                new_path_str = rename_photo_to_slot(
                    photo_path["path"], page_index, int(slot_id_str)
                )
                # 同步更新 incoming_paths，讓後續 null 清除知道新路徑
                if new_path_str != photo_path["path"]:
                    incoming_paths.discard(photo_path["path"])
                    incoming_paths.add(new_path_str)
                    renames.setdefault(page_index_str, {})[slot_id_str] = new_path_str
                photo_path = {**photo_path, "path": new_path_str}
            pages_data[page_index]["photos"][slot_id_str] = photo_path

    # 第二步：所有頁面的 null 項目統一清除，只刪除未被移走的檔案
    storage = get_storage()
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is not None:
                continue
            old_record = pages_data[page_index]["photos"].get(slot_id_str)
            if old_record:
                old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
                if old_key and old_key not in incoming_paths:
                    storage.delete(old_key)
            pages_data[page_index]["photos"].pop(slot_id_str, None)

    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True, "renames": renames}


# ── 專案層級對印文字 ──────────────────────────────────────────────────────────

@router.get("/{project_id}/label_texts")
def get_project_label_texts(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案層級的對印文字設定。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    return _parse_json_field(project.label_texts_json or "{}", "label_texts_json")


@router.put("/{project_id}/label_texts")
def update_project_label_texts(
    project_id: int,
    payload: LabelTextsPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新專案層級的對印文字設定。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    project.label_texts_json = json.dumps(payload)
    db.commit()
    return {"ok": True}


# ── 學生個人對印文字 ──────────────────────────────────────────────────────────

@router.put("/{project_id}/students/{student_id}/pages/{page_index}/texts")
def update_student_label_texts(
    project_id: int,
    student_id: int,
    page_index: int,
    texts: LabelTextsPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新學生指定頁面的個人對印文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })

    pages_data[page_index]["label_texts"] = texts
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
    """批次更新多位學生的對印文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    students_payload = payload.get("students", {})

    for student in project.students:
        student_id_str = str(student.id)
        if student_id_str not in students_payload:
            continue

        pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
        for page_index_str, label_texts in students_payload[student_id_str].items():
            page_index = int(page_index_str)
            while len(pages_data) <= page_index:
                pages_data.append({
                    "page_index": len(pages_data),
                    "photos": {},
                    "label_texts": {},
                })
            pages_data[page_index]["label_texts"] = label_texts

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
    logger.info("開始渲染 project_id=%s student_id=%s student=%s", project_id, student_id, student.name)
    t0 = time.monotonic()
    result = render_and_save_student_album(project, student, project_id, db)
    logger.info("渲染完成 project_id=%s student_id=%s 耗時=%.2fs pages=%s",
                project_id, student_id, time.monotonic() - t0, result.get("pages"))
    return result


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
            render_errors.append({"student": student.name, "error": str(render_error)})
            logger.error("  ✗ %s 失敗: %s", student.name, render_error)

    logger.info("批次渲染完成 project_id=%s 成功=%s 失敗=%s 總耗時=%.2fs",
                project_id, len(render_results), len(render_errors), time.monotonic() - t_all)
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

    comments = (
        db.query(ProjectComment)
        .options(joinedload(ProjectComment.author))
        .filter(ProjectComment.project_id == project_id)
        .order_by(ProjectComment.created_at)
        .all()
    )
    return [
        {
            "id": comment.id,
            "author_id": comment.author_id,
            "author_name": comment.author.display_name,
            "content": comment.content,
            "created_at": comment.created_at,
        }
        for comment in comments
    ]


@router.post("/{project_id}/comments", status_code=201)
def add_comment(
    project_id: int,
    content: str = Form(..., max_length=1000),
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
    assert_comment_deletable(comment, current_user)
    db.delete(comment)
    db.commit()
    return {"ok": True}
