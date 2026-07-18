"""專案目前負責人與轉交歷程 HTTP adapters。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import require_role
from database import User, get_db
from services.project_assignment_service import (
    assign_project_owner as assign_project_owner_use_case,
    list_project_assignment_history as list_project_assignment_history_use_case,
)


router = APIRouter()


class ProjectAssignmentBody(BaseModel):
    owner_id: int
    reason: str | None = Field(None, max_length=500)


@router.post("/{project_id}/assignment")
def assign_project_owner(
    project_id: int,
    body: ProjectAssignmentBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    return assign_project_owner_use_case(db, current_admin, project_id, body.owner_id, body.reason)


@router.get("/{project_id}/assignment-history")
def list_project_assignment_history(
    project_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return list_project_assignment_history_use_case(db, project_id)
