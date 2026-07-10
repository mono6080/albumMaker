# 名冊服務
# 園所層級孩子名冊（RosterChild）的姓名正規化、自動連結，
# 以及學期彙整匯出的分組預覽、缺漏補渲染與 ZIP 打包

import io
import logging
import re
import zipfile

from sqlalchemy.orm import Session, joinedload

from database import Project, RosterChild, Student, TemplatePeriod
from services.project_service import (
    get_project_output_prefix,
    get_template_page_layouts,
    make_safe_filename,
    render_and_save_student_album,
)
from services.storage import get_storage

logger = logging.getLogger(__name__)

# 涵蓋半形與全形空白，正規化時一律移除
_WHITESPACE_PATTERN = re.compile(r"[\s　]+")


def normalize_child_name(raw_name: str) -> str:
    """姓名正規化：移除所有空白（含全形），作為名冊比對 key。"""
    return _WHITESPACE_PATTERN.sub("", raw_name or "")


def resolve_roster_child_id(db: Session, student_name: str) -> int | None:
    """依姓名解析名冊項 id：唯一命中回傳既有項、查無自動建立、同名多筆回 None 待確認。

    回傳 None 代表歧義（admin 先前手動拆過同名孩子），由學期匯出頁的待確認流程處理。
    新建的 RosterChild 只 flush 不 commit，交由呼叫端的交易一併提交。
    """
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
    """名冊項沒有任何學生連結時刪除（改名/換連結/刪學生後的孤兒清理）。

    呼叫端須先 flush 讓連結變更生效；孤兒留著會污染同名歧義判斷與合併選單。
    """
    if roster_child_id is None:
        return
    still_linked = db.query(Student.id).filter(Student.roster_child_id == roster_child_id).first()
    if still_linked:
        return
    orphaned_child = db.query(RosterChild).filter(RosterChild.id == roster_child_id).first()
    if orphaned_child:
        db.delete(orphaned_child)


def link_student_to_new_child(db: Session, student: Student) -> RosterChild:
    """為學生建立全新名冊項並連結（同名不同人的拆分情境）。"""
    new_child = RosterChild(name=normalize_child_name(student.name) or student.name)
    db.add(new_child)
    db.flush()
    student.roster_child_id = new_child.id
    return new_child


def merge_roster_children(db: Session, source_child: RosterChild, target_child: RosterChild) -> int:
    """把 source 名冊項的所有學生改連到 target 並刪除 source，回傳搬移的學生數。

    用於改名/誤拆造成同一個孩子有兩個名冊項的情境。
    """
    moved_count = (
        db.query(Student)
        .filter(Student.roster_child_id == source_child.id)
        .update({"roster_child_id": target_child.id})
    )
    db.delete(source_child)
    return moved_count


# ── 學期彙整匯出 ───────────────────────────────────────────────────────────────

def _load_export_periods(db: Session, period_ids: list[int]) -> list[TemplatePeriod]:
    """讀取匯出範圍內的期別，依建立時間排序（即學期內的期別先後）。"""
    return (
        db.query(TemplatePeriod)
        .filter(TemplatePeriod.id.in_(period_ids))
        .order_by(TemplatePeriod.created_at)
        .all()
    )


def _load_export_projects(
    db: Session, period_ids: list[int], owner_user_ids: list[int] | None = None
) -> list[Project]:
    """讀取匯出範圍內的專案（排除封存），含學生、名冊連結與帶班老師。

    owner_user_ids 給定時只回傳這些使用者擁有的專案（主管檢視自己管轄老師用）。
    """
    query = (
        db.query(Project)
        .options(
            joinedload(Project.students).joinedload(Student.roster_child),
            joinedload(Project.owner),
        )
        .filter(Project.template_period_id.in_(period_ids))
        .filter(Project.deleted_at.is_(None))
    )
    if owner_user_ids is not None:
        query = query.filter(Project.owner_id.in_(owner_user_ids))
    return query.all()


def _student_pdf_key(student: Student, output_mode: str) -> str | None:
    """回傳學生指定畫質的 PDF storage key；尚未渲染回 None。"""
    if not student.output_filename:
        return None
    base_key = student.output_filename
    return base_key[:-4] + "_screen.pdf" if output_mode == "screen" else base_key


def build_semester_export_preview(
    db: Session, period_ids: list[int], owner_user_ids: list[int] | None = None
) -> dict:
    """組出學期匯出預覽：依名冊孩子分組的各期狀態 + 待確認學生清單。

    owner_user_ids 給定時只納入這些使用者的專案（主管唯讀檢視）。
    """
    periods = _load_export_periods(db, period_ids)
    projects = _load_export_projects(db, period_ids, owner_user_ids)
    storage = get_storage()

    children_by_id: dict[int, dict] = {}
    unlinked_students = []
    for project in projects:
        # 每專案列一次輸出目錄做批次存在性檢查；逐檔 exists 在 R2 上會慢到 timeout
        existing_output_keys = set(storage.list_keys(get_project_output_prefix(project.id)))
        for student in project.students:
            pdf_key = _student_pdf_key(student, "print")
            entry = {
                "period_id": project.template_period_id,
                "project_id": project.id,
                "project_name": project.name,
                "owner_name": project.owner.display_name if project.owner else None,
                "student_id": student.id,
                "student_name": student.name,
                "has_pdf": bool(pdf_key and pdf_key in existing_output_keys),
            }
            if student.roster_child_id is None:
                unlinked_students.append(entry)
                continue
            group = children_by_id.setdefault(student.roster_child_id, {
                "roster_child_id": student.roster_child_id,
                "name": student.roster_child.name,
                "entries": [],
            })
            group["entries"].append(entry)

    # 每個孩子的「班級」＝所選範圍內最新期別的專案（孩子最近待的班）
    period_order = {period.id: index for index, period in enumerate(periods)}
    for group in children_by_id.values():
        latest_entry = max(
            group["entries"], key=lambda entry: period_order.get(entry["period_id"], -1)
        )
        group["latest_project_id"] = latest_entry["project_id"]
        group["latest_project_name"] = latest_entry["project_name"]
        group["latest_project_owner_name"] = latest_entry["owner_name"]

    children = sorted(
        children_by_id.values(),
        key=lambda group: (group["latest_project_name"], group["name"]),
    )
    # 待確認學生的可選名冊項：同正規化姓名的既有名冊項
    for entry in unlinked_students:
        normalized_name = normalize_child_name(entry["student_name"])
        candidates = db.query(RosterChild).filter(RosterChild.name == normalized_name).all()
        entry["candidates"] = [
            {"roster_child_id": candidate.id, "name": candidate.name}
            for candidate in candidates
        ]

    return {
        "periods": [
            {"id": period.id, "name": period.name, "department": period.department}
            for period in periods
        ],
        "children": children,
        "unlinked": unlinked_students,
    }


def render_missing_semester_albums(
    db: Session,
    period_ids: list[int],
    roster_child_ids: list[int] | None = None,
) -> dict:
    """補渲染：找出範圍內缺列印 PDF 的學生相冊並逐一渲染，回傳成功數與失敗清單。

    roster_child_ids 給定時只處理勾選的孩子（None 代表全部，含未配對學生）。
    """
    storage = get_storage()
    selected_ids = set(roster_child_ids) if roster_child_ids is not None else None
    rendered_count = 0
    render_errors = []
    for project in _load_export_projects(db, period_ids):
        # 批次列舉輸出目錄取代逐檔 exists（R2 上逐檔會慢到 timeout）
        existing_output_keys = set(storage.list_keys(get_project_output_prefix(project.id)))
        shared_page_layouts = None
        for student in project.students:
            if selected_ids is not None and student.roster_child_id not in selected_ids:
                continue
            pdf_key = _student_pdf_key(student, "print")
            if pdf_key and pdf_key in existing_output_keys:
                continue
            # 版型逐專案讀一次，避免每個學生重複查詢
            if shared_page_layouts is None:
                shared_page_layouts = get_template_page_layouts(project)
            try:
                render_and_save_student_album(project, student, project.id, db, shared_page_layouts)
                rendered_count += 1
            except Exception as render_error:
                db.rollback()
                render_errors.append({"student": student.name, "project": project.name, "error": "渲染失敗"})
                logger.error("補渲染失敗 project_id=%s student=%s: %s", project.id, student.name, render_error)
    return {"rendered": rendered_count, "errors": render_errors}


def build_semester_export_zip(
    db: Session,
    period_ids: list[int],
    output_mode: str,
    roster_child_ids: list[int] | None = None,
) -> bytes:
    """打包學期匯出 ZIP：班級（最新期別專案）/孩子/序號_期別-專案.pdf，附匯出說明列出缺漏。

    roster_child_ids 給定時只匯出勾選的孩子（None 代表全部）。
    """
    preview = build_semester_export_preview(db, period_ids)
    if roster_child_ids is not None:
        selected_ids = set(roster_child_ids)
        preview["children"] = [
            group for group in preview["children"]
            if group["roster_child_id"] in selected_ids
        ]
    period_order = {period["id"]: index for index, period in enumerate(preview["periods"])}
    period_names = {period["id"]: period["name"] for period in preview["periods"]}
    storage = get_storage()

    students_by_id = {}
    # 每專案列一次輸出目錄做批次存在性檢查（screen/print key 都在同一目錄下）
    output_keys_by_project: dict[int, set[str]] = {}
    for project in _load_export_projects(db, period_ids):
        output_keys_by_project[project.id] = set(
            storage.list_keys(get_project_output_prefix(project.id))
        )
        for student in project.students:
            students_by_id[student.id] = student

    missing_notes = []
    used_folder_names: set[str] = set()
    output_buffer = io.BytesIO()
    with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_DEFLATED) as zip_archive:
        for group in preview["children"]:
            class_folder = make_safe_filename(group["latest_project_name"])
            folder_name = f"{class_folder}/{make_safe_filename(group['name'])}"
            if folder_name in used_folder_names:
                # 同班同名不同人（admin 拆分過）：附 id 區分資料夾
                folder_name = f"{folder_name}_{group['roster_child_id']}"
            used_folder_names.add(folder_name)

            used_file_names: set[str] = set()
            sorted_entries = sorted(
                group["entries"], key=lambda entry: period_order.get(entry["period_id"], 99)
            )
            for entry in sorted_entries:
                student = students_by_id.get(entry["student_id"])
                pdf_key = _student_pdf_key(student, output_mode) if student else None
                if not pdf_key or pdf_key not in output_keys_by_project.get(entry["project_id"], set()):
                    missing_notes.append(
                        f"{group['name']}：{period_names.get(entry['period_id'], '?')}"
                        f"（{entry['project_name']}）尚未渲染，未納入"
                    )
                    continue
                sequence = period_order.get(entry["period_id"], 98) + 1
                file_name = (
                    f"{sequence:02d}_{make_safe_filename(period_names.get(entry['period_id'], '期別'))}"
                    f"-{make_safe_filename(entry['project_name'])}.pdf"
                )
                if file_name in used_file_names:
                    file_name = f"{file_name[:-4]}_{entry['student_id']}.pdf"
                used_file_names.add(file_name)
                zip_archive.writestr(f"{folder_name}/{file_name}", storage.get_bytes(pdf_key))

        for entry in preview["unlinked"]:
            missing_notes.append(
                f"待確認：{entry['student_name']}（{entry['project_name']}）"
                f"未完成名冊配對，未納入"
            )
        if missing_notes:
            zip_archive.writestr("匯出說明.txt", "\n".join(missing_notes))

    output_buffer.seek(0)
    return output_buffer.read()
