"""把已建立模板某一頁裡的幾個貼圖，換成單一乾淨素材（例如統一 logo 版本）。

沿用 import_office_template.py 匯入後常見的手動步驟：dry-run/算圖核對時發現
同一個視覺元素被拆成好幾個小貼圖、或想把 logo 換成官方指定的版本，直接對已
寫入的 Template 操作（不需要重新 --commit 整個模板）。

用法：
    python scripts/replace_template_sticker.py --template-id 12 --page 3 \
        --remove p3_img70.png --add-file "D:/Documents/LOGO_白色-02.png"

    # 不給 --x/--y/--width/--height 時，新素材會以「被移除貼圖的聯集外框」為準，
    # 以寬度為錨點、依新素材原始長寬比計算高度（避免變形）
    python scripts/replace_template_sticker.py --template-id 12 --page 3 \
        --remove p3_img70.png --remove p3_img72.png \
        --add-file logo.png --x 46 --y 800 --width 250
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT_DIR / "backend" / "album_maker.db"
DEFAULT_UPLOADS_DIR = ROOT_DIR / "backend" / "uploads"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--uploads-dir", type=Path, default=DEFAULT_UPLOADS_DIR)
    parser.add_argument("--template-id", type=int, required=True)
    parser.add_argument("--page", type=int, required=True, help="頁碼（0 起算，即 page_number）")
    parser.add_argument("--remove", action="append", default=[], required=True,
                         help="要移除的貼圖 filename（layout_json 裡 stickers[].filename），可重複給")
    parser.add_argument("--add-file", type=Path, required=True, help="要換上去的乾淨素材圖檔")
    parser.add_argument("--x", type=float, default=None)
    parser.add_argument("--y", type=float, default=None)
    parser.add_argument("--width", type=float, default=None)
    parser.add_argument("--height", type=float, default=None)
    args = parser.parse_args()

    conn = sqlite3.connect(str(args.db))
    cur = conn.cursor()
    cur.execute(
        "SELECT id, layout_json FROM template_pages WHERE template_id = ? AND page_number = ?",
        (args.template_id, args.page),
    )
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"找不到 template_id={args.template_id} page_number={args.page}")
    page_id, layout_json = row
    layout = json.loads(layout_json)

    to_remove = [s for s in layout["stickers"] if s["filename"] in args.remove]
    if not to_remove:
        raise SystemExit(f"這頁的 stickers 裡沒有符合 {args.remove} 的檔名，先確認 filename 對不對")
    missing = set(args.remove) - {s["filename"] for s in to_remove}
    if missing:
        print(f"警告：{missing} 沒找到，略過")

    logo = Image.open(args.add_file).convert("RGBA")
    bbox = logo.split()[-1].getbbox()
    if bbox:
        logo = logo.crop(bbox)
    aspect = logo.width / logo.height

    if args.x is not None and args.y is not None and args.width is not None:
        x, y, width = args.x, args.y, args.width
        height = args.height if args.height is not None else width / aspect
    else:
        x0 = min(s["x"] for s in to_remove)
        y0 = min(s["y"] for s in to_remove)
        x1 = max(s["x"] + s["width"] for s in to_remove)
        y1 = max(s["y"] + s["height"] for s in to_remove)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        width = x1 - x0
        height = width / aspect
        x, y = cx - width / 2, cy - height / 2

    z_index = min(s["z_index"] for s in to_remove)
    layout["stickers"] = [s for s in layout["stickers"] if s["filename"] not in args.remove]

    new_fname = f"replaced_{args.add_file.stem}.png"
    key = f"templates/tmpl{args.template_id}/stickers/{new_fname}"
    (args.uploads_dir / key).parent.mkdir(parents=True, exist_ok=True)
    logo.save(args.uploads_dir / key)

    new_id = max((s["id"] for s in layout["stickers"]), default=0) + 1
    layout["stickers"].append({
        "id": new_id, "path": key, "filename": new_fname,
        "x": x, "y": y, "width": width, "height": height,
        "rotation": 0, "z_index": z_index,
    })

    for old in to_remove:
        if old["filename"] == new_fname:
            # 新素材檔名跟被移除的舊檔名相同（例如重新調整同一張換過的 logo 大小）——
            # 上面已經把新內容寫進這個檔名了，這裡絕對不能刪，否則會把剛存好的新檔案砍掉
            continue
        old_path = args.uploads_dir / "templates" / f"tmpl{args.template_id}" / "stickers" / old["filename"]
        old_path.unlink(missing_ok=True)

    cur.execute(
        "UPDATE template_pages SET layout_json = ? WHERE id = ?",
        (json.dumps(layout, ensure_ascii=False), page_id),
    )
    conn.commit()
    conn.close()
    print(f"已把 {[s['filename'] for s in to_remove]} 換成 {new_fname}，"
          f"位置 ({x:.0f},{y:.0f}) 大小 ({width:.0f}x{height:.0f})")


if __name__ == "__main__":
    main()
