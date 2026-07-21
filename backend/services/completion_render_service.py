# 完成觸發的背景渲染、啟動收斂掃描與下載前補渲
# 三層防線:
# 1. 事件觸發(即時):標記完成 / 手動全班完成 / 改名清輸出後,背景執行緒預先渲染。
#    fire-and-forget,重啟即消失、失敗只記 log。
# 2. 啟動收斂(自癒):server 啟動後背景掃描全部有效完成的學生,指紋補渲 —
#    收斂事件觸發漏掉的過期輸出(渲染管線版本更新、重啟中斷、歷史資料)。
# 3. 下載前補渲(保證):下載端點以內容指紋做最後保證,指紋未變秒跳過。
# 任何角色下載到的一律是最新內容,常態下下載當下不必等渲染。

import logging
import os
import threading

from database import Project, SessionLocal, Student
from services.output_keys import get_student_render_state_key
from services.request_limiter import album_render_limiter
from services.storage_factory import get_storage
# 新鮮度檢查刻意住在本檔而非 student_render_service:該檔在 _RENDER_PIPELINE_FILES
# 指紋清單內,任何修改(即使非像素邏輯)都會讓全站輸出過期、觸發整批重渲。
# 這裡引用其私有 helper 重組同一套 skip 判斷,不動指紋來源檔。
from services.student_render_service import (
    _album_render_hash,
    _capture_student_render_input,
    _student_render_outputs_complete,
    render_and_save_student_album,
)

logger = logging.getLogger(__name__)


def _student_render_outputs_fresh(project_id: int, student_id: int, db) -> bool:
    """輕量新鮮度檢查(只讀、不取渲染槽):指紋一致且全部承諾輸出存在。

    與 render_and_save_student_album 的 dirty-skip 判斷同源;過期/缺檔回 False,
    由呼叫端取槽補渲。
    """
    render_input = _capture_student_render_input(project_id, student_id, db)
    page_layouts = render_input["page_layouts"]
    student_pages_data = render_input["student_pages_data"]
    storage = get_storage()

    try:
        previous_hash = (
            storage.get_bytes(get_student_render_state_key(project_id, student_id))
            .decode("utf-8")
            .strip()
        )
    except FileNotFoundError:
        return False
    render_hash = _album_render_hash(
        page_layouts,
        render_input["student_name"],
        student_pages_data,
        render_input["album_name"],
    )
    if previous_hash != render_hash:
        return False

    data_map = {page.get("page_index"): page for page in student_pages_data}
    page_count = sum(
        1
        for page_index in range(len(page_layouts))
        if not data_map.get(page_index, {}).get("skip")
    )
    return _student_render_outputs_complete(
        storage,
        project_id=project_id,
        student_id=student_id,
        page_count=page_count,
    )


def ensure_student_render_fresh(db, project: Project, student: Student) -> None:
    """下載前保證輸出與目前內容一致;系統渲染(不套編輯 ACL)。

    快路:輸出已發布且指紋新鮮時只讀不取槽直接放行 — 背景渲染(啟動收斂、
    完成觸發)進行中時,新鮮內容的下載不排渲染佇列。過期才取槽補渲。
    """
    if student.output_filename and _student_render_outputs_fresh(
        project.id, student.id, db
    ):
        return
    with album_render_limiter.acquire_blocking():
        render_and_save_student_album(project, student, project.id, db)


def ensure_project_renders_fresh(db, project: Project) -> None:
    """全班 ZIP 串流前逐位保證最新;任一位補渲失敗即中止,不交舊檔。"""
    for student in list(project.students):
        ensure_student_render_fresh(db, project, student)


def _render_students_in_background(project_id: int, student_ids: list[int]) -> dict:
    """逐位以指紋補渲;回傳 {rendered, skipped, failed} 統計供收斂掃描彙總。"""
    stats = {"rendered": 0, "skipped": 0, "failed": 0}
    db = SessionLocal()
    try:
        for student_id in student_ids:
            project = db.get(Project, project_id)
            student = db.get(Student, student_id)
            if project is None or student is None or student.project_id != project_id:
                continue
            try:
                with album_render_limiter.acquire_blocking():
                    result = render_and_save_student_album(project, student, project_id, db)
                stats["skipped" if result.get("skipped") else "rendered"] += 1
            except Exception as render_error:
                stats["failed"] += 1
                db.rollback()
                logger.warning(
                    "完成背景渲染失敗(下載時會再補渲) project_id=%s student_id=%s: %s",
                    project_id,
                    student_id,
                    render_error,
                )
    finally:
        db.close()
    return stats


def queue_background_student_renders(project_id: int, student_ids) -> None:
    """排入背景渲染;渲染槽逐位取用,不整批佔住。呼叫端須經模組屬性引用以利測試替換。"""
    ids = list(student_ids)
    if not ids:
        return
    threading.Thread(
        target=_render_students_in_background,
        args=(project_id, ids),
        name=f"completion-render-p{project_id}",
        daemon=True,
    ).start()


def reconcile_completed_renders() -> dict:
    """掃描全部未封存專案的有效完成學生,逐位指紋補渲;回傳彙總統計。

    已 fresh 的學生只花指紋比對(毫秒級);真過期才渲染,走渲染槽與互動請求交錯。
    """
    db = SessionLocal()
    try:
        project_student_ids = [
            (project.id, student_ids)
            for project in (
                db.query(Project)
                .filter(Project.deleted_at.is_(None))
                .order_by(Project.id)
                .all()
            )
            if (student_ids := [
                student.id
                for student in project.students
                if project.completed_at is not None or student.completed_at is not None
            ])
        ]
    finally:
        db.close()

    totals = {"checked": 0, "rendered": 0, "skipped": 0, "failed": 0}
    for project_id, student_ids in project_student_ids:
        stats = _render_students_in_background(project_id, student_ids)
        totals["checked"] += len(student_ids)
        for key in ("rendered", "skipped", "failed"):
            totals[key] += stats[key]
    return totals


def start_render_reconciliation_thread() -> None:
    """啟動後背景跑一輪收斂掃描(可用 RENDER_RECONCILE_ON_STARTUP=0 停用,測試預設關)。"""
    if os.environ.get("RENDER_RECONCILE_ON_STARTUP", "1") != "1":
        return

    def run() -> None:
        logger.info("啟動補渲收斂掃描開始")
        try:
            totals = reconcile_completed_renders()
        except Exception:
            logger.exception("啟動補渲收斂掃描中斷;下載前補渲仍會兜底")
            return
        logger.info(
            "啟動補渲收斂掃描完成 checked=%s rendered=%s skipped=%s failed=%s",
            totals["checked"],
            totals["rendered"],
            totals["skipped"],
            totals["failed"],
        )

    threading.Thread(target=run, name="render-reconcile", daemon=True).start()
