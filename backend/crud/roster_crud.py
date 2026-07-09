# 名冊查詢輔助模組
# 封裝 RosterChild 與跨專案 Student 的單筆查詢，查無資料統一拋 404

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import RosterChild, Student


def get_roster_child_or_404(roster_child_id: int, db: Session) -> RosterChild:
    """查詢指定名冊孩子，若不存在則拋出 404。"""
    roster_child = db.query(RosterChild).filter(RosterChild.id == roster_child_id).first()
    if not roster_child:
        raise HTTPException(status_code=404, detail="找不到名冊項")
    return roster_child


def get_any_student_or_404(student_id: int, db: Session) -> Student:
    """跨專案查詢指定學生（名冊配對用，不限定專案），若不存在則拋出 404。"""
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    return student
