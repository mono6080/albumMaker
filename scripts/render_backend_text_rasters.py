"""以 production Pillow renderer 輸出文字 parity gate PNG。"""

from __future__ import annotations

import json
from pathlib import Path
import sys

from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.element_renderers import render_text_label


_FIXTURE_ONLY_KEYS = {
    "name",
    "canvas_width",
    "canvas_height",
    "compare_row_bands",
    "expected_row_band_count",
    "assert_clip_edges",
}


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: python scripts/render_backend_text_rasters.py "
            "FIXTURE_PATH OUTPUT_DIR"
        )

    fixture_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)
    cases = json.loads(fixture_path.read_text(encoding="utf-8"))
    results = []

    for test_case in cases:
        canvas_width = int(test_case["canvas_width"])
        canvas_height = int(test_case["canvas_height"])
        label = {
            key: value
            for key, value in test_case.items()
            if key not in _FIXTURE_ONLY_KEYS
        }
        canvas = Image.new(
            "RGBA",
            (canvas_width, canvas_height),
            (0, 0, 0, 0),
        )
        render_text_label(canvas, label, {}, "")
        output_path = output_dir / f"{test_case['name']}.png"
        canvas.save(output_path)
        results.append(
            {
                "name": test_case["name"],
                "path": str(output_path.resolve()),
                "width": canvas.width,
                "height": canvas.height,
            }
        )

    print(json.dumps(results, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
