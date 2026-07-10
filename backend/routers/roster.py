# 名冊與學期彙整匯出路由（admin 專用）
# 提供跨專案的孩子名冊配對（連結/合併）與學期匯出（預覽分組、ZIP 下載）

import io

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_role
from crud.roster_crud import get_any_student_or_404, get_roster_child_or_404
from crud.user_crud import get_subordinate_user_ids
from database import User, get_db
from services.project_service import build_content_disposition_header
from services.request_limiter import album_render_limiter, zip_build_limiter
from services.roster_service import (
    build_semester_export_preview,
    build_semester_export_zip,
    build_teacher_overview_workbook,
    delete_roster_child_if_orphaned,
    link_student_to_new_child,
    merge_roster_children,
    render_missing_semester_albums,
)

router = APIRouter(prefix="/api/roster", tags=["roster"])


class LinkStudentPayload(BaseModel):
    """學生名冊配對 payload：指定既有名冊項，或 create_new 建立新孩子。"""
    roster_child_id: int | None = None
    create_new: bool = False


class RenderMissingPayload(BaseModel):
    """補渲染 payload：期別範圍與（選填）勾選的孩子清單。"""
    period_ids: list[int]
    roster_child_ids: list[int] | None = None


@router.get("/semester-export")
def get_semester_export_preview(
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "supervisor")),
):
    """回傳學期匯出預覽：依名冊孩子分組的各期狀態與待確認學生清單。

    主管唯讀：只看得到自己管轄老師（含自己）的專案，匯出與名冊操作仍限 admin。
    """
    owner_user_ids = None
    if current_user.role == "supervisor":
        owner_user_ids = get_subordinate_user_ids(current_user.id, db) + [current_user.id]
    return build_semester_export_preview(db, period_ids, owner_user_ids)


@router.get("/teacher-overview/export")
def export_teacher_overview_excel(
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "supervisor")),
):
    """下載老師進度 Excel（摘要 + 明細）。supervisor 只含管轄老師的資料。"""
    owner_user_ids = None
    if current_user.role == "supervisor":
        owner_user_ids = get_subordinate_user_ids(current_user.id, db) + [current_user.id]
    workbook_bytes = build_teacher_overview_workbook(db, period_ids, owner_user_ids)
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": build_content_disposition_header("老師進度.xlsx")},
    )


@router.put("/students/{student_id}/link")
def link_student_to_roster_child(
    student_id: int,
    payload: LinkStudentPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """把學生連到指定名冊項，或建立新名冊項（同名不同人的拆分）。"""
    student = get_any_student_or_404(student_id, db)
    previous_child_id = student.roster_child_id
    if payload.create_new:
        new_child = link_student_to_new_child(db, student)
    else:
        new_child = get_roster_child_or_404(payload.roster_child_id, db)
        student.roster_child_id = new_child.id
    # 換連結後舊名冊項變孤兒則清掉
    if previous_child_id != new_child.id:
        db.flush()
        delete_roster_child_if_orphaned(db, previous_child_id)
    db.commit()
    return {"ok": True, "roster_child_id": new_child.id}


@router.post("/children/{child_id}/merge/{target_child_id}")
def merge_roster_child_into(
    child_id: int,
    target_child_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """把一個名冊項的所有學生併入另一個名冊項（改名/誤拆修正）。"""
    if child_id == target_child_id:
        raise HTTPException(status_code=400, detail="不能將名冊項併入自己")
    source_child = get_roster_child_or_404(child_id, db)
    target_child = get_roster_child_or_404(target_child_id, db)
    moved_count = merge_roster_children(db, source_child, target_child)
    db.commit()
    return {"ok": True, "moved": moved_count}


@router.post("/semester-export/render-missing")
def render_missing_albums(
    payload: RenderMissingPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """批次補渲染範圍內缺列印 PDF 的學生相冊。"""
    with album_render_limiter.acquire("相冊正在產生中，請稍後再試"):
        return render_missing_semester_albums(db, payload.period_ids, payload.roster_child_ids)


@router.get("/semester-export/download")
def download_semester_export_zip(
    period_ids: list[int] = Query(..., min_length=1),
    mode: str = Query("print", pattern="^(print|screen)$"),
    roster_child_ids: list[int] | None = Query(None, description="只匯出勾選的孩子；不給代表全部"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """下載學期匯出 ZIP：班級/孩子/序號_期別-專案.pdf，附缺漏說明。"""
    with zip_build_limiter.acquire("學期匯出 ZIP 正在產生中，請稍後再試"):
        zip_bytes = build_semester_export_zip(db, period_ids, mode, roster_child_ids)
    content_disposition = build_content_disposition_header("學期彙整匯出.zip")
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
