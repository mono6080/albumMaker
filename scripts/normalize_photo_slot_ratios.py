"""
將現有模板照片格批次轉換為標準比例（3:4 直式或 4:3 橫式）。

轉換規則：
- 已是「整數精確」標準比例（4*w == 3*h 或 3*w == 4*h）的照片格不動。
- 其餘照片格 snap 到最接近的標準比例（以比例的對數距離判斷遠近），
  輸出為 3u x 4u 或 4u x 3u 的整數倍尺寸，比例數學上精確。
- 以「面積不變、中心點不變」轉換，把視覺位移平均分攤到寬高兩邊。
- 轉換後的內容框 clamp 回畫布範圍（794 x 1123）。

安全機制：
- 更新前將原始 layout_json 備份到 template_page_layout_migration_backups
  （migration_name = normalize_photo_slot_ratios_2026_07），同頁重跑不會覆蓋備份。
- --dry-run 只列出將變更的照片格，不寫入。

用法：
    python scripts/normalize_photo_slot_ratios.py --dry-run
    python scripts/normalize_photo_slot_ratios.py
    python scripts/normalize_photo_slot_ratios.py --db /path/to/album_maker.db
"""

import argparse
import json
import math
import sqlite3
from pathlib import Path

DATABASE_PATH = Path(__file__).resolve().parent.parent / "backend" / "album_maker.db"
MIGRATION_NAME = "normalize_photo_slot_ratios_2026_07"

CANVAS_REAL_WIDTH = 794
CANVAS_REAL_HEIGHT = 1123

PORTRAIT_RATIO = 3 / 4
LANDSCAPE_RATIO = 4 / 3


def normalize_slot(slot):
    """就地轉換單一照片格；回傳 (是否變更, 變更說明)。"""
    old_width = slot.get("width") or 0
    old_height = slot.get("height") or 0
    if old_width <= 0 or old_height <= 0:
        return False, None

    # 已是整數精確的標準比例則不動
    if old_width * 4 == old_height * 3 or old_width * 3 == old_height * 4:
        return False, None

    ratio = old_width / old_height
    portrait_distance = abs(math.log(ratio / PORTRAIT_RATIO))
    landscape_distance = abs(math.log(ratio / LANDSCAPE_RATIO))
    target_ratio = PORTRAIT_RATIO if portrait_distance < landscape_distance else LANDSCAPE_RATIO

    # 面積不變、中心點不變；以 3u x 4u / 4u x 3u 整數倍輸出，比例精確
    area = old_width * old_height
    unit = max(15, round(math.sqrt(area / 12)))
    if target_ratio == PORTRAIT_RATIO:
        new_width, new_height = unit * 3, unit * 4
    else:
        new_width, new_height = unit * 4, unit * 3

    center_x = (slot.get("x") or 0) + old_width / 2
    center_y = (slot.get("y") or 0) + old_height / 2
    new_x = round(center_x - new_width / 2)
    new_y = round(center_y - new_height / 2)

    # clamp 回畫布範圍
    new_x = max(0, min(new_x, CANVAS_REAL_WIDTH - new_width))
    new_y = max(0, min(new_y, CANVAS_REAL_HEIGHT - new_height))

    description = (
        f"slot {slot.get('id')}: {old_width}x{old_height} "
        f"({old_width / old_height:.3f}) -> {new_width}x{new_height} "
        f"({'4:3 橫式' if target_ratio > 1 else '3:4 直式'})"
    )
    slot.update({"x": new_x, "y": new_y, "width": new_width, "height": new_height})
    return True, description


def main():
    parser = argparse.ArgumentParser(description="批次轉換照片格為標準比例")
    parser.add_argument("--dry-run", action="store_true", help="只列出將變更的照片格，不寫入")
    parser.add_argument("--db", type=Path, default=DATABASE_PATH, help="目標資料庫路徑（預設為本機 backend/album_maker.db）")
    args = parser.parse_args()

    if not args.db.exists():
        raise SystemExit(f"找不到資料庫：{args.db}")
    connection = sqlite3.connect(args.db)
    pages = connection.execute(
        """SELECT p.id, t.name, p.page_number, p.layout_json
           FROM template_pages p JOIN templates t ON t.id = p.template_id
           ORDER BY t.id, p.page_number"""
    ).fetchall()

    changed_pages = 0
    changed_slots = 0
    for page_id, template_name, page_number, raw_layout in pages:
        if not raw_layout:
            continue
        layout = json.loads(raw_layout)
        page_changes = []
        for slot in layout.get("photo_slots") or []:
            changed, description = normalize_slot(slot)
            if changed:
                page_changes.append(description)

        if not page_changes:
            continue
        changed_pages += 1
        changed_slots += len(page_changes)
        print(f"[{template_name}] 第 {page_number + 1} 頁：")
        for description in page_changes:
            print(f"  {description}")

        if args.dry_run:
            continue

        # 備份原始 layout 後寫入（同頁重跑不覆蓋既有備份）
        connection.execute(
            """INSERT OR IGNORE INTO template_page_layout_migration_backups
               (migration_name, template_page_id, layout_json) VALUES (?, ?, ?)""",
            (MIGRATION_NAME, page_id, raw_layout),
        )
        connection.execute(
            "UPDATE template_pages SET layout_json = ? WHERE id = ?",
            (json.dumps(layout, ensure_ascii=False), page_id),
        )

    if not args.dry_run:
        connection.commit()
    mode_label = "dry-run，未寫入" if args.dry_run else "已寫入並備份"
    print(f"\n共 {changed_pages} 頁、{changed_slots} 個照片格需轉換（{mode_label}）")


if __name__ == "__main__":
    main()
