"""「學生穩定身分異常」的唯一判準。

異常指的是 `ProjectStudent` 與園所名冊 `Student` 的連結壞掉，因此那位學生無法出現在
學期彙整裡。這條規則是「學期彙整少了一個孩子沒人發現」的唯一防線
（見 [academic-term-reporting-v1](../../docs/specs/academic-term-reporting-v1.md)）。

兩個消費者需要不同形狀，所以這裡同時提供：

- `classify_project_student_identity_anomalies(project)`：逐位判斷，供匯出與補渲染
  決定跳過誰、說明欄要顯示什麼代碼。
- `count_assigned_identity_anomalies(db)`：全域筆數，供 admin 園所設定的紅字警示。

**兩者必須永遠一致**。分歧會產生「總覽說沒事、匯出靜靜少人」或反過來，
而且兩種都不會報錯。等價性由 `tests/test_student_identity_anomaly.py` 釘住。

不屬於這裡的：同一孩子出現在同一格的**多本**相本。那是正式支援的「一格多本」，
判準與處理都不同，見 `teacher_overview_service.duplicate_roster_child_ids`
與匯出的 duplicate cell。
"""

from collections import Counter

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.orm import Session, aliased

from database import Project, ProjectStudent, Student


MISSING_ROSTER_CHILD = "missing_roster_child"
INVALID_ROSTER_CHILD = "invalid_roster_child"
DUPLICATE_PROJECT_ROSTER_CHILD = "duplicate_project_roster_child"


def classify_project_student_identity_anomalies(
    project: Project,
) -> dict[int, tuple[str, ...]]:
    """列出同一相本內不可用於學期匯出的學生身分異常。"""
    child_id_counts = Counter(
        student.roster_child_id
        for student in project.students
        if student.roster_child_id is not None
    )
    anomalies_by_student_id: dict[int, tuple[str, ...]] = {}
    for student in project.students:
        anomaly_codes = []
        if student.roster_child_id is None:
            anomaly_codes.append(MISSING_ROSTER_CHILD)
        elif student.roster_child is None:
            anomaly_codes.append(INVALID_ROSTER_CHILD)
        if (
            student.roster_child_id is not None
            and child_id_counts[student.roster_child_id] > 1
        ):
            anomaly_codes.append(DUPLICATE_PROJECT_ROSTER_CHILD)
        if anomaly_codes:
            anomalies_by_student_id[student.id] = tuple(anomaly_codes)
    return anomalies_by_student_id


def count_assigned_identity_anomalies(db: Session) -> int:
    """已歸班且未刪除的相本裡，身分異常的學生總數。

    scope 與逐位版不同是刻意的：這是 admin 的全域健康度，逐位版由呼叫端決定 scope
    （匯出只看某個學期）。**判準必須相同**，只有 scope 可以不同。
    """
    sibling = aliased(ProjectStudent)
    shares_roster_child_with_sibling = (
        select(1)
        .where(
            sibling.project_id == ProjectStudent.project_id,
            sibling.id != ProjectStudent.id,
            sibling.roster_child_id == ProjectStudent.roster_child_id,
        )
        .exists()
    )
    return db.query(func.count(distinct(ProjectStudent.id))).select_from(
        ProjectStudent
    ).join(
        Project, Project.id == ProjectStudent.project_id
    ).outerjoin(
        Student, Student.id == ProjectStudent.roster_child_id
    ).filter(
        Project.classroom_id.isnot(None),
        Project.deleted_at.is_(None),
        or_(
            # 沒連結，或連結指向已不存在的名冊項
            ProjectStudent.roster_child_id.is_(None),
            Student.id.is_(None),
            # 同一本裡同一位名冊孩子被收錄兩次
            and_(
                ProjectStudent.roster_child_id.isnot(None),
                shares_roster_child_with_sibling,
            ),
        ),
    ).scalar()
