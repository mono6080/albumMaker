"""把已建立模板某一頁裡的一個貼圖，換成 text_labels 裡的固定文字（text_role: static）。

用在「這個貼圖其實是張日期/年份浮水印之類的固定文字，原始檔案是烙在圖片裡的
文字」的情況——與其每次重新產生一張圖檔素材，不如直接換成純文字元素，之後要
改文字/顏色只要編輯 layout_json，不用重繪圖片。text_role: "static" 是後端
`_text_label_is_fillable()`／前端 `textLabelRoles.js` 既有支援的機制，會被
編輯器標成「固定文字」、不會被專案/學生層的文字覆寫蓋掉。

**重要**：這支腳本不寫死任何文字內容——`--text` 一定要由呼叫端（人或 agent）
指定。同一批模板通常共用同一個日期，建議整批只問使用者一次、把答案重複套用到
每個模板，不要在腳本或呼叫程式碼裡硬編年份。

用法：
    python scripts/replace_sticker_with_static_text.py --template-id 12 --page 3 \
        --remove p3_img82_5.png --text "2026.07" --font-color "#FFFFFF"

    # 不給 --x/--y/--width/--height 時，沿用被移除貼圖的聯集外框
    python scripts/replace_sticker_with_static_text.py --template-id 12 --page 3 \
        --remove p3_img82_5.png --text "2026.07" \
        --x 641 --y 925 --width 110 --height 64 --font-size 24
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

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
    parser.add_argument("--text", required=True, help="固定文字內容，不要寫死在腳本裡")
    parser.add_argument("--font-size", type=float, default=24)
    parser.add_argument("--font-color", default="#FFFFFF")
    parser.add_argument("--font-family", default=None)
    parser.add_argument("--text-align", default="center")
    parser.add_argument("--shadow", action="store_true",
                         help="加深色陰影（White-on-white 背景時可讀性會太差，需要陰影撐出對比）")
    parser.add_argument("--shadow-color", default="#141414")
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

    if args.x is not None and args.y is not None and args.width is not None and args.height is not None:
        x, y, width, height = args.x, args.y, args.width, args.height
    else:
        x = min(s["x"] for s in to_remove)
        y = min(s["y"] for s in to_remove)
        x1 = max(s["x"] + s["width"] for s in to_remove)
        y1 = max(s["y"] + s["height"] for s in to_remove)
        width = x1 - x
        height = y1 - y

    z_index = min(s["z_index"] for s in to_remove)
    layout["stickers"] = [s for s in layout["stickers"] if s["filename"] not in args.remove]

    for old in to_remove:
        old_path = args.uploads_dir / "templates" / f"tmpl{args.template_id}" / "stickers" / old["filename"]
        old_path.unlink(missing_ok=True)

    new_id = max([t["id"] for t in layout["text_labels"]] or [0]) + 1
    label = {
        "id": new_id, "x": x, "y": y, "width": width, "height": height,
        "text": args.text, "font_size": args.font_size, "font_color": args.font_color,
        "text_align": args.text_align, "line_height": 1.0, "z_index": z_index,
        "text_role": "static",
    }
    if args.shadow:
        label.update({
            "text_shadow_enabled": True, "text_shadow_color": args.shadow_color,
            "text_shadow_opacity": 200, "text_shadow_offset_x": 0, "text_shadow_offset_y": 0,
            "text_shadow_blur": 3,
        })
    layout["text_labels"].append(label)

    cur.execute(
        "UPDATE template_pages SET layout_json = ? WHERE id = ?",
        (json.dumps(layout, ensure_ascii=False), page_id),
    )
    conn.commit()
    conn.close()
    print(f"已把 {[s['filename'] for s in to_remove]} 換成固定文字 {args.text!r}，"
          f"位置 ({x:.0f},{y:.0f}) 大小 ({width:.0f}x{height:.0f})")


if __name__ == "__main__":
    main()
