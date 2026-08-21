"""正式學期的校別／班級彙整預覽、ZIP 規劃與串流。"""

import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload, selectinload

from database import (
    Classroom,
    ClassroomMember,
    SemesterPeriod,
    ClassPeriodWorkSlot,
    Project,
    ProjectStudent,
)
from services.organization_scope_service import (
    OrganizationReadScope,
    apply_project_read_scope,
    apply_term_classroom_report_scope,
    load_reporting_semester_or_404,
    serialize_reporting_period,
    serialize_reporting_term,
)
from services.output_keys import (
    build_safe_zip_entry_path,
    get_project_output_prefix,
    make_safe_filename,
    student_pdf_key_for_mode,
)
from services.storage_factory import get_storage
from services.student_identity_anomaly import (
    classify_project_student_identity_anomalies,
)
from services.zip_stream import open_zip_stream


MERGED_PDF_LABEL = "全期合併"
MISSING_TERM_STUDENT_SNAPSHOT = "missing_term_student_snapshot"
DEPARTURE_REASONS = {"departed", "term_departed"}


def load_export_periods(
    db: Session,
    semester_id: int,
    period_ids: list[int] | None = None,
    *,
    organization_scope: OrganizationReadScope | None = None,
) -> list[SemesterPeriod]:
    """讀取學期期別；period_ids 使用既有 TemplatePeriod id。"""
    load_reporting_semester_or_404(db, semester_id, organization_scope)
    query = db.query(SemesterPeriod).filter(
        SemesterPeriod.semester_id == semester_id
    )
    if organization_scope is not None and not organization_scope.is_admin:
        scoped_department_rows = apply_term_classroom_report_scope(
            db.query(Classroom.department).filter(
                Classroom.semester_id == semester_id,
            ),
            organization_scope,
        ).distinct().all()
        visible_departments = {
            department for department, in scoped_department_rows
        }
        query = query.filter(
            SemesterPeriod.department.in_(visible_departments)
        )
    if period_ids is not None:
        requested_ids = set(period_ids)
        query = query.filter(SemesterPeriod.template_period_id.in_(requested_ids))
    periods = query.order_by(SemesterPeriod.position).all()
    if period_ids is not None:
        found_ids = {period.template_period_id for period in periods}
        missing_ids = set(period_ids) - found_ids
        if missing_ids:
            if organization_scope is not None and not organization_scope.is_admin:
                raise HTTPException(status_code=404, detail="找不到期別")
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "period_not_in_semester",
                    "period_ids": sorted(missing_ids),
                },
            )
    return periods


def load_export_projects(
    db: Session,
    semester_id: int,
    period_ids: list[int] | None = None,
    organization_scope: OrganizationReadScope | None = None,
) -> list[Project]:
    """讀取學期內已歸班且未封存的 Project，並套用 snapshot scope。"""
    query = (
        db.query(Project)
        .join(
            ClassPeriodWorkSlot,
            ClassPeriodWorkSlot.id == Project.class_period_work_slot_id,
        )
        .join(
            Classroom,
            Classroom.id == ClassPeriodWorkSlot.classroom_id,
        )
        .join(
            SemesterPeriod,
            SemesterPeriod.id == ClassPeriodWorkSlot.semester_period_id,
        )
        .options(
            joinedload(Project.students).joinedload(ProjectStudent.roster_child),
            joinedload(Project.owner),
            joinedload(Project.class_period_work_slot).joinedload(
                ClassPeriodWorkSlot.classroom
            ),
            joinedload(Project.class_period_work_slot).joinedload(
                ClassPeriodWorkSlot.semester_period
            ),
        )
        .filter(
            Classroom.semester_id == semester_id,
            Project.deleted_at.is_(None),
            Project.classroom_id.isnot(None),
        )
    )
    if period_ids is not None:
        query = query.filter(SemesterPeriod.template_period_id.in_(period_ids))
    if organization_scope is not None:
        query = apply_project_read_scope(query, organization_scope)
    return query.order_by(
        SemesterPeriod.position,
        Project.id,
    ).all()


def load_output_keys_by_project(storage, projects: list[Project]) -> dict[int, set[str]]:
    """並行列舉各 Project 輸出 key，避免 R2 逐檔 exists。"""
    def list_project_output_keys(project_id: int) -> tuple[int, set[str]]:
        return project_id, set(storage.list_keys(get_project_output_prefix(project_id)))

    if not projects:
        return {}
    project_ids = sorted({project.id for project in projects})
    with ThreadPoolExecutor(max_workers=8) as executor:
        return dict(executor.map(list_project_output_keys, project_ids))


def student_pdf_key(student: ProjectStudent, output_mode: str) -> str | None:
    if not student.output_filename:
        return None
    return student_pdf_key_for_mode(student.output_filename, output_mode)


def _student_skipped_pages(student: ProjectStudent) -> list[int]:
    try:
        pages_data = json.loads(student.pages_data_json or "[]")
    except ValueError:
        return []
    if not isinstance(pages_data, list):
        return []
    return [
        page_index + 1
        for page_index, page_data in enumerate(pages_data)
        if isinstance(page_data, dict) and page_data.get("skip")
    ]


def _load_scoped_term_classrooms(
    db: Session,
    semester_id: int,
    organization_scope: OrganizationReadScope | None,
    departments: set[str],
) -> list[Classroom]:
    query = db.query(Classroom).options(
        selectinload(Classroom.roster_members).selectinload(
            ClassroomMember.roster_child
        )
    ).filter(
        Classroom.semester_id == semester_id,
        Classroom.department.in_(departments),
    )
    if organization_scope is not None:
        query = apply_term_classroom_report_scope(query, organization_scope)
    return query.order_by(
        Classroom.campus_id,
        Classroom.name,
        Classroom.id,
    ).all()


def _serialize_entry(
    project: Project,
    student: ProjectStudent,
    existing_output_keys: set[str],
) -> dict:
    slot = project.class_period_work_slot
    semester_period = slot.semester_period
    classroom = slot.classroom
    print_pdf_key = student_pdf_key(student, "print")
    return {
        "semester_period_id": semester_period.id,
        "period_id": semester_period.template_period_id,
        "template_period_id": semester_period.template_period_id,
        "period_position": semester_period.position,
        "project_id": project.id,
        "project_name": project.name,
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "student_id": student.id,
        "student_name": student.name,
        "campus_id": project.campus_id_snapshot,
        "campus_name": project.campus_name_snapshot,
        "classroom_id": classroom.id,
        "classroom_name": project.classroom_name_snapshot,
        "department": project.department,
        "has_pdf": bool(print_pdf_key and print_pdf_key in existing_output_keys),
        "skipped_pages": _student_skipped_pages(student),
    }


def _cell_status(
    entries: list[dict],
    period_position: int,
    all_entries: list[dict],
    *,
    is_departed: bool,
) -> str:
    if len(entries) > 1:
        return "duplicate"
    if len(entries) == 1:
        return "ready" if entries[0]["has_pdf"] else "not_rendered"
    if not all_entries:
        return "no_album"
    first_position = min(entry["period_position"] for entry in all_entries)
    last_position = max(entry["period_position"] for entry in all_entries)
    if period_position < first_position:
        return "not_enrolled"
    if period_position > last_position and is_departed:
        return "departed"
    return "no_album"


def _group_summary(children: list[dict]) -> dict:
    status_counts = Counter(
        cell["status"]
        for child in children
        for cell in child["cells"]
    )
    return {
        "child_count": len(children),
        "ready_count": status_counts["ready"],
        "not_rendered_count": status_counts["not_rendered"],
        "no_album_count": status_counts["no_album"],
        "duplicate_count": status_counts["duplicate"],
        "departed_count": status_counts["departed"],
        "not_enrolled_count": status_counts["not_enrolled"],
    }


def build_semester_export_preview(
    db: Session,
    semester_id: int,
    period_ids: list[int],
    organization_scope: OrganizationReadScope | None = None,
) -> dict:
    """由後端判定孩子各期狀態，並依 term classroom snapshot 分組。"""
    term = load_reporting_semester_or_404(
        db,
        semester_id,
        organization_scope,
    )
    all_periods = load_export_periods(
        db,
        semester_id,
        organization_scope=organization_scope,
    )
    selected_periods = load_export_periods(
        db,
        semester_id,
        period_ids,
        organization_scope=organization_scope,
    )
    selected_semester_period_ids = {period.id for period in selected_periods}
    selected_departments = {period.department for period in selected_periods}
    relevant_period_ids = [
        period.template_period_id
        for period in all_periods
        if period.department in selected_departments
    ]
    classrooms = _load_scoped_term_classrooms(
        db,
        semester_id,
        organization_scope,
        selected_departments,
    )
    term_classroom_by_id = {row.id: row for row in classrooms}
    projects = load_export_projects(
        db,
        semester_id,
        relevant_period_ids,
        organization_scope=organization_scope,
    )
    output_keys_by_project = load_output_keys_by_project(get_storage(), projects)

    # 學期中轉過班的孩子在兩個班都有成員紀錄，依入班時間取最後一筆，
    # 分組才會落在他最後所在的班
    memberships = sorted(
        (
            (member, classroom)
            for classroom in classrooms
            for member in classroom.roster_members
        ),
        key=lambda row: (row[0].started_at, row[0].id),
    )
    children_by_id: dict[int, dict] = {}
    for member, classroom in memberships:
        children_by_id[member.roster_child_id] = {
            "roster_child_id": member.roster_child_id,
            "name": member.roster_child.name,
            "classroom_id": classroom.id,
            "source_membership": member,
            "entries": [],
        }

    unlinked = []
    for project in projects:
        existing_output_keys = output_keys_by_project.get(project.id, set())
        identity_anomalies = classify_project_student_identity_anomalies(project)
        for student in project.students:
            entry = _serialize_entry(project, student, existing_output_keys)
            anomaly_codes = identity_anomalies.get(student.id)
            if anomaly_codes is not None:
                if entry["semester_period_id"] in selected_semester_period_ids:
                    entry["identity_anomalies"] = list(anomaly_codes)
                    unlinked.append(entry)
                continue
            child = children_by_id.get(student.roster_child_id)
            if child is None:
                if entry["semester_period_id"] in selected_semester_period_ids:
                    entry["identity_anomalies"] = [
                        MISSING_TERM_STUDENT_SNAPSHOT
                    ]
                    unlinked.append(entry)
                continue
            child["entries"].append(entry)
    classroom_groups_by_id = {
        classroom.id: {
            "classroom_id": classroom.id,
            "campus_id": classroom.campus_id,
            "campus_name": classroom.campus.name,
            "classroom_name": classroom.name,
            "department": classroom.department,
            "children": [],
        }
        for classroom in classrooms
    }
    period_position_by_id = {
        period.id: period.position for period in all_periods
    }
    for child in children_by_id.values():
        all_entries = child.pop("entries")
        entries_by_semester_period: dict[int, list[dict]] = {}
        for entry in all_entries:
            entries_by_semester_period.setdefault(entry["semester_period_id"], []).append(entry)
        source_membership = child["source_membership"]
        is_departed = bool(
            source_membership is not None
            and source_membership.ended_at is not None
            and source_membership.end_reason in DEPARTURE_REASONS
        )
        cells = []
        for period in selected_periods:
            cell_entries = sorted(
                entries_by_semester_period.get(period.id, []),
                key=lambda entry: (entry["project_id"], entry["student_id"]),
            )
            cells.append({
                "semester_period_id": period.id,
                "period_id": period.template_period_id,
                "template_period_id": period.template_period_id,
                "status": _cell_status(
                    cell_entries,
                    period_position_by_id[period.id],
                    all_entries,
                    is_departed=is_departed,
                ),
                "entries": cell_entries,
            })

        latest_term_classroom_id = child["classroom_id"]
        if latest_term_classroom_id not in classroom_groups_by_id:
            continue
        classroom = term_classroom_by_id[latest_term_classroom_id]
        child_payload = {
            "roster_child_id": child["roster_child_id"],
            "name": child["name"],
            "latest_classroom": {
                "classroom_id": classroom.id,
                "campus_id": classroom.campus_id,
                "campus_name": classroom.campus.name,
                "classroom_name": classroom.name,
                "department": classroom.department,
            },
            "cells": cells,
        }
        classroom_groups_by_id[latest_term_classroom_id]["children"].append(
            child_payload
        )

    classroom_groups = []
    for group in classroom_groups_by_id.values():
        group["children"].sort(key=lambda child: child["name"])
        group["summary"] = _group_summary(group["children"])
        classroom_groups.append(group)
    top_summary = _group_summary([
        child
        for group in classroom_groups
        for child in group["children"]
    ])
    top_summary["classroom_count"] = len(classroom_groups)
    top_summary["identity_anomaly_count"] = len(unlinked)
    return {
        "term": serialize_reporting_term(term),
        "periods": [serialize_reporting_period(period) for period in selected_periods],
        "summary": top_summary,
        "classroom_groups": classroom_groups,
        "unlinked": sorted(
            unlinked,
            key=lambda entry: (
                entry["campus_name"] or "",
                entry["classroom_name"] or "",
                entry["student_name"],
            ),
        ),
    }


def _selected_preview_children(preview: dict, roster_child_ids: list[int] | None):
    selected_ids = set(roster_child_ids) if roster_child_ids is not None else None
    for classroom_group in preview["classroom_groups"]:
        for child in classroom_group["children"]:
            if selected_ids is None or child["roster_child_id"] in selected_ids:
                yield child


def _filter_preview_for_manifest(
    preview: dict,
    roster_child_ids: list[int] | None,
) -> dict:
    """讓勾選匯出的說明檔只描述同一批孩子。"""
    if roster_child_ids is None:
        return preview
    selected_ids = set(roster_child_ids)
    classroom_groups = []
    for classroom_group in preview["classroom_groups"]:
        children = [
            child
            for child in classroom_group["children"]
            if child["roster_child_id"] in selected_ids
        ]
        if children:
            classroom_groups.append({
                **classroom_group,
                "children": children,
            })
    return {
        **preview,
        "classroom_groups": classroom_groups,
        "unlinked": [],
    }


def _plan_semester_export_zip(
    db: Session,
    semester_id: int,
    period_ids: list[int],
    output_mode: str,
    sheet_layout: str,
    roster_child_ids: list[int] | None = None,
) -> tuple[list[dict], str]:
    preview = build_semester_export_preview(db, semester_id, period_ids)
    manifest_preview = _filter_preview_for_manifest(preview, roster_child_ids)
    projects = load_export_projects(db, semester_id, period_ids)
    students_by_id = {
        student.id: student
        for project in projects
        for student in project.students
    }
    output_keys_by_project = load_output_keys_by_project(get_storage(), projects)
    period_names = {
        period["template_period_id"]: period["name"]
        for period in preview["periods"]
    }

    child_plans = []
    missing_notes = []
    used_paths: set[str] = set()
    for child in _selected_preview_children(preview, roster_child_ids):
        child_files: list[tuple[str, str]] = []
        for cell in child["cells"]:
            if cell["status"] == "duplicate":
                project_ids = sorted({entry["project_id"] for entry in cell["entries"]})
                missing_notes.append(
                    f"{child['name']}：{period_names[cell['template_period_id']]}"
                    f" 同一期有重複相本（Project {project_ids}），未納入"
                )
                continue
            if cell["status"] == "no_album":
                missing_notes.append(
                    f"{child['name']}：{period_names[cell['template_period_id']]}"
                    " 無相本資料"
                )
                continue
            if not cell["entries"]:
                continue
            entry = cell["entries"][0]
            student = students_by_id.get(entry["student_id"])
            pdf_key = student_pdf_key(student, output_mode) if student else None
            if (
                not pdf_key
                or pdf_key not in output_keys_by_project.get(entry["project_id"], set())
            ):
                missing_notes.append(
                    f"{child['name']}：{period_names[cell['template_period_id']]}"
                    f"（{entry['campus_name']}／{entry['classroom_name']}）"
                    "尚未產生 PDF，未納入"
                )
                continue
            child_name = make_safe_filename(child["name"])
            file_name = (
                f"{make_safe_filename(period_names[cell['template_period_id']])}_"
                f"{child_name}.pdf"
            )
            latest_classroom = child["latest_classroom"]
            archive_path = build_safe_zip_entry_path(
                latest_classroom["campus_name"],
                latest_classroom["classroom_name"],
                child_name,
                file_name,
            )
            if archive_path in used_paths:
                archive_path = build_safe_zip_entry_path(
                    latest_classroom["campus_name"],
                    latest_classroom["classroom_name"],
                    f"{child_name}（{child['roster_child_id']}）",
                    file_name,
                )
            if archive_path in used_paths:
                archive_path = build_safe_zip_entry_path(
                    latest_classroom["campus_name"],
                    latest_classroom["classroom_name"],
                    f"{child_name}（{child['roster_child_id']}）",
                    f"{file_name[:-4]}_{entry['student_id']}.pdf",
                )
            used_paths.add(archive_path)
            child_files.append((archive_path, pdf_key))

        # cells 依 selected_periods 的 position 排序，合併頁序即期別順序
        merged_path = None
        if len(child_files) >= 2:
            child_dir = child_files[0][0].rsplit("/", 1)[0]
            merged_name = make_safe_filename(child["name"])
            merged_path = f"{child_dir}/{MERGED_PDF_LABEL}_{merged_name}.pdf"
            if merged_path in used_paths:
                merged_path = (
                    f"{child_dir}/{MERGED_PDF_LABEL}_{merged_name}"
                    f"（{child['roster_child_id']}）.pdf"
                )
            used_paths.add(merged_path)
        if child_files:
            child_plans.append({
                "files": child_files,
                "merged_path": merged_path,
            })

    for entry in manifest_preview["unlinked"]:
        missing_notes.append(
            f"身分異常：{entry['student_name']}"
            f"（{entry['campus_name']}／{entry['classroom_name']}／"
            f"{entry['project_name']}），未納入"
        )
    return child_plans, _build_export_manifest(
        manifest_preview,
        missing_notes,
        sheet_layout,
    )


A3_LANDSCAPE_WIDTH_PT = 1190.55
A3_LANDSCAPE_HEIGHT_PT = 841.89


def _compose_pdf_bytes(pdf_bytes_list: list[bytes], sheet_layout: str) -> bytes:
    """依版式把來源 PDF 依期別順序組成一份：spread 兩頁併一張 A3 橫式
    （奇數頁時最後一張右半留白），single 維持 A4 原頁串接。"""
    from pypdf import PdfReader, PdfWriter, Transformation

    # 單頁版式的單一來源不需重寫，直接沿用原始 bytes
    if sheet_layout == "single" and len(pdf_bytes_list) == 1:
        return pdf_bytes_list[0]

    readers = [PdfReader(BytesIO(pdf_bytes)) for pdf_bytes in pdf_bytes_list]
    source_pages = [page for reader in readers for page in reader.pages]
    writer = PdfWriter()
    if sheet_layout == "single":
        for page in source_pages:
            writer.add_page(page)
    else:
        for pair_start in range(0, len(source_pages), 2):
            a3_page = writer.add_blank_page(
                width=A3_LANDSCAPE_WIDTH_PT,
                height=A3_LANDSCAPE_HEIGHT_PT,
            )
            for slot, page in enumerate(source_pages[pair_start:pair_start + 2]):
                src_width = float(page.mediabox.width)
                src_height = float(page.mediabox.height)
                scale = min(
                    A3_LANDSCAPE_WIDTH_PT / 2 / src_width,
                    A3_LANDSCAPE_HEIGHT_PT / src_height,
                )
                offset_x = (
                    slot * A3_LANDSCAPE_WIDTH_PT / 2
                    + (A3_LANDSCAPE_WIDTH_PT / 2 - src_width * scale) / 2
                )
                offset_y = (A3_LANDSCAPE_HEIGHT_PT - src_height * scale) / 2
                a3_page.merge_transformed_page(
                    page,
                    Transformation().scale(scale).translate(offset_x, offset_y),
                )
    composed_buffer = BytesIO()
    writer.write(composed_buffer)
    return composed_buffer.getvalue()


def open_semester_export_zip_stream(
    db: Session,
    semester_id: int,
    period_ids: list[int],
    output_mode: str,
    sheet_layout: str,
    roster_child_ids: list[int] | None = None,
):
    child_plans, manifest_text = _plan_semester_export_zip(
        db,
        semester_id,
        period_ids,
        output_mode,
        sheet_layout,
        roster_child_ids,
    )
    storage = get_storage()

    def write_entries(zip_archive):
        # 每個孩子的 bytes 只從 storage 抓一次，合併時重用；峰值記憶體為單一孩子全期
        for plan in child_plans:
            merged_sources = []
            for archive_path, pdf_key in plan["files"]:
                pdf_bytes = storage.get_bytes(pdf_key)
                zip_archive.writestr(
                    archive_path,
                    _compose_pdf_bytes([pdf_bytes], sheet_layout),
                )
                # 跨期合併從原始 A4 頁重組，頁序跨期連續，不是接已併好的 A3
                if plan["merged_path"] is not None:
                    merged_sources.append(pdf_bytes)
                yield
            if plan["merged_path"] is not None:
                zip_archive.writestr(
                    plan["merged_path"],
                    _compose_pdf_bytes(merged_sources, sheet_layout),
                )
                yield
        zip_archive.writestr("匯出說明.txt", manifest_text)

    return open_zip_stream(write_entries, "學期匯出 ZIP 正在產生中，請稍後再試")


def _build_export_manifest(
    preview: dict,
    missing_notes: list[str],
    sheet_layout: str,
) -> str:
    lines = [
        "【分類方式】",
        "檔案依「校別／班級／孩子／期別_孩子.pdf」分類。",
        *(
            [
                "版式：這包所有 PDF 都是雙頁 A3 橫式（每張左右各一頁 A4），",
                "頁數為奇數時最後一張右半留白。",
            ]
            if sheet_layout == "spread"
            else ["版式：這包所有 PDF 都是單頁 A4，維持相本原頁。"]
        ),
        "同一孩子有兩期以上 PDF 時，孩子資料夾內另附「全期合併_孩子.pdf」，",
        "內容依期別順序連續排頁。",
        "校別與班級使用相本建立當下的正式快照，不使用相本名稱代替班級。",
        "",
        "【班級對照】",
    ]
    for classroom_group in preview["classroom_groups"]:
        lines.append(
            f"- {classroom_group['campus_name']}／"
            f"{classroom_group['classroom_name']}："
            f"{len(classroom_group['children'])} 位孩子"
        )

    period_names = {
        period["template_period_id"]: period["name"]
        for period in preview["periods"]
    }
    skipped_notes = [
        f"- {child['name']}：{period_names[cell['template_period_id']]}"
        f"（{entry['campus_name']}／{entry['classroom_name']}／"
        f"{entry['project_name']}）老師刪除了第 "
        f"{'、'.join(str(page) for page in entry['skipped_pages'])} 頁"
        for classroom_group in preview["classroom_groups"]
        for child in classroom_group["children"]
        for cell in child["cells"]
        for entry in cell["entries"]
        if entry["skipped_pages"]
    ]
    if skipped_notes:
        lines += ["", "【缺頁備註（老師手動刪除，非漏印）】", *skipped_notes]
    if missing_notes:
        lines += ["", "【缺漏或異常，未納入這包】"]
        lines += [f"- {note}" for note in missing_notes]
    return "\n".join(lines)
