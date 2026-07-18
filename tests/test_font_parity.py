# 前後端字型清單 parity 防線
# 前端 FONT_OPTIONS（constants/fonts.js）的每個 value 都必須存在於
# 後端 FONT_MAP（draw_helpers.py）——否則編輯器選得到、PDF 渲染卻 fallback
# 到預設字型，且這種漂移是靜默的（不報錯、只是輸出字型不對）。

import hashlib
import json
import re
from pathlib import Path

from services.draw_helpers import (
    BUNDLED_FONT_MANIFEST_PATHS,
    BUNDLED_SANS_FONT_PATHS,
    BUNDLED_SERIF_FONT_PATHS,
    FONT_MAP,
    get_font,
)

FRONTEND_FONTS_JS = Path(__file__).parent.parent / "frontend" / "src" / "constants" / "fonts.js"
FRONTEND_INDEX_CSS = Path(__file__).parent.parent / "frontend" / "src" / "index.css"
FRONTEND_MAIN_JSX = Path(__file__).parent.parent / "frontend" / "src" / "main.jsx"
FRONTEND_EDITOR_FONTS_JS = (
    Path(__file__).parent.parent / "frontend" / "src" / "utils" / "editorFonts.js"
)
FRONTEND_FONT_DIR = Path(__file__).parent.parent / "frontend" / "public" / "fonts"
DOCKERFILE = Path(__file__).parent.parent / "Dockerfile"


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


def test_font_options_prefer_the_same_bundled_assets_as_backend():
    source = FRONTEND_FONTS_JS.read_text(encoding="utf-8")
    assert '"Album Noto Sans TC", sans-serif' in source
    assert '"Album Noto Serif TC", serif' in source

    for family in ("msjh", "msjhbd", "msyh"):
        assert FONT_MAP[family][:len(BUNDLED_SANS_FONT_PATHS)] == BUNDLED_SANS_FONT_PATHS
    for family in ("kaiu", "mingliu", "simsun"):
        assert FONT_MAP[family][:len(BUNDLED_SERIF_FONT_PATHS)] == BUNDLED_SERIF_FONT_PATHS


def test_frontend_declares_and_route_loads_every_bundled_font_family():
    css_source = FRONTEND_INDEX_CSS.read_text(encoding="utf-8")
    main_source = FRONTEND_MAIN_JSX.read_text(encoding="utf-8")
    editor_fonts_source = FRONTEND_EDITOR_FONTS_JS.read_text(encoding="utf-8")

    assert 'font-family: "Album Noto Sans TC"' in css_source
    assert 'url("/fonts/NotoSansTC-VF.woff2")' in css_source
    assert 'url("/fonts/NotoSansTC-VF.ttf")' in css_source
    assert 'font-family: "Album Noto Serif TC"' in css_source
    assert 'url("/fonts/NotoSerifTC-VF.woff2")' in css_source
    assert 'url("/fonts/NotoSerifTC-VF.ttf")' in css_source
    assert "document.fonts.load" not in main_source
    assert '\'400 16px "Album Noto Sans TC"\'' in editor_fonts_source
    assert '\'700 16px "Album Noto Sans TC"\'' in editor_fonts_source
    assert '\'400 16px "Album Noto Serif TC"\'' in editor_fonts_source


def test_bundled_font_assets_keep_their_ofl_licenses():
    expected_files = (
        "NotoSansTC-VF.ttf",
        "NotoSansTC-VF.woff2",
        "NotoSerifTC-VF.ttf",
        "NotoSerifTC-VF.woff2",
        "OFL-NotoSansTC.txt",
        "OFL-NotoSerifTC.txt",
    )
    for filename in expected_files:
        assert (FRONTEND_FONT_DIR / filename).is_file()

    for filename in ("OFL-NotoSansTC.txt", "OFL-NotoSerifTC.txt"):
        license_text = (FRONTEND_FONT_DIR / filename).read_text(encoding="utf-8")
        assert "SIL OPEN FONT LICENSE Version 1.1" in license_text


def test_bundled_font_manifest_matches_the_actual_font_bytes():
    manifest_path = Path(BUNDLED_FONT_MANIFEST_PATHS[0])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    for filename, metadata in manifest["fonts"].items():
        font_bytes = (FRONTEND_FONT_DIR / filename).read_bytes()
        assert hashlib.sha256(font_bytes).hexdigest() == metadata["sha256"]


def test_docker_build_exposes_the_same_font_manifest_path_to_backend():
    normalized_paths = tuple(path.replace("\\", "/") for path in BUNDLED_FONT_MANIFEST_PATHS)
    assert "/frontend/dist/fonts/manifest.json" in normalized_paths
    docker_source = DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY --from=frontend-builder /build/dist/ /frontend/dist/" in docker_source


def test_bundled_variable_fonts_select_regular_and_bold_instances():
    regular = get_font(24, "msjh")
    bold = get_font(24, "msjhbd")
    serif = get_font(24, "mingliu")

    assert regular.getname() == ("Noto Sans TC", "Regular")
    assert bold.getname() == ("Noto Sans TC", "Bold")
    assert serif.getname() == ("Noto Serif TC", "Regular")
