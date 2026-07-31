"""園所組織管理 HTTP adapters；所有業務邏輯由 organization service 持有。"""

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from database import User, get_db
from services.organization_service import (
    auto_fill_classroom_member_album_names as auto_fill_classroom_album_names_use_case,
    auto_fill_roster_child_album_name as auto_fill_roster_album_name_use_case,
    batch_add_classroom_members as batch_add_classroom_members_use_case,
    create_campus as create_campus_use_case,
    create_classroom as create_classroom_use_case,
    create_classroom_project as create_classroom_project_use_case,
    get_my_classrooms as get_my_classrooms_use_case,
    get_organization_overview as get_organization_overview_use_case,
    replace_campus_supervisors as replace_campus_supervisors_use_case,
    replace_classroom_teachers as replace_classroom_teachers_use_case,
    update_campus as update_campus_use_case,
    update_classroom as update_classroom_use_case,
    update_classroom_member as update_classroom_member_use_case,
    update_roster_child_album_name as update_roster_child_album_name_use_case,
)
from services.organization_term_service import (
    apply_term_reclassification_plan as apply_term_reclassification_plan_use_case,
    cancel_term_reclassification_plan as cancel_term_reclassification_plan_use_case,
    create_term_reclassification_plan as create_term_reclassification_plan_use_case,
    get_term_reclassification_plan as get_term_reclassification_plan_use_case,
    list_academic_terms as list_academic_terms_use_case,
    update_term_reclassification_plan as update_term_reclassification_plan_use_case,
    validate_term_reclassification_plan as validate_term_reclassification_plan_use_case,
)
from services.student_input_policy import STUDENT_ALBUM_NAME_MAX_LENGTH


router = APIRouter(prefix="/api/organization", tags=["organization"])


class CampusCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    is_active: bool = True


class CampusUpdateBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None


class DepartmentSupervisorsInput(BaseModel):
    department: Literal["infant", "academy"]
    supervisor_ids: list[int]


class CampusSupervisorsReplaceBody(BaseModel):
    campus_supervisor_ids: list[int]
    department_supervisors: list[DepartmentSupervisorsInput]


class ExistingStudentIdentityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    student_id: int
    action: Literal["existing"]
    roster_child_id: int


class CreateNewStudentIdentityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    student_id: int
    action: Literal["create_new"]


StudentIdentityDecision = Annotated[
    ExistingStudentIdentityDecision | CreateNewStudentIdentityDecision,
    Field(discriminator="action"),
]


class ProjectClassroomAssignmentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    classroom_id: int
    source_fingerprint: str = Field(..., min_length=64, max_length=64)
    confirmed_all: Literal[True]
    seed_current_roster: bool
    student_identity_decisions: list[StudentIdentityDecision] = Field(
        ...,
        max_length=100,
    )


class ClassroomCreateBody(BaseModel):
    campus_id: int
    department: Literal["infant", "academy"]
    name: str = Field(..., min_length=1, max_length=100)
    is_active: bool = True


class ClassroomUpdateBody(BaseModel):
    campus_id: int | None = None
    department: Literal["infant", "academy"] | None = None
    name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None


class ClassRosterMemberInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    album_name: str | None = Field(
        None,
        max_length=STUDENT_ALBUM_NAME_MAX_LENGTH,
    )


class ClassRosterBatchBody(BaseModel):
    members: list[ClassRosterMemberInput] = Field(..., max_length=100)


class ClassRosterMemberUpdateBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    album_name: str | None = Field(
        None,
        max_length=STUDENT_ALBUM_NAME_MAX_LENGTH,
    )
    status: Literal["active", "ended"] | None = None
    end_reason: Literal["departed"] | None = None
    target_classroom_id: int | None = None


class RosterChildAlbumNameUpdateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    album_name: str | None = Field(
        ...,
        max_length=STUDENT_ALBUM_NAME_MAX_LENGTH,
    )


class ClassroomProjectCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    template_id: int
    work_slot_id: int
    owner_id: int | None = None


class ClassroomTeacherInput(BaseModel):
    teacher_id: int
    duty: Literal["lead", "co_teacher"]


class ClassroomTeachersReplaceBody(BaseModel):
    teachers: list[ClassroomTeacherInput]


class TermPlanCreateBody(BaseModel):
    label: str = Field(..., min_length=1, max_length=100)
    period_ids: list[int] = Field(default_factory=list)
    starts_on: date | None = None
    ends_on: date | None = None


class TermStudentPlacementInput(BaseModel):
    source_member_id: int
    outcome: Literal["classroom", "departed"]
    target_classroom_id: int | None = None


class TermClassroomTeacherTargetInput(BaseModel):
    classroom_id: int
    teachers: list[ClassroomTeacherInput]


class TermPlanUpdateBody(BaseModel):
    expected_revision: int = Field(..., ge=1)
    student_placements: list[TermStudentPlacementInput]
    classroom_teacher_targets: list[TermClassroomTeacherTargetInput]


class TermPlanApplyBody(BaseModel):
    expected_revision: int = Field(..., ge=1)


@router.get("/overview")
def get_organization_overview(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return get_organization_overview_use_case(db)


@router.get("/my-classrooms")
def get_my_classrooms(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return get_my_classrooms_use_case(db, current_user)


@router.post("/campuses", status_code=status.HTTP_201_CREATED)
def create_campus(
    body: CampusCreateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return create_campus_use_case(db, body.name, body.is_active)


@router.patch("/campuses/{campus_id}")
def update_campus(
    campus_id: int,
    body: CampusUpdateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return update_campus_use_case(db, campus_id, body.model_dump(exclude_unset=True))


@router.put("/campuses/{campus_id}/supervisors")
def replace_campus_supervisors(
    campus_id: int,
    body: CampusSupervisorsReplaceBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    department_supervisors = [row.model_dump() for row in body.department_supervisors]
    return replace_campus_supervisors_use_case(
        db, current_admin, campus_id,
        body.campus_supervisor_ids, department_supervisors,
    )


@router.post("/classrooms", status_code=status.HTTP_201_CREATED)
def create_classroom(
    body: ClassroomCreateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return create_classroom_use_case(db, **body.model_dump())


@router.patch("/classrooms/{classroom_id}")
def update_classroom(
    classroom_id: int,
    body: ClassroomUpdateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return update_classroom_use_case(db, classroom_id, body.model_dump(exclude_unset=True))


@router.put("/classrooms/{classroom_id}/teachers")
def replace_classroom_teachers(
    classroom_id: int,
    body: ClassroomTeachersReplaceBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    teachers = [teacher.model_dump() for teacher in body.teachers]
    return replace_classroom_teachers_use_case(db, current_admin, classroom_id, teachers)


@router.post(
    "/classrooms/{classroom_id}/members/batch",
    status_code=status.HTTP_201_CREATED,
)
def batch_add_classroom_members(
    classroom_id: int,
    body: ClassRosterBatchBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    members = [member.model_dump() for member in body.members]
    return batch_add_classroom_members_use_case(db, classroom_id, members)


@router.patch("/classrooms/{classroom_id}/members/{member_id}")
def update_classroom_member(
    classroom_id: int,
    member_id: int,
    body: ClassRosterMemberUpdateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    changes = body.model_dump(exclude_unset=True)
    return update_classroom_member_use_case(db, classroom_id, member_id, changes)


@router.post("/classrooms/{classroom_id}/members/album-names/auto-fill")
def auto_fill_classroom_member_album_names(
    classroom_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return auto_fill_classroom_album_names_use_case(db, classroom_id)


@router.patch("/roster-children/{roster_child_id}/album-name")
def update_roster_child_album_name(
    roster_child_id: int,
    body: RosterChildAlbumNameUpdateBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return update_roster_child_album_name_use_case(
        db,
        roster_child_id,
        body.album_name,
    )


@router.post("/roster-children/{roster_child_id}/album-name/auto-fill")
def auto_fill_roster_child_album_name(
    roster_child_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return auto_fill_roster_album_name_use_case(db, roster_child_id)


@router.post(
    "/classrooms/{classroom_id}/projects",
    status_code=status.HTTP_201_CREATED,
)
def create_classroom_project(
    classroom_id: int,
    body: ClassroomProjectCreateBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return create_classroom_project_use_case(db, current_user, classroom_id, **body.model_dump())


@router.post("/term-reclassification-plans", status_code=status.HTTP_201_CREATED)
def create_term_reclassification_plan(
    body: TermPlanCreateBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    return create_term_reclassification_plan_use_case(
        db,
        current_admin,
        body.label,
        body.period_ids,
        body.starts_on,
        body.ends_on,
    )


@router.get("/academic-terms")
def list_academic_terms(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    return list_academic_terms_use_case(db)


@router.get("/term-reclassification-plans/{plan_id}")
def get_term_reclassification_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return get_term_reclassification_plan_use_case(db, plan_id)


@router.put("/term-reclassification-plans/{plan_id}")
def update_term_reclassification_plan(
    plan_id: int,
    body: TermPlanUpdateBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    return update_term_reclassification_plan_use_case(
        db, current_admin, plan_id, body.model_dump()
    )


@router.post("/term-reclassification-plans/{plan_id}/validate")
def validate_term_reclassification_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    return validate_term_reclassification_plan_use_case(db, plan_id)


@router.post("/term-reclassification-plans/{plan_id}/apply")
def apply_term_reclassification_plan(
    plan_id: int,
    body: TermPlanApplyBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    return apply_term_reclassification_plan_use_case(
        db, current_admin, plan_id, body.expected_revision
    )


@router.post("/term-reclassification-plans/{plan_id}/cancel")
def cancel_term_reclassification_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    return cancel_term_reclassification_plan_use_case(db, current_admin, plan_id)
