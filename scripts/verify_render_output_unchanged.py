"""比對重構前後的渲染輸出是否位元相同。

渲染指紋（`_render_pipeline_fingerprint`）雜湊渲染來源檔的內容，所以純改名也會
讓指紋改變、既有輸出全部被判定過期而重渲染。輸出理論上不變，但「理論上」不夠——
這支腳本在改動前後各跑一次，用實際位元證明。

用法：
    python scripts/verify_render_output_unchanged.py --out before.json   # 重構前
    python scripts/verify_render_output_unchanged.py --out after.json    # 重構後
    python scripts/verify_render_output_unchanged.py --compare before.json after.json

比對的是 render_page 的輸出位元，不是 PDF 檔——PDF 容器含時間戳，本來就不會相同。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from io import BytesIO
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
IMPORT_ROOT = BACKEND_DIR if (BACKEND_DIR / "database.py").is_file() else ROOT_DIR
sys.path.insert(0, str(IMPORT_ROOT))

FIXTURE_PATH = ROOT_DIR / "tests" / "fixtures" / "render_smoke_layout.json"

# 涵蓋文字覆蓋、空白文字、姓名變數與多頁索引；每個 case 都是一次完整 render_page
CASES = [
    ("plain", "Ada", {}, 0),
    ("label_override", "Ada", {"label_texts": {"1": "重構前後必須一致"}}, 0),
    ("empty_label", "Ada", {"label_texts": {"1": ""}}, 0),
    ("long_name", "歐陽子軒", {"label_texts": {"1": "換行測試 " * 12}}, 0),
    ("second_page", "小明", {}, 1),
]


def collect() -> dict:
    from services.render_service import render_page  # noqa: E402
    from services.student_render_service import _RENDER_PIPELINE_VERSION  # noqa: E402

    layout = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    results = {}
    for case_name, student_name, page_data, page_index in CASES:
        image = render_page(
            layout,
            student_name=student_name,
            page_data=page_data,
            page_index=page_index,
        )
        buffer = BytesIO()
        image.save(buffer, format="PNG", compress_level=0)
        results[case_name] = {
            "size": list(image.size),
            "sha256": hashlib.sha256(image.tobytes()).hexdigest(),
        }
    return {"pipeline_version": _RENDER_PIPELINE_VERSION, "cases": results}


def compare(before_path: Path, after_path: Path) -> int:
    before = json.loads(before_path.read_text(encoding="utf-8"))
    after = json.loads(after_path.read_text(encoding="utf-8"))
    if before["pipeline_version"] == after["pipeline_version"]:
        print("渲染指紋沒變，既有輸出不會被判定過期。")
    else:
        print(f"渲染指紋已變：{before['pipeline_version']} → "
              f"{after['pipeline_version']}（既有輸出會全部重渲染）")

    differing = [
        name for name in before["cases"]
        if before["cases"][name] != after["cases"].get(name)
    ]
    missing = sorted(set(before["cases"]) ^ set(after["cases"]))
    if missing:
        print(f"case 集合不一致：{missing}")
        return 1
    if differing:
        print(f"\n以下 case 的輸出位元不同 —— 這不是純改名，必須查清楚：")
        for name in differing:
            print(f"  {name}: {before['cases'][name]} → {after['cases'][name]}")
        return 1
    print(f"\n{len(before['cases'])} 個 case 的輸出位元完全相同；重渲染是純浪費，"
          "不會改變任何人看到的相本。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("BEFORE", "AFTER"))
    args = parser.parse_args()

    if args.compare:
        return compare(*args.compare)
    if not args.out:
        parser.error("需要 --out 或 --compare")

    snapshot = collect()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"渲染指紋 {snapshot['pipeline_version']}；"
          f"{len(snapshot['cases'])} 個 case 已寫入 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
