# 前後端契約釘測試
# 跨語言鏡像（PIL↔Konva、Python↔JS）沒辦法共用程式碼，防漂移的結構解是
# 「一份測試同時讀兩邊」：改一邊不改另一邊，CI 直接紅。
# 字型清單的釘在 tests/test_font_parity.py。

import json
import re
from pathlib import Path

from services.photo_frame_geometry import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    DEFAULT_PHOTO_BORDER_WIDTH,
    get_photo_frame_insets,
)

REPO_ROOT = Path(__file__).parent.parent
BACKEND_TOKENS_PATH = REPO_ROOT / "backend" / "services" / "design_tokens.json"
FRONTEND_TOKENS_PATH = REPO_ROOT / "frontend" / "src" / "constants" / "designTokens.js"
FRONTEND_GEOMETRY_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "photoFrameGeometry.js"
FRONTEND_LAYOUT_MODEL_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "renderLayoutModel.js"


def _load_frontend_tokens() -> dict:
    """從前端鏡像檔抽出嚴格 JSON 物件字面值（檔頭注釋已約定寫法）。"""
    source = FRONTEND_TOKENS_PATH.read_text(encoding="utf-8")
    match = re.search(r"DESIGN_TOKENS = (\{.*\});", source, re.DOTALL)
    assert match, "designTokens.js 找不到 DESIGN_TOKENS 物件（格式改了？請同步更新這裡的解析）"
    return json.loads(match.group(1))


def test_design_tokens_mirror_matches_backend_source():
    """前端 designTokens.js 鏡像必須與後端正本 design_tokens.json 完全一致。"""
    backend_tokens = json.loads(BACKEND_TOKENS_PATH.read_text(encoding="utf-8"))
    frontend_tokens = _load_frontend_tokens()
    assert frontend_tokens == backend_tokens, (
        "design tokens 兩端不一致——正本是 backend/services/design_tokens.json，"
        "改了要同步 frontend/src/constants/designTokens.js"
    )


def test_backend_constants_come_from_tokens():
    """後端幾何常數必須反映 tokens（防止改回字面值）。"""
    tokens = json.loads(BACKEND_TOKENS_PATH.read_text(encoding="utf-8"))
    assert (CANVAS_WIDTH, CANVAS_HEIGHT) == (tokens["canvas"]["width"], tokens["canvas"]["height"])
    assert DEFAULT_PHOTO_BORDER_WIDTH == tokens["photo_frame"]["default_border_width"]


def test_frontend_files_consume_tokens_not_literals():
    """前端幾何/畫布常數必須從 DESIGN_TOKENS 取值（防止改回字面值）。"""
    geometry_source = FRONTEND_GEOMETRY_PATH.read_text(encoding="utf-8")
    layout_source = FRONTEND_LAYOUT_MODEL_PATH.read_text(encoding="utf-8")
    assert "DESIGN_TOKENS.photo_frame.default_border_width" in geometry_source
    assert "DESIGN_TOKENS.photo_frame.bottom_inset_multiplier" in geometry_source
    assert "DESIGN_TOKENS.photo_frame.content_min_width" in geometry_source
    assert "DESIGN_TOKENS.canvas.width" in layout_source
    assert "DESIGN_TOKENS.canvas.height" in layout_source


def test_photo_frame_insets_algorithm_pinned():
    """拍立得 insets 演算法釘值：左/上/右 = border_width、下 = 乘數倍。

    這組數字是前後端 WYSIWYG 的核心契約（e2e 也用具體像素斷言釘住），
    改乘數必須同步 tokens 兩端與 e2e 斷言。
    """
    tokens = json.loads(BACKEND_TOKENS_PATH.read_text(encoding="utf-8"))
    multiplier = tokens["photo_frame"]["bottom_inset_multiplier"]
    insets = get_photo_frame_insets({"border": True, "border_width": 8})
    assert (insets["left"], insets["top"], insets["right"]) == (8, 8, 8)
    assert insets["bottom"] == 8 * multiplier

    borderless = get_photo_frame_insets({"border": False, "border_width": 8})
    assert borderless["bottom"] == 0 and borderless["has_border"] is False
