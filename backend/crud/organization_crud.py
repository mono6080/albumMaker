"""園所組織單筆查詢 helpers。"""

from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload

from database import (
    Campus,
    Classroom,
    ClassRosterMember,
    TermClassroomPlan,
    TermReclassificationPlan,
)


def get_campus_or_404(campus_id: int, db: Session) -> Campus:
    campus = db.query(Campus).filter(Campus.id == campus_id).first()
    if not campus:
        raise HTTPException(status_code=404, detail="找不到分校")
    return campus


def get_classroom_or_404(classroom_id: int, db: Session) -> Classroom:
    classroom = db.query(Classroom).filter(Classroom.id == classroom_id).first()
    if not classroom:
        raise HTTPException(status_code=404, detail="找不到班級")
    return classroom


def get_class_roster_member_or_404(
    member_id: int,
    classroom_id: int,
    db: Session,
) -> ClassRosterMember:
    member = db.query(ClassRosterMember).filter(
        ClassRosterMember.id == member_id,
        ClassRosterMember.classroom_id == classroom_id,
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="找不到班級名單成員")
    return member


def get_term_reclassification_plan_or_404(
    plan_id: int,
    db: Session,
) -> TermReclassificationPlan:
    plan = (
        db.query(TermReclassificationPlan)
        .options(
            selectinload(TermReclassificationPlan.student_placements),
            selectinload(TermReclassificationPlan.classroom_plans).selectinload(
                TermClassroomPlan.teacher_targets
            ),
        )
        .filter(TermReclassificationPlan.id == plan_id)
        .first()
    )
    if not plan:
        raise HTTPException(status_code=404, detail="找不到新學期編班草稿")
    return plan
