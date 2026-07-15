"""學生與名冊孩子的手動連結、拆分與合併 use cases。"""

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.roster_crud import get_any_student_or_404, get_roster_child_or_404
from database import RosterChild, Student


_WHITESPACE_PATTERN = re.compile(r"[\s　]+")


def normalize_child_name(raw_name: str) -> str:
    """姓名正規化：移除所有空白（含全形），作為名冊比對 key。"""
    return _WHITESPACE_PATTERN.sub("", raw_name or "")


def resolve_roster_child_id(db: Session, student_name: str) -> int | None:
    """唯一同名回既有 id、查無建立、同名多筆回 None 待確認。"""
    normalized_name = normalize_child_name(student_name)
    if not normalized_name:
        return None
    matched_children = db.query(RosterChild).filter(RosterChild.name == normalized_name).all()
    if len(matched_children) == 1:
        return matched_children[0].id
    if len(matched_children) > 1:
        return None
    new_child = RosterChild(name=normalized_name)
    db.add(new_child)
    db.flush()
    return new_child.id


def delete_roster_child_if_orphaned(db: Session, roster_child_id: int | None) -> None:
    """刪除已無學生連結的名冊項；呼叫端須先 flush 連結變更。"""
    if roster_child_id is None:
        return
    still_linked = db.query(Student.id).filter(Student.roster_child_id == roster_child_id).first()
    if still_linked:
        return
    orphaned_child = db.query(RosterChild).filter(RosterChild.id == roster_child_id).first()
    if orphaned_child:
        db.delete(orphaned_child)


def link_student_to_new_child(db: Session, student: Student) -> RosterChild:
    """為學生建立全新名冊項並連結。"""
    new_child = RosterChild(name=normalize_child_name(student.name) or student.name)
    db.add(new_child)
    db.flush()
    student.roster_child_id = new_child.id
    return new_child


def merge_roster_children(
    db: Session,
    source_child: RosterChild,
    target_child: RosterChild,
) -> int:
    """把 source 所有學生改連 target 並刪除 source。"""
    moved_count = (
        db.query(Student)
        .filter(Student.roster_child_id == source_child.id)
        .update({"roster_child_id": target_child.id})
    )
    db.delete(source_child)
    return moved_count


def link_student_to_roster_child(
    db: Session,
    student_id: int,
    *,
    roster_child_id: int | None,
    create_new: bool,
) -> dict:
    student = get_any_student_or_404(student_id, db)
    previous_child_id = student.roster_child_id
    if create_new:
        new_child = link_student_to_new_child(db, student)
    else:
        new_child = get_roster_child_or_404(roster_child_id, db)
        student.roster_child_id = new_child.id
    if previous_child_id != new_child.id:
        db.flush()
        delete_roster_child_if_orphaned(db, previous_child_id)
    db.commit()
    return {"ok": True, "roster_child_id": new_child.id}


def merge_roster_child_into(
    db: Session,
    child_id: int,
    target_child_id: int,
) -> dict:
    if child_id == target_child_id:
        raise HTTPException(status_code=400, detail="不能將名冊項併入自己")
    source_child = get_roster_child_or_404(child_id, db)
    target_child = get_roster_child_or_404(target_child_id, db)
    moved_count = merge_roster_children(db, source_child, target_child)
    db.commit()
    return {"ok": True, "moved": moved_count}
