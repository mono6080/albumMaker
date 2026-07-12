# 前後端字型清單 parity 防線
# 前端 FONT_OPTIONS（constants/fonts.js）的每個 value 都必須存在於
# 後端 FONT_MAP（draw_helpers.py）——否則編輯器選得到、PDF 渲染卻 fallback
# 到預設字型，且這種漂移是靜默的（不報錯、只是輸出字型不對）。

import re
from pathlib import Path

from services.draw_helpers import FONT_MAP

FRONTEND_FONTS_JS = Path(__file__).parent.parent / "frontend" / "src" / "constants" / "fonts.js"


def _frontend_font_values() -> list[str]:
    source = FRONTEND_FONTS_JS.read_text(encoding="utf-8")
    values = re.findall(r'value:\s*"([^"]+)"', source)
    assert values, "解析不到 FONT_OPTIONS 的 value（fonts.js 格式改了？請同步更新這裡的解析）"
    return values


def test_every_frontend_font_option_has_backend_mapping():
    missing = [value for value in _frontend_font_values() if value not in FONT_MAP]
    assert missing == [], (
        f"前端 FONT_OPTIONS 有後端 FONT_MAP 缺少的字型 key：{missing}——"
        "編輯器會顯示該字型、PDF 卻靜默 fallback。請在 draw_helpers.FONT_MAP 補上對應字型檔。"
    )


def test_frontend_font_values_are_unique():
    values = _frontend_font_values()
    assert len(values) == len(set(values)), f"FONT_OPTIONS 有重複的 value：{values}"
