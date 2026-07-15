# 名冊與學期彙整匯出路由（admin 專用）
# 提供跨專案的孩子名冊配對（連結/合併）與學期匯出（預覽分組、ZIP 下載）

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_role
from crud.user_crud import get_visible_owner_ids
from database import User, get_db
from services.export_jobs import get_render_job_state, start_render_missing_job
from services.output_keys import build_content_disposition_header
from services.semester_export_service import (
    build_semester_export_preview,
    open_semester_export_zip_stream,
)
from services.roster_identity_service import (
    link_student_to_roster_child as link_student_to_roster_child_use_case,
    merge_roster_child_into as merge_roster_child_into_use_case,
)
from services.teacher_overview_service import (
    build_teacher_overview_workbook,
    build_teacher_progress_overview,
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
    owner_user_ids = get_visible_owner_ids(current_user, db)
    return build_semester_export_preview(db, period_ids, owner_user_ids)


@router.get("/teacher-progress")
def get_teacher_progress(
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "supervisor")),
):
    """老師進度總覽：含尚未建專案的老師與照片/文字完成度。supervisor 限管轄老師。"""
    owner_user_ids = get_visible_owner_ids(current_user, db)
    return build_teacher_progress_overview(db, period_ids, owner_user_ids)


@router.get("/teacher-overview/export")
def export_teacher_overview_excel(
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "supervisor")),
):
    """下載老師進度 Excel（摘要 + 明細）。supervisor 只含管轄老師的資料。"""
    owner_user_ids = get_visible_owner_ids(current_user, db)
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
    return link_student_to_roster_child_use_case(
        db,
        student_id,
        roster_child_id=payload.roster_child_id,
        create_new=payload.create_new,
    )


@router.post("/children/{child_id}/merge/{target_child_id}")
def merge_roster_child_into(
    child_id: int,
    target_child_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """把一個名冊項的所有學生併入另一個名冊項（改名/誤拆修正）。"""
    return merge_roster_child_into_use_case(db, child_id, target_child_id)


@router.post("/semester-export/render-missing")
def render_missing_albums(
    payload: RenderMissingPayload,
    current_user: User = Depends(require_role("admin")),
):
    """啟動補渲染背景 job（回 job_id 供輪詢）；已有 job 在跑時回 503。"""
    return start_render_missing_job(payload.period_ids, payload.roster_child_ids)


@router.get("/semester-export/render-missing/{job_id}")
def get_render_missing_progress(
    job_id: str,
    current_user: User = Depends(require_role("admin")),
):
    """查詢補渲染 job 進度（status / done / total / rendered / errors）。"""
    job_state = get_render_job_state(job_id)
    if job_state is None:
        raise HTTPException(status_code=404, detail="找不到補渲染工作")
    return job_state


@router.get("/semester-export/download")
def download_semester_export_zip(
    period_ids: list[int] = Query(..., min_length=1),
    mode: str = Query("print", pattern="^(print|screen)$"),
    roster_child_ids: list[int] | None = Query(None, description="只匯出勾選的孩子；不給代表全部"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    """下載學期匯出 ZIP（邊壓邊送）：孩子/期別_孩子.pdf，附缺漏說明。"""
    zip_stream = open_semester_export_zip_stream(db, period_ids, mode, roster_child_ids)
    content_disposition = build_content_disposition_header("學期彙整匯出.zip")
    return StreamingResponse(
        zip_stream,
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition},
    )
