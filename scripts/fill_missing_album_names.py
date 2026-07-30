"""替沒有相本稱呼、但仍會顯示在相本上的孩子補稱呼。

用系統既有的安全推導（`suggest_automatic_album_name` ＋ organization_service 的
碰撞檢查），不自己另寫規則：它只處理 2~3 字純漢字姓名、複姓不碰，候選若跟任何
在籍孩子或既有已歸班相本撞名就保持空白等人工確認。

處理範圍只有兩種孩子——「目前在籍」與「已離園但仍被已歸班相本引用」。
已離園且沒有相本的不動，因為稱呼對他們沒有任何作用。

不覆蓋任何既有稱呼，所以可重複執行。

用法：
    python scripts/fill_missing_album_names.py
    python scripts/fill_missing_album_names.py --apply
    python scripts/fill_missing_album_names.py --db /app/db/album_maker.db --apply
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
DEFAULT_DB_PATH = BACKEND_DIR / "album_maker.db"
# 容器內 backend/ 的內容被攤平到 /app，開發樹則在 repo/backend；兩邊都要能 import
IMPORT_ROOT = BACKEND_DIR if (BACKEND_DIR / "database.py").is_file() else ROOT_DIR


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    # database.py 的預設連線是相對路徑，在 repo 根目錄執行會連到別的檔案
    # （甚至建出一個空的），所以一律明確指定
    os.environ["DATABASE_URL"] = f"sqlite:///{args.db.as_posix()}"
    sys.path.insert(0, str(IMPORT_ROOT))

    from database import SessionLocal  # noqa: E402  必須在設好 DATABASE_URL 之後
    from services.organization_service import (  # noqa: E402
        auto_fill_classroom_member_album_names,
        auto_fill_roster_child_album_name,
    )
    from sqlalchemy import text  # noqa: E402

    db = SessionLocal()
    try:
        targets = db.execute(text("""
            select ch.id, ch.name,
                (select count(*) from class_roster_members m
                   where m.roster_child_id = ch.id and m.ended_at is null) active_m,
                (select classroom_id from class_roster_members m
                   where m.roster_child_id = ch.id and m.ended_at is null limit 1) classroom_id,
                (select count(*) from students s join projects p on p.id = s.project_id
                   where s.roster_child_id = ch.id and p.deleted_at is null
                     and p.classroom_id is not null) n_album
            from roster_children ch
            where ch.album_name is null or ch.album_name = ''
        """)).mappings().all()

        in_class = [t for t in targets if t["active_m"]]
        departed_with_album = [
            t for t in targets if not t["active_m"] and t["n_album"]
        ]
        classroom_ids = sorted({t["classroom_id"] for t in in_class if t["classroom_id"]})

        print(f"在籍待補 {len(in_class)} 位（{len(classroom_ids)} 個班級）；"
              f"已離園但仍被相本引用 {len(departed_with_album)} 位")
        for item in in_class + departed_with_album:
            print(f"  「{item['name']}」 出現在 {item['n_album']} 本已歸班相本")

        if not args.apply:
            print("\n（dry-run，未寫入。加 --apply 才會執行）")
            return

        updated = unresolved = 0
        for classroom_id in classroom_ids:
            result = auto_fill_classroom_member_album_names(db, classroom_id)
            updated += result.get("updated", 0)
            unresolved += result.get("unresolved", 0)
            print(f"  班級 {classroom_id}：補上 {result.get('updated')}、"
                  f"留空 {result.get('unresolved')}")
        for item in departed_with_album:
            result = auto_fill_roster_child_album_name(db, item["id"])
            updated += result.get("updated", 0)
            unresolved += result.get("unresolved", 0)
            print(f"  名冊 {item['id']}「{item['name']}」：補上 {result.get('updated')}、"
                  f"留空 {result.get('unresolved')}")
        print(f"\n合計補上 {updated} 位；仍留空 {unresolved} 位"
              f"{'（候選會撞名，需人工指定）' if unresolved else ''}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
