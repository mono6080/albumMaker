"""輸出後端文字排版計畫，供 Node/Konva parity gate 使用。"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.draw_helpers import get_font
from services.text_layout import TEXT_LAYOUT_MEASUREMENT_SCALE, layout_text_label


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: python scripts/measure_backend_text_layout.py FIXTURE_PATH"
        )

    fixture_path = Path(sys.argv[1])
    cases = json.loads(fixture_path.read_text(encoding="utf-8"))
    results = []
    for test_case in cases:
        font_size = float(test_case["font_size"])
        measurement_scale = TEXT_LAYOUT_MEASUREMENT_SCALE
        font_family = test_case.get("font_family", "msjh")
        font = get_font(font_size * measurement_scale, font_family)
        full_plan = layout_text_label(
            test_case["text"],
            font=font,
            box_width=float(test_case["width"]) * measurement_scale,
            box_height=float(test_case["height"]) * measurement_scale,
            font_size=font_size * measurement_scale,
            line_height=float(test_case["line_height"]),
            letter_spacing=float(test_case["letter_spacing"]) * measurement_scale,
            text_align=test_case["text_align"],
            clip_overflow=False,
        )
        visible_plan = layout_text_label(
            test_case["text"],
            font=font,
            box_width=float(test_case["width"]) * measurement_scale,
            box_height=float(test_case["height"]) * measurement_scale,
            font_size=font_size * measurement_scale,
            line_height=float(test_case["line_height"]),
            letter_spacing=float(test_case["letter_spacing"]) * measurement_scale,
            text_align=test_case["text_align"],
            clip_overflow=True,
        )
        results.append({
            "name": test_case["name"],
            "font_family": font_family,
            "font_name": font.getname(),
            "full_lines": full_plan.full_lines,
            "visible_lines": visible_plan.visible_lines,
            "line_widths": [
                value / measurement_scale
                for value in visible_plan.line_widths
            ],
            "line_x_positions": [
                value / measurement_scale
                for value in visible_plan.line_x_positions
            ],
            "line_baselines": [
                value / measurement_scale
                for value in visible_plan.line_baselines
            ],
            "line_height_px": visible_plan.line_height_px / measurement_scale,
            "max_visible_lines": visible_plan.max_visible_lines,
        })
    print(json.dumps(results, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
