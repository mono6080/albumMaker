"""把本機匯入好的模板搬到另一個資料庫（例如正式站）。**預設 dry-run，`--apply` 才寫入。**

為什麼需要它：`import_office_template.py` 需要 Windows + Word COM，而且素材是直接寫本機
檔案系統、不走 StorageAdapter；正式站在容器裡、儲存是 R2，跑不動那支腳本。實務上模板
一直是「本機匯入好再騰過去」，但那條路徑沒有進版控、沒有測試、也沒有 dry-run。

這支負責資料庫那一半：把 `templates` 與 `template_pages` 的列插進目標資料庫，重新配 id
並改寫素材路徑；素材那一半交給既有的 `scripts/migrate_uploads_to_r2.py`（本腳本會把檔案
複製到 `--staging-dir`，用**新的** template id 命名，直接餵給那支上傳）。

三件不能省的事：

1. **期別要用（部門，名稱）對，不能用 id**：兩邊的 `template_periods.id` 不保證一樣。
2. **template id 要重配**：目標資料庫的 id 序列跟來源無關，照抄會撞主鍵或蓋到別的模板。
3. **layout_json 裡的素材路徑要跟著改**：路徑有三處（`template_pages.background_filename`
   欄位、`layout_json.background_filename`、`layout_json.stickers[].path`），漏掉任何一處，
   畫面上就是「模板在、圖是空的」——而且渲染 API 可能還是好的，不會馬上發現。

用法：

    python scripts/transfer_template.py --source-db backend/album_maker.db \\
        --target-db /tmp/prod_copy.db --template-id 26 --template-id 27 \\
        --source-uploads backend/uploads --staging-dir .tmp/template_transfer
    # 確認輸出無誤後加 --apply
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sqlite3
import sys

ASSET_PATH_KEYS = ("background_filename",)


def open_ro(path: pathlib.Path) -> sqlite3.Connection:
    if not path.is_file():
        sys.exit(f"找不到資料庫：{path}")
    # 只複製 .db 而漏掉 -wal 是很容易犯的錯：SQLite 在 WAL 模式下最近的寫入還沒
    # checkpoint 進主檔，複製過去的來源會少掉剛匯入的模板。症狀是「來源沒有
    # template id=N」——2026-08-04 上線當天就這樣白跑一次。
    wal = path.with_name(path.name + "-wal")
    if wal.is_file() and wal.stat().st_size > 0:
        sys.exit(
            chr(10).join([
                f"來源旁邊有未 checkpoint 的 WAL（{wal.name}，{wal.stat().st_size} bytes）。",
                "直接讀會漏掉最近的寫入。請先產生 checkpoint 過的副本再搬：",
                "    python -c \"import sqlite3,sys; s=sqlite3.connect(sys.argv[1]);"
                " d=sqlite3.connect(sys.argv[2]); s.backup(d)\" <來源> <乾淨副本>",
            ])
        )
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def rewrite_paths(value: object, old_id: int, new_id: int) -> object:
    """把 layout_json 裡所有 `templates/tmpl{old}/` 換成新的 template id。

    只換目錄那一段，檔名原樣保留——檔名裡的 `page{id}` 是來源的 page id，改了就要連
    實際檔案一起改名，徒增出錯機會；那段只是 key 的一部分，不會被解析。
    """
    old, new = f"templates/tmpl{old_id}/", f"templates/tmpl{new_id}/"
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [rewrite_paths(item, old_id, new_id) for item in value]
    if isinstance(value, dict):
        return {key: rewrite_paths(item, old_id, new_id) for key, item in value.items()}
    return value


def resolve_target_period(target: sqlite3.Connection, department: str, name: str) -> int | None:
    row = target.execute(
        "select id from template_periods where department = ? and name = ?",
        (department, name),
    ).fetchone()
    return int(row["id"]) if row else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-db", type=pathlib.Path, required=True)
    parser.add_argument("--target-db", type=pathlib.Path, required=True)
    parser.add_argument("--template-id", type=int, action="append", required=True,
                        help="來源資料庫的 template id，可重複給")
    parser.add_argument("--source-uploads", type=pathlib.Path,
                        default=pathlib.Path("backend/uploads"))
    parser.add_argument("--staging-dir", type=pathlib.Path,
                        default=pathlib.Path(".tmp/template_transfer"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if args.source_db.resolve() == args.target_db.resolve():
        sys.exit("來源與目標是同一個資料庫")

    source = open_ro(args.source_db)
    target = sqlite3.connect(args.target_db)
    target.row_factory = sqlite3.Row

    next_id = (target.execute("select coalesce(max(id), 0) from templates").fetchone()[0]) + 1
    plans: list[dict] = []
    blocked = 0

    for template_id in args.template_id:
        row = source.execute(
            """
            select t.id, t.name, t.period_id, t.revision, t.created_at,
                   p.department, p.name period_name
              from templates t join template_periods p on p.id = t.period_id
             where t.id = ?
            """,
            (template_id,),
        ).fetchone()
        if row is None:
            print(f"[跳過] 來源沒有 template id={template_id}")
            blocked += 1
            continue

        target_period_id = resolve_target_period(target, row["department"], row["period_name"])
        if target_period_id is None:
            print(f"[擋下] {row['name']}：目標沒有期別"
                  f"（{row['period_name']}／{row['department']}），請先建立")
            blocked += 1
            continue

        clash = target.execute(
            "select id from templates where period_id = ? and name = ?",
            (target_period_id, row["name"]),
        ).fetchone()
        if clash is not None:
            print(f"[擋下] {row['name']}：目標的同期別已經有同名模板"
                  f"（id={clash['id']}），不重複搬")
            blocked += 1
            continue

        pages = source.execute(
            "select page_number, background_filename, layout_json"
            "  from template_pages where template_id = ? order by page_number",
            (template_id,),
        ).fetchall()
        if not pages:
            print(f"[擋下] {row['name']}：來源沒有任何頁面")
            blocked += 1
            continue

        new_id = next_id
        next_id += 1
        asset_dir = args.source_uploads / "templates" / f"tmpl{template_id}"
        assets = sorted(p for p in asset_dir.rglob("*") if p.is_file()) if asset_dir.is_dir() else []

        plans.append({
            "source_id": template_id,
            "new_id": new_id,
            "name": row["name"],
            "period": f"{row['period_name']}／{row['department']}",
            "target_period_id": target_period_id,
            "revision": row["revision"],
            "pages": pages,
            "asset_dir": asset_dir,
            "assets": assets,
        })
        print(f"[可搬] {row['name']}")
        print(f"        期別 {row['period_name']}／{row['department']}"
              f"（目標 period_id={target_period_id}）")
        print(f"        template id {template_id} → {new_id}，{len(pages)} 頁，素材 {len(assets)} 檔")
        if not assets:
            print("        ！找不到素材目錄，搬過去會是沒有圖的模板")

    print()
    print(f"可搬 {len(plans)}／擋下 {blocked}")
    if not args.apply:
        print("（dry-run，未寫入。確認無誤後加 --apply）")
        return 0 if not blocked else 1
    if not plans:
        print("沒有可搬的模板，未寫入。")
        return 1

    args.staging_dir.mkdir(parents=True, exist_ok=True)
    try:
        for plan in plans:
            target.execute(
                "insert into templates (id, name, created_at, period_id, revision)"
                " values (?, ?, CURRENT_TIMESTAMP, ?, ?)",
                (plan["new_id"], plan["name"], plan["target_period_id"], plan["revision"]),
            )
            for page in plan["pages"]:
                layout = json.loads(page["layout_json"])
                layout = rewrite_paths(layout, plan["source_id"], plan["new_id"])
                background = page["background_filename"]
                if background:
                    background = str(rewrite_paths(background, plan["source_id"], plan["new_id"]))
                target.execute(
                    "insert into template_pages (template_id, page_number, background_filename, layout_json)"
                    " values (?, ?, ?, ?)",
                    (plan["new_id"], page["page_number"], background,
                     json.dumps(layout, ensure_ascii=False)),
                )
            dest_root = args.staging_dir / "templates" / f"tmpl{plan['new_id']}"
            for asset in plan["assets"]:
                dest = dest_root / asset.relative_to(plan["asset_dir"])
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(asset, dest)
        target.commit()
    except Exception:
        target.rollback()
        raise

    print()
    for plan in plans:
        print(f"已搬 {plan['name']} → template id={plan['new_id']}，"
              f"素材複製到 {args.staging_dir}/templates/tmpl{plan['new_id']}")
    print()
    print("素材還沒上傳。接著跑：")
    print(f"    python scripts/migrate_uploads_to_r2.py --uploads-dir {args.staging_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
