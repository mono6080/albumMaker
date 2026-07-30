"""把學生從同一個班級期別的一本相本搬到另一本，照片與個人文字一起帶走。

為什麼需要這支：相本成員原本是完全凍結的期別快照（見
docs/specs/organization-roster-management-v1.md 的 Project Student snapshot），
凍結防的是「歷史被後來的異動改寫」「孩子身分被接錯」「期末匯出重複或漏算」。
同一個工作格的兩本之間搬動不踩到這三件事——孩子還在同班同期、身分沒變、匯出
仍只出現一次——所以 DB trigger 只在這個窄口放行 project_id。

搬動的東西：
    Student row（pages_data_json 裡的個人文字與跳過設定跟著 row 走）
    照片檔案（storage key 帶著相本編號，必須實體搬移並改寫頁面資料裡的 path）
    舊相本的該生輸出（PDF／頁圖／render 指紋一律清掉，換本後必須重算）

檔案順序刻意是「先複製 → commit → 再刪原檔」：commit 失敗時只留下新位置的多餘
檔案，DB 沒動、舊 key 仍有效；刪原檔失敗則只是留下垃圾，兩種都不會變成破圖。
"""

from __future__ import annotations

import json
import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404
from database import ClassRosterMember, Student
from services.organization_lock import organization_acl_lock
from services.project_access_service import assert_project_writable
from services.storage_factory import get_storage
from services.student_render_service import clear_student_render_outputs
from services.template_sync_locks import lock_project_content_writes

logger = logging.getLogger(__name__)


def _assert_transferable_pair(source, target) -> None:
    if source.id == target.id:
        raise HTTPException(
            status_code=422,
            detail={"code": "same_project", "message": "來源與目標是同一本相本"},
        )
    if source.classroom_id is None or target.classroom_id is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "project_not_class_backed",
                "message": "只有已歸班的相本可以互相搬移學生",
            },
        )
    if (
        source.class_period_work_slot_id is None
        or source.class_period_work_slot_id != target.class_period_work_slot_id
    ):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "different_work_slot",
                "message": "只能搬到同一個班級期別的另一本相本",
            },
        )
    if source.template_id != target.template_id:
        # 版面不同就沒有「同一個位置」可言：照片格與文字框 id 對不上，
        # 搬過去的內容會落在錯的地方或直接消失。
        raise HTTPException(
            status_code=422,
            detail={
                "code": "different_template",
                "message": "兩本相本使用不同模板，搬過去版面會對不上",
            },
        )
    for project in (source, target):
        if project.completed_at is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "project_completed",
                    "message": "已完成的相本要先退回才能搬動學生",
                },
            )


def _relocate_student_photos(
    storage,
    student: Student,
    source_project_id: int,
    target_project_id: int,
) -> list[str]:
    """複製照片到新命名空間並改寫頁面資料裡的 path，回傳待清除的舊 key。

    只置換 key 裡的相本編號、保留原檔名——檔名尾端帶著內容 hash，重算會對不上；
    交給 get_photo_key() 重組則會再疊一次 `p{page}_slot{slot}_` 前綴。
    """
    try:
        pages_data = json.loads(student.pages_data_json or "[]")
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "corrupted_pages_data",
                "message": f"學生 {student.name} 的頁面資料損壞，請先修復再搬移",
            },
        )
    if not isinstance(pages_data, list):
        return []

    source_prefix = f"projects/proj{source_project_id}/photos/student{student.id}/"
    target_prefix = f"projects/proj{target_project_id}/photos/student{student.id}/"
    stale_keys: list[str] = []
    for page in pages_data:
        if not isinstance(page, dict):
            continue
        photos = page.get("photos")
        if not isinstance(photos, dict):
            continue
        for slot_id, record in photos.items():
            old_key = record if isinstance(record, str) else (record or {}).get("path")
            # 不在來源命名空間的是 legacy key（例如未歸班時期留下的），
            # 動它反而可能指到別人的檔案，保持原樣讓舊路徑繼續有效。
            if not old_key or not old_key.startswith(source_prefix):
                continue
            new_key = target_prefix + old_key[len(source_prefix):]
            if storage.exists(old_key):
                storage.copy(old_key, new_key)
                stale_keys.append(old_key)
            if isinstance(record, str):
                photos[slot_id] = new_key
            else:
                photos[slot_id] = {**record, "path": new_key}
    student.pages_data_json = json.dumps(pages_data, ensure_ascii=False)
    return stale_keys


def transfer_students_between_projects(
    db: Session,
    current_user,
    *,
    source_project_id: int,
    target_project_id: int,
    student_ids: list[int],
) -> dict:
    """把指定學生從來源相本搬到同一個班級期別的另一本相本。"""
    if not student_ids:
        raise HTTPException(
            status_code=422,
            detail={"code": "no_students", "message": "請至少選擇一位學生"},
        )
    requested_ids = list(dict.fromkeys(student_ids))

    source = get_project_or_404(source_project_id, db)
    assert_project_writable(source, current_user, db)
    target = get_project_or_404(target_project_id, db)
    assert_project_writable(target, current_user, db)

    storage = get_storage()
    stale_photo_keys: list[str] = []
    # 鎖順序固定 organization → sorted project locks，與其他寫入路徑一致
    with organization_acl_lock, lock_project_content_writes(
        sorted({source_project_id, target_project_id})
    ):
        db.rollback()
        db.expire_all()
        source = get_project_or_404(source_project_id, db)
        assert_project_writable(source, current_user, db)
        target = get_project_or_404(target_project_id, db)
        assert_project_writable(target, current_user, db)
        _assert_transferable_pair(source, target)

        student_by_id = {student.id: student for student in source.students}
        missing = [sid for sid in requested_ids if sid not in student_by_id]
        if missing:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "student_not_in_source",
                    "student_ids": missing,
                    "message": "選到的學生不在來源相本裡",
                },
            )
        if len(requested_ids) == len(source.students):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "source_would_be_empty",
                    "message": "不能把整本的學生都搬走；請改用刪除相本",
                },
            )

        # 孩子必須還在這個班的目前名單，否則搬完會變成「名單上沒有、相本裡卻有」
        child_ids = {
            student_by_id[sid].roster_child_id
            for sid in requested_ids
            if student_by_id[sid].roster_child_id is not None
        }
        if child_ids:
            active_child_ids = {
                child_id
                for (child_id,) in db.query(ClassRosterMember.roster_child_id).filter(
                    ClassRosterMember.classroom_id == source.classroom_id,
                    ClassRosterMember.roster_child_id.in_(child_ids),
                    ClassRosterMember.ended_at.is_(None),
                )
            }
            departed = sorted(child_ids - active_child_ids)
            if departed:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "child_not_in_current_roster",
                        "roster_child_ids": departed,
                        "message": "有孩子已不在班級目前名單，無法搬動",
                    },
                )

        next_order = max(
            (student.order_index or 0 for student in target.students),
            default=-1,
        ) + 1
        for index, student_id in enumerate(requested_ids):
            student = student_by_id[student_id]
            stale_photo_keys.extend(
                _relocate_student_photos(storage, student, source.id, target.id)
            )
            # 換本之後舊輸出一定過期：整個學生輸出 namespace（PDF／頁圖／指紋）清掉
            clear_student_render_outputs(
                storage, source.id, student.id, student.output_filename
            )
            student.project_id = target.id
            student.order_index = next_order + index
            student.output_filename = None
            # 個別完成狀態跟著清除：換本等於這本的內容還沒被確認過
            student.completed_at = None

        db.flush()
        transferred_count = len(requested_ids)
        source_remaining = len(source.students) - transferred_count
        target_total = len(target.students) + transferred_count
        db.commit()

    # commit 之後才刪原檔：中途失敗只會留下垃圾，不會讓 DB 指到不存在的檔案
    for old_key in stale_photo_keys:
        try:
            storage.delete(old_key)
        except Exception:
            logger.exception("搬移學生後清除舊照片失敗 key=%s", old_key)

    return {
        "source_project_id": source_project_id,
        "target_project_id": target_project_id,
        "transferred_student_ids": requested_ids,
        "moved_photo_count": len(stale_photo_keys),
        "source_student_count": source_remaining,
        "target_student_count": target_total,
    }
