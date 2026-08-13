"""正式學期報表、老師進度與學期彙整匯出路由。"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from database import User, get_db
from services.export_jobs import get_render_job_state, start_render_missing_job
from services.organization_scope_service import build_organization_supervisor_scope
from services.output_keys import build_content_disposition_header
from services.semester_export_service import (
    build_semester_export_preview,
    load_export_periods,
    open_semester_export_zip_stream,
)
from services.teacher_overview_service import (
    build_teacher_overview_workbook,
    build_teacher_progress_overview,
    list_reporting_semesters,
)


router = APIRouter(prefix="/api/roster", tags=["roster"])


class RenderMissingPayload(BaseModel):
    semester_id: int
    period_ids: list[int] = Field(min_length=1)
    roster_child_ids: list[int] | None = None


@router.get("/semesters")
def get_reporting_semesters(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    organization_scope = build_organization_supervisor_scope(db, current_user)
    return list_reporting_semesters(db, organization_scope)


@router.get("/semester-export")
def get_semester_export_preview(
    semester_id: int = Query(..., ge=1),
    period_ids: list[int] = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    organization_scope = build_organization_supervisor_scope(db, current_user)
    return build_semester_export_preview(
        db,
        semester_id,
        period_ids,
        organization_scope=organization_scope,
    )


@router.get("/teacher-progress")
def get_teacher_progress(
    semester_id: int = Query(..., ge=1),
    department: Literal["infant", "academy"] | None = None,
    campus_id: int | None = Query(None, ge=1),
    classroom_id: int | None = Query(None, ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    organization_scope = build_organization_supervisor_scope(db, current_user)
    return build_teacher_progress_overview(
        db,
        semester_id,
        organization_scope,
        department=department,
        campus_id=campus_id,
        classroom_id=classroom_id,
    )


@router.get("/teacher-overview/export")
def export_teacher_overview_excel(
    semester_id: int = Query(..., ge=1),
    department: Literal["infant", "academy"] | None = None,
    campus_id: int | None = Query(None, ge=1),
    classroom_id: int | None = Query(None, ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    organization_scope = build_organization_supervisor_scope(db, current_user)
    workbook_bytes = build_teacher_overview_workbook(
        db,
        semester_id,
        organization_scope,
        department=department,
        campus_id=campus_id,
        classroom_id=classroom_id,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": build_content_disposition_header("老師進度.xlsx")
        },
    )


@router.post("/semester-export/render-missing")
def render_missing_albums(
    payload: RenderMissingPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    load_export_periods(db, payload.semester_id, payload.period_ids)
    return start_render_missing_job(
        payload.semester_id,
        payload.period_ids,
        payload.roster_child_ids,
    )


@router.get("/semester-export/render-missing/{job_id}")
def get_render_missing_progress(
    job_id: str,
    current_user: User = Depends(require_role("admin")),
):
    job_state = get_render_job_state(job_id)
    if job_state is None:
        raise HTTPException(status_code=404, detail="找不到補渲染工作")
    return job_state


@router.get("/semester-export/download")
def download_semester_export_zip(
    semester_id: int = Query(..., ge=1),
    period_ids: list[int] = Query(..., min_length=1),
    mode: str = Query("print", pattern="^(print|screen)$"),
    sheet_layout: str = Query("spread", pattern="^(single|spread)$"),
    roster_child_ids: list[int] | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin")),
):
    zip_stream = open_semester_export_zip_stream(
        db,
        semester_id,
        period_ids,
        mode,
        sheet_layout,
        roster_child_ids,
    )
    return StreamingResponse(
        zip_stream,
        media_type="application/zip",
        headers={
            "Content-Disposition": build_content_disposition_header(
                "學期彙整匯出.zip"
            )
        },
    )
