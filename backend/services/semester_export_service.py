# 學期彙整匯出服務
# 負責期別／專案載入、分組預覽、ZIP 規劃、manifest 與串流。

import json
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session, joinedload

from database import Project, RosterChild, Student, TemplatePeriod
from services.output_keys import (
    get_project_output_prefix,
    make_safe_filename,
    student_pdf_key_for_mode,
)
from services.roster_identity_service import normalize_child_name
from services.storage_factory import get_storage
from services.zip_stream import open_zip_stream


# ── 學期彙整匯出 ───────────────────────────────────────────────────────────────

def load_export_periods(db: Session, period_ids: list[int]) -> list[TemplatePeriod]:
    """讀取匯出範圍內的期別，依建立時間排序（即學期內的期別先後）。"""
    return (
        db.query(TemplatePeriod)
        .filter(TemplatePeriod.id.in_(period_ids))
        .order_by(TemplatePeriod.created_at)
        .all()
    )


def load_export_projects(
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


def load_output_keys_by_project(storage, projects: list[Project]) -> dict[int, set[str]]:
    """並行列舉各專案的輸出目錄 key 集合（R2 上逐專案序列列舉仍有數秒延遲）。

    boto3 client 是 thread-safe，LocalStorageAdapter 只讀檔案系統，皆可並行。
    """
    def list_project_output_keys(project_id) -> tuple:
        return project_id, set(storage.list_keys(get_project_output_prefix(project_id)))

    if not projects:
        return {}
    project_ids = [project.id for project in projects]
    with ThreadPoolExecutor(max_workers=8) as executor:
        return dict(executor.map(list_project_output_keys, project_ids))


def student_pdf_key(student: Student, output_mode: str) -> str | None:
    """回傳學生指定畫質的 PDF storage key；尚未渲染回 None。"""
    if not student.output_filename:
        return None
    return student_pdf_key_for_mode(student.output_filename, output_mode)


def _student_skipped_pages(student: Student) -> list[int]:
    """回傳老師手動略過（刪除）的頁碼清單（1 起算）；資料異常時視為無略過。"""
    try:
        pages_data = json.loads(student.pages_data_json or "[]")
    except ValueError:
        return []
    return [
        page_index + 1
        for page_index, page_data in enumerate(pages_data)
        if isinstance(page_data, dict) and page_data.get("skip")
    ]


def build_semester_export_preview(
    db: Session, period_ids: list[int], owner_user_ids: list[int] | None = None
) -> dict:
    """組出學期匯出預覽：依名冊孩子分組的各期狀態 + 待確認學生清單。

    owner_user_ids 給定時只納入這些使用者的專案（主管唯讀檢視）。
    """
    periods = load_export_periods(db, period_ids)
    projects = load_export_projects(db, period_ids, owner_user_ids)
    storage = get_storage()

    children_by_id: dict[int, dict] = {}
    unlinked_students = []
    # 批次存在性檢查：並行列舉輸出目錄；逐檔 exists 在 R2 上會慢到 timeout
    output_keys_by_project = load_output_keys_by_project(storage, projects)
    for project in projects:
        existing_output_keys = output_keys_by_project[project.id]
        for student in project.students:
            pdf_key = student_pdf_key(student, "print")
            entry = {
                "period_id": project.template_period_id,
                "project_id": project.id,
                "project_name": project.name,
                "owner_id": project.owner_id,
                "owner_name": project.owner.display_name if project.owner else None,
                "student_id": student.id,
                "student_name": student.name,
                "has_pdf": bool(pdf_key and pdf_key in existing_output_keys),
                # 老師手動刪除（略過）的頁碼，供介面與匯出說明標註
                "skipped_pages": _student_skipped_pages(student),
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


def _plan_semester_export_zip(
    db: Session,
    period_ids: list[int],
    output_mode: str,
    roster_child_ids: list[int] | None = None,
) -> tuple[list[tuple[str, str]], str]:
    """規劃 ZIP 內容：回傳（[(壓縮檔內路徑, storage key)], 匯出說明文字）。

    所有 DB 查詢與 storage 列舉都在此完成，串流階段只逐檔讀 bytes —
    避免 StreamingResponse 送出期間相依的 DB session 已被回收。
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
    zip_projects = load_export_projects(db, period_ids)
    # 批次存在性檢查（screen/print key 都在同一目錄下）
    output_keys_by_project = load_output_keys_by_project(storage, zip_projects)
    for project in zip_projects:
        for student in project.students:
            students_by_id[student.id] = student

    zip_entries: list[tuple[str, str]] = []
    missing_notes = []
    used_folder_names: set[str] = set()
    for group in preview["children"]:
        child_name = make_safe_filename(group["name"])
        # 資料夾＝孩子姓名；同名不同人以（最新班級）區分，仍撞名才加流水號
        folder_name = child_name
        if folder_name in used_folder_names:
            folder_name = f"{child_name}（{make_safe_filename(group['latest_project_name'])}）"
        suffix_number = 2
        while folder_name in used_folder_names:
            folder_name = f"{child_name}（{make_safe_filename(group['latest_project_name'])}）{suffix_number}"
            suffix_number += 1
        used_folder_names.add(folder_name)

        used_file_names: set[str] = set()
        sorted_entries = sorted(
            group["entries"], key=lambda entry: period_order.get(entry["period_id"], 99)
        )
        for entry in sorted_entries:
            student = students_by_id.get(entry["student_id"])
            pdf_key = student_pdf_key(student, output_mode) if student else None
            if not pdf_key or pdf_key not in output_keys_by_project.get(entry["project_id"], set()):
                missing_notes.append(
                    f"{group['name']}：{period_names.get(entry['period_id'], '?')}"
                    f"（{entry['project_name']}）尚未產生 PDF，未納入"
                )
                continue
            # 檔名＝期別_孩子；同期有多個專案（轉班等）才附專案名區分
            period_label = make_safe_filename(period_names.get(entry["period_id"], "期別"))
            file_name = f"{period_label}_{child_name}.pdf"
            if file_name in used_file_names:
                file_name = f"{period_label}_{child_name}_{make_safe_filename(entry['project_name'])}.pdf"
            if file_name in used_file_names:
                file_name = f"{file_name[:-4]}_{entry['student_id']}.pdf"
            used_file_names.add(file_name)
            zip_entries.append((f"{folder_name}/{file_name}", pdf_key))

    for entry in preview["unlinked"]:
        missing_notes.append(
            f"待確認：{entry['student_name']}（{entry['project_name']}）"
            f"未完成名冊配對，未納入"
        )
    return zip_entries, _build_export_manifest(preview, missing_notes)


def open_semester_export_zip_stream(
    db: Session,
    period_ids: list[int],
    output_mode: str,
    roster_child_ids: list[int] | None = None,
):
    """學期匯出 ZIP 串流：先佔 zip 併發槽（滿載回 503），回傳逐段 chunk 產生器。

    邊壓邊送取代整包 BytesIO：峰值記憶體從整包 ZIP 降為單一 PDF，
    下載也會立即開始而不是等整包組完。產生器結束（含中斷）時釋放併發槽。
    """
    zip_entries, manifest_text = _plan_semester_export_zip(
        db, period_ids, output_mode, roster_child_ids
    )
    storage = get_storage()

    def write_entries(zip_archive):
        for archive_path, pdf_key in zip_entries:
            zip_archive.writestr(archive_path, storage.get_bytes(pdf_key))
            yield
        zip_archive.writestr("匯出說明.txt", manifest_text)

    return open_zip_stream(write_entries, "學期匯出 ZIP 正在產生中，請稍後再試")


def _build_export_manifest(preview: dict, missing_notes: list[str]) -> str:
    """組出匯出說明：分類規則、班級對照（依最新期別）、缺頁備註與缺漏清單。"""
    lines = [
        "【分類方式】",
        "每個孩子一個資料夾，檔名為「期別_孩子姓名」。",
        "孩子的班級以「所選範圍內最新期別的專案」為準，對照如下。",
        "",
        "【班級對照】",
    ]
    sorted_children = sorted(
        preview["children"], key=lambda group: (group["latest_project_name"], group["name"])
    )
    for group in sorted_children:
        owner_label = (
            f"（老師：{group['latest_project_owner_name']}）"
            if group.get("latest_project_owner_name") else ""
        )
        lines.append(f"- {group['name']}：{group['latest_project_name']}{owner_label}")

    # 缺頁備註：老師手動刪除的頁面，提醒統整成冊時這些不是漏印
    period_names = {period["id"]: period["name"] for period in preview["periods"]}
    skipped_notes = [
        f"- {group['name']}：{period_names.get(entry['period_id'], '?')}"
        f"（{entry['project_name']}）老師刪除了第 "
        f"{'、'.join(str(page) for page in entry['skipped_pages'])} 頁"
        for group in sorted_children
        for entry in group["entries"]
        if entry.get("skipped_pages")
    ]
    if skipped_notes:
        lines += ["", "【缺頁備註（老師手動刪除的頁面，非漏印）】"]
        lines += skipped_notes

    if missing_notes:
        lines += ["", "【缺漏，未納入這包】"]
        lines += [f"- {note}" for note in missing_notes]
    return "\n".join(lines)
