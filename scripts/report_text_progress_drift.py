"""量測「文字進度前後端失真」實際影響到幾位學生（唯讀，不寫入任何東西）。

## 失真是什麼

前後端都實作了同一條規則：「舊版前端可能把模板預設文字存成學生覆寫；有全班文字時
讓它回到繼承」。但判斷「全班有沒有覆寫」的條件不同：

- 後端 `label_texts._drop_legacy_template_default_overrides`：只要該 label 在全班
  `label_texts` 裡**有 entry** 就算（包含只設了對齊、沒設文字的 entry）。
- 前端 `utils/textProgress.js` 的 `effectiveProgressText`：必須是**文字覆寫**才算；
  只設對齊的 entry 回 undefined，不算。

因此「全班只設了對齊沒設文字」＋「學生殘留舊版模板預設覆寫」時，後端判為未填、
前端判為已填。班級總覽會顯示完成並引導老師按「標記完成」，後端
`project_lifecycle_service._assert_student_content_filled` 卻回 409
`student_content_incomplete`，而畫面指不出是哪一格。

## 怎麼算出「前端的數字」

不移植 JS：把全班 `label_texts` 裡「只有對齊、沒有文字」的 entry 濾掉之後，再呼叫
同一支後端 `summarize_student_progress`，得到的文字計數就等於前端的算法——
因為 (a) 濾掉後 legacy-drop 的 `label_id in project_label_texts` 條件不成立，
與前端一致；(b) 文字計數只看 `get_label_entry_text`，不看對齊。
`--self-check` 會用規格裡那個最小案例驗證這個等價關係。

## 用法

    python scripts/report_text_progress_drift.py --database backend/album_maker.db
    python scripts/report_text_progress_drift.py --database ... --self-check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _load_backend():
    from services.label_texts import get_label_entry_text  # noqa: PLC0415
    from services.student_progress import summarize_student_progress  # noqa: PLC0415
    from services.student_render_service import (  # noqa: PLC0415
        get_template_page_layouts,
    )

    return (
        get_label_entry_text,
        summarize_student_progress,
        get_template_page_layouts,
    )


def _strip_align_only_entries(project_label_texts: dict, get_text) -> dict:
    """濾掉「只有對齊、沒有文字」的全班 entry，得到前端眼中的全班覆寫集合。"""
    stripped: dict = {}
    for page_key, page_entries in (project_label_texts or {}).items():
        if not isinstance(page_entries, dict):
            continue
        kept = {
            label_id: entry
            for label_id, entry in page_entries.items()
            if get_text(entry) is not None
        }
        stripped[page_key] = kept
    return stripped


def _self_check(summarize, get_text) -> None:
    """用規格裡的最小案例確認「濾掉 align-only entry」等價於前端算法。"""
    page_layouts = [{"text_labels": [{"id": 1, "text": "模板預設"}]}]
    pages_data = [{"page_index": 0, "label_texts": {"1": "模板預設"}}]
    project_label_texts = {"0": {"1": {"text_align": "left"}}}

    backend = summarize(pages_data, page_layouts, project_label_texts)
    frontend = summarize(
        pages_data,
        page_layouts,
        _strip_align_only_entries(project_label_texts, get_text),
    )
    assert backend[2:] == (0, 1), f"後端基準案例應為 0/1，實得 {backend[2:]}"
    assert frontend[2:] == (1, 1), f"前端等價案例應為 1/1，實得 {frontend[2:]}"
    print("self-check 通過：後端 0/1、前端 1/1，與規格案例一致\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="SQLite 檔路徑（唯讀開啟）")
    parser.add_argument("--self-check", action="store_true", help="先跑最小案例等價驗證")
    parser.add_argument("--limit", type=int, default=30, help="最多列出幾位受影響學生")
    args = parser.parse_args()

    database_path = Path(args.database).resolve()
    if not database_path.is_file():
        print(f"找不到資料庫：{database_path}", file=sys.stderr)
        return 2

    import os  # noqa: PLC0415

    # database.py 在 import 時讀 DATABASE_URL，所以必須在載入 backend 之前設好
    os.environ["DATABASE_URL"] = f"sqlite:///{database_path.as_posix()}"

    (
        get_label_entry_text,
        summarize_student_progress,
        get_template_page_layouts,
    ) = _load_backend()

    if args.self_check:
        _self_check(summarize_student_progress, get_label_entry_text)

    from database import Project, SessionLocal  # noqa: PLC0415

    session = SessionLocal()
    try:
        projects = (
            session.query(Project)
            .filter(Project.deleted_at.is_(None))
            .order_by(Project.id)
            .all()
        )
        affected_rows = []
        divergent_label_count = 0
        scanned_students = 0

        for project in projects:
            if project.template is None:
                continue
            page_layouts = get_template_page_layouts(project)
            project_label_texts = json.loads(project.label_texts_json or "{}")
            frontend_project_label_texts = _strip_align_only_entries(
                project_label_texts, get_label_entry_text
            )
            if project_label_texts == frontend_project_label_texts:
                # 這本沒有任何 align-only 全班 entry，兩邊不可能分歧
                continue

            for student in project.students:
                scanned_students += 1
                pages_data = json.loads(student.pages_data_json or "[]")
                backend = summarize_student_progress(
                    pages_data, page_layouts, project_label_texts
                )
                frontend = summarize_student_progress(
                    pages_data, page_layouts, frontend_project_label_texts
                )
                if backend[2:] == frontend[2:]:
                    continue
                gap = frontend[2] - backend[2]
                divergent_label_count += gap
                affected_rows.append(
                    (
                        project.id,
                        project.name,
                        student.id,
                        student.name,
                        f"{backend[2]}/{backend[3]}",
                        f"{frontend[2]}/{frontend[3]}",
                        gap,
                        student.completed_at is not None,
                    )
                )

        print(f"掃描：{len(projects)} 本相本、{scanned_students} 位學生"
              f"（只掃有 align-only 全班 entry 的相本）")
        print(f"受影響學生：{len(affected_rows)} 位")
        print(f"分歧格數合計：{divergent_label_count}")
        if not affected_rows:
            print("\n沒有任何學生受影響——這條失真目前沒有實際觸發。")
            return 0

        affected_projects = {row[0] for row in affected_rows}
        already_completed = sum(1 for row in affected_rows if row[7])
        print(f"涉及相本：{len(affected_projects)} 本")
        print(f"其中已標記個別完成的：{already_completed} 位"
              f"（這些是已經繞過或當時尚未觸發的）")
        print(f"\n前 {min(args.limit, len(affected_rows))} 筆：")
        print(f"{'相本':>6} {'學生':>6}  {'後端':>7} {'前端':>7} {'差':>3}  名稱")
        for row in affected_rows[: args.limit]:
            project_id, project_name, student_id, student_name, back, front, gap, _ = row
            print(f"{project_id:>6} {student_id:>6}  {back:>7} {front:>7} {gap:>3}  "
                  f"{project_name} / {student_name}")
        if len(affected_rows) > args.limit:
            print(f"…另有 {len(affected_rows) - args.limit} 筆未列出（--limit 調整）")
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
