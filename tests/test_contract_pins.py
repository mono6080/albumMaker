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
from services.photo_transform_policy import PHOTO_SCALE_MAX
from services.label_texts import MAX_LABEL_TEXT_LENGTH
from services.text_layout import TEXT_LAYOUT_MEASUREMENT_SCALE
from services.text_variables import (
    ALBUM_NAME_PREVIEW_PLACEHOLDER,
    FULL_NAME_PREVIEW_PLACEHOLDER,
    resolve_student_text_variables,
)

REPO_ROOT = Path(__file__).parent.parent
BACKEND_TOKENS_PATH = REPO_ROOT / "backend" / "services" / "design_tokens.json"
FRONTEND_TOKENS_PATH = REPO_ROOT / "frontend" / "src" / "constants" / "designTokens.js"
FRONTEND_GEOMETRY_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "photoFrameGeometry.js"
FRONTEND_LAYOUT_MODEL_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "renderLayoutModel.js"
FRONTEND_PROPERTY_PANEL_PATH = REPO_ROOT / "frontend" / "src" / "components" / "PropertyPanel.jsx"
FRONTEND_TEXT_FIELD_PATH = REPO_ROOT / "frontend" / "src" / "components" / "TextLabelFieldRow.jsx"
FRONTEND_PHOTO_EDIT_PATH = REPO_ROOT / "frontend" / "src" / "components" / "PhotoEditModal.jsx"
FRONTEND_TEXT_VARIABLES_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "textVariables.js"
FRONTEND_DEPARTMENTS_PATH = REPO_ROOT / "frontend" / "src" / "constants" / "departments.js"
TEXT_VARIABLE_FIXTURE_PATH = (
    REPO_ROOT / "tests" / "fixtures" / "template_text_variable_parity.json"
)


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


def test_department_labels_mirror_backend_source():
    """前端 departments.js 必須與後端正本 TEMPLATE_DEPARTMENTS 完全一致（含順序）。

    部門名稱原本在前端散落 9 處、5 種形狀（選單、篩選列、主管標題、兩處三元式、
    兩頁的 API fallback），改一處忘另外八處是遲早的事。收斂成單一鏡像後由這條釘住。
    """
    from template_periods import TEMPLATE_DEPARTMENTS

    source = FRONTEND_DEPARTMENTS_PATH.read_text(encoding="utf-8")
    array_match = re.search(r"DEPARTMENTS = \[(.*?)\];", source, re.DOTALL)
    assert array_match, (
        "departments.js 找不到 DEPARTMENTS 陣列（格式改了？請同步更新這裡的解析）"
    )
    frontend_departments = [
        {"code": code, "name": name}
        for code, name in re.findall(
            r'\{\s*code:\s*"([^"]+)",\s*name:\s*"([^"]+)"\s*\}', array_match.group(1)
        )
    ]
    assert frontend_departments, "DEPARTMENTS 解析結果是空的，正則與檔案格式已不符"
    assert frontend_departments == [dict(row) for row in TEMPLATE_DEPARTMENTS], (
        "部門清單兩端不一致——正本是 backend/template_periods.py 的 TEMPLATE_DEPARTMENTS，"
        "改了要同步 frontend/src/constants/departments.js"
    )


def test_backend_constants_come_from_tokens():
    """後端幾何常數必須反映 tokens（防止改回字面值）。"""
    tokens = json.loads(BACKEND_TOKENS_PATH.read_text(encoding="utf-8"))
    assert (CANVAS_WIDTH, CANVAS_HEIGHT) == (tokens["canvas"]["width"], tokens["canvas"]["height"])
    assert DEFAULT_PHOTO_BORDER_WIDTH == tokens["photo_frame"]["default_border_width"]
    assert TEXT_LAYOUT_MEASUREMENT_SCALE == tokens["text_layout"]["measurement_scale"]
    assert MAX_LABEL_TEXT_LENGTH == tokens["text_content"]["max_label_text_length"]
    assert PHOTO_SCALE_MAX == tokens["photo_transform"]["max_scale"]


def test_frontend_files_consume_tokens_not_literals():
    """前端幾何/畫布常數必須從 DESIGN_TOKENS 取值（防止改回字面值）。"""
    geometry_source = FRONTEND_GEOMETRY_PATH.read_text(encoding="utf-8")
    layout_source = FRONTEND_LAYOUT_MODEL_PATH.read_text(encoding="utf-8")
    assert "DESIGN_TOKENS.photo_frame.default_border_width" in geometry_source
    assert "DESIGN_TOKENS.photo_frame.bottom_inset_multiplier" in geometry_source
    assert "DESIGN_TOKENS.photo_frame.content_min_width" in geometry_source
    assert "DESIGN_TOKENS.canvas.width" in layout_source
    assert "DESIGN_TOKENS.canvas.height" in layout_source
    text_render_source = (
        REPO_ROOT / "frontend" / "src" / "utils" / "textRenderModel.js"
    ).read_text(encoding="utf-8")
    assert "DESIGN_TOKENS.text_layout.measurement_scale" in text_render_source
    property_panel_source = FRONTEND_PROPERTY_PANEL_PATH.read_text(encoding="utf-8")
    text_field_source = FRONTEND_TEXT_FIELD_PATH.read_text(encoding="utf-8")
    assert "MAX_LABEL_TEXT_LENGTH" in property_panel_source
    assert "MAX_LABEL_TEXT_LENGTH" in text_field_source
    photo_edit_source = FRONTEND_PHOTO_EDIT_PATH.read_text(encoding="utf-8")
    assert "PHOTO_SCALE_MAX" in photo_edit_source


def test_template_name_variable_preview_contract_matches_frontend_and_fixture():
    """模板 Canvas、PIL 預覽與 parity fixture 必須使用相同佔位符。"""
    frontend_source = FRONTEND_TEXT_VARIABLES_PATH.read_text(encoding="utf-8")
    assert (
        f'ALBUM_NAME_PREVIEW_PLACEHOLDER = "{ALBUM_NAME_PREVIEW_PLACEHOLDER}"'
        in frontend_source
    )
    assert (
        f'FULL_NAME_PREVIEW_PLACEHOLDER = "{FULL_NAME_PREVIEW_PLACEHOLDER}"'
        in frontend_source
    )

    fixture = json.loads(TEXT_VARIABLE_FIXTURE_PATH.read_text(encoding="utf-8"))
    text_label = fixture["text_labels"][0]["text"]
    footer = fixture["footer"]["text"]
    assert resolve_student_text_variables(
        text_label,
        FULL_NAME_PREVIEW_PLACEHOLDER,
        ALBUM_NAME_PREVIEW_PLACEHOLDER,
    ) == fixture["expected_text_label"]
    assert resolve_student_text_variables(
        footer,
        FULL_NAME_PREVIEW_PLACEHOLDER,
        ALBUM_NAME_PREVIEW_PLACEHOLDER,
    ) == fixture["expected_footer"]


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
