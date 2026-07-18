"""學生姓名與專案名單資源上限的唯一真相來源。"""

from fastapi import HTTPException


STUDENT_NAME_MAX_LENGTH = 100
STUDENT_ALBUM_NAME_MAX_LENGTH = 100
STUDENT_BATCH_MAX_SIZE = 100
PROJECT_STUDENT_MAX_COUNT = 100


def normalize_student_name(raw_name: str) -> str:
    """去除姓名首尾空白，並驗證可持久化長度。"""
    student_name = raw_name.strip()
    if len(student_name) > STUDENT_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "student_name_too_long",
                "message": f"學生姓名不可超過 {STUDENT_NAME_MAX_LENGTH} 個字",
                "max_length": STUDENT_NAME_MAX_LENGTH,
            },
        )
    return student_name


def normalize_student_album_name(raw_name: str | None) -> str | None:
    """正規化相本稱呼；空白值代表清除並回退名冊姓名。"""
    if raw_name is None:
        return None
    album_name = raw_name.strip()
    if len(album_name) > STUDENT_ALBUM_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "student_album_name_too_long",
                "message": f"相本稱呼不可超過 {STUDENT_ALBUM_NAME_MAX_LENGTH} 個字",
                "max_length": STUDENT_ALBUM_NAME_MAX_LENGTH,
            },
        )
    return album_name or None


def validate_student_batch_size(item_count: int) -> None:
    """限制單次名單操作的輸入筆數。"""
    if item_count > STUDENT_BATCH_MAX_SIZE:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "student_batch_too_large",
                "message": f"單次最多處理 {STUDENT_BATCH_MAX_SIZE} 位學生",
                "max_items": STUDENT_BATCH_MAX_SIZE,
            },
        )


def assert_project_student_capacity(
    current_student_count: int,
    new_student_count: int,
) -> None:
    """新增前確認專案總學生數不會超出上限；純 skip 操作仍可執行。"""
    if (
        new_student_count > 0
        and current_student_count + new_student_count > PROJECT_STUDENT_MAX_COUNT
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "project_student_limit_exceeded",
                "message": f"單一專案最多 {PROJECT_STUDENT_MAX_COUNT} 位學生",
                "max_students": PROJECT_STUDENT_MAX_COUNT,
                "current_students": current_student_count,
                "requested_new_students": new_student_count,
            },
        )
