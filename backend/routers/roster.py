# 名冊與學期彙整匯出路由（admin 專用）
# 提供跨專案的孩子名冊配對（連結/合併）與學期匯出（預覽分組、ZIP 下載）

import io

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_role
from crud.roster_crud import get_any_student_or_404, get_roster_child_or_404
from database import User, get_db
from services.project_service import build_content_disposition_header
from services.request_limiter import zip_build_limiter
from services.roster_service import (
    build_semester_export_preview,
    build_semester_export_zip,
    link_student_to_new_child,
    merge_roster_children,
)

router = APIRouter(prefix="/api/roster", tags=["roster"])


class LinkStudentPayload(BaseModel):
    """學生名冊配對 payload：指定既有名冊項，或 create_new 建立新孩子。"""
    roster_child_id: int | None = None
    create_new: bool = False


@router.get("/semester-export")
def get_semester_export_preview(
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """回傳學期匯出預覽：依名冊孩子分組的各期狀態與待確認學生清單。"""
    return build_semester_export_preview(db, period_ids)


@router.put("/students/{student_id}/link")
def link_student_to_roster_child(
    student_id: int,
    payload: LinkStudentPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """把學生連到指定名冊項，或建立新名冊項（同名不同人的拆分）。"""
    student = get_any_student_or_404(student_id, db)
    if payload.create_new:
        new_child = link_student_to_new_child(db, student)
        db.commit()
        return {"ok": True, "roster_child_id": new_child.id}
    roster_child = get_roster_child_or_404(payload.roster_child_id, db)
    student.roster_child_id = roster_child.id
    db.commit()
    return {"ok": True, "roster_child_id": roster_child.id}


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


@router.get("/semester-export/download")
def download_semester_export_zip(
    period_ids: list[int] = Query(..., min_length=1),
    mode: str = Query("print", pattern="^(print|screen)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """下載學期匯出 ZIP：孩子資料夾/序號_期別-專案.pdf，附缺漏說明。"""
    with zip_build_limiter.acquire("學期匯出 ZIP 正在產生中，請稍後再試"):
        zip_bytes = build_semester_export_zip(db, period_ids, mode)
    content_disposition = build_content_disposition_header("學期彙整匯出.zip")
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
