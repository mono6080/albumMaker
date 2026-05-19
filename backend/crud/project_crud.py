# 專案與學生 CRUD 輔助模組
# 封裝對 Project / Student 的常用資料庫查詢，
# 並在查無資料時統一拋出 HTTP 404

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Project, Student


def get_project_or_404(project_id: int, db: Session, *, include_archived: bool = False) -> Project:
    """查詢指定專案，若不存在則拋出 404。預設排除已封存專案。"""
    query = db.query(Project).filter(Project.id == project_id)
    if not include_archived:
        query = query.filter(Project.deleted_at.is_(None))
    project = query.first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def get_student_or_404(student_id: int, project_id: int, db: Session) -> Student:
    """查詢指定學生，若不存在或不屬於該專案則拋出 404。"""
    student = db.query(Student).filter(
        Student.id == student_id,
        Student.project_id == project_id
    ).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    return student
