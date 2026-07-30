"""將 Office 範本（.docm/.doc/.pdf）匯入成系統的 Template + TemplatePage。

背景：園所的相本範本是用 Word（含巨集）依主題製作，一個期別下有一整套主題資料夾。
這支腳本把「PDF匯入測試」那次手動流程裡機械性的部分自動化：

    docm → (Word 背景自動化，巨集強制停用) → PDF
    docx 原生 XML → 個人/共同照片格的精確座標、旋轉角、原生 RGBA 貼圖
    PDF → 背景圖、對話泡泡貼圖（SMask 去背 + 仿射 warp，非重建旋轉）、文字位置
    → 組成 layout_json，寫入 Template / TemplatePage，貼圖與背景寫入 storage

已知無法全自動、需要人工複核的地方（見 .claude/skills/import-office-template/SKILL.md）：
    - 頁面分組：用背景圖在文件流中出現的順序切頁，少數「段落錨定」的裝飾物件
      （例如 logo）偶爾會落在錯的頁面分組，需要用 --force-page 手動修正
    - 貼圖去重：同一個視覺元素有時會被拆成好幾個小圖層（例如 logo 的局部殘影），
      需要人眼看過算圖結果，事後手動把重複的貼圖換成單一乾淨素材
      （範例指令見 SKILL.md 的「換成統一素材」章節）
    - 這一切都只是「盡量還原」，不是像素級保證跟 Word 原始排版一致

安全機制：
    - 預設是 dry-run：只做抽取 + 本地素材預覽（.tmp/office_template_preview/），不寫資料庫
    - 真正寫入前用 --commit 明確開啟；Template 是新建的（不會動到既有模板/期別）

用法：
    python scripts/import_office_template.py "path/to/主題.docm" --name "主題名稱" --period-id 5
    python scripts/import_office_template.py "path/to/主題.docm" --name "..." --period-id 5 --commit
    python scripts/import_office_template.py "..." --name "..." --period-id 5 \
        --force-page image16.png=2

需求（僅此腳本，不是 app 執行期依賴，不用加進 backend/requirements.txt）：
    pip install pymupdf lxml
    docm/doc 輸入需要 Windows + 已安裝 Microsoft Word（透過 COM 自動化轉存 PDF，
    巨集會被強制停用、唯讀開啟；純 PDF 輸入則不需要 Word）。
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT_DIR / "backend" / "album_maker.db"
DEFAULT_UPLOADS_DIR = ROOT_DIR / "backend" / "uploads"

sys.path.insert(0, str(ROOT_DIR / "backend"))
from services.draw_helpers import get_font, wrap_text  # noqa: E402  真正的渲染引擎用的字型/換行邏輯
from services.text_layout import TEXT_LAYOUT_MEASUREMENT_SCALE  # noqa: E402
from services.material_text_box import (  # noqa: E402  編輯器「重新分析」用的同一支分析器
    analyze_material_text_box,
    project_normalized_box_to_sticker,
)

CANVAS_W, CANVAS_H = 794, 1123
PLACEHOLDER_TEXT = "{name}的文字標題的文字標題的文字標題的文字標題"
PX_PER_EMU = 1 / 9525  # 96dpi 畫布下，1px = 9525 EMU

# 匯入的文字一律用這個字級：屬性面板的「字級（pt）」直接綁 layout 的 font_size，
# 所以這裡填的就是老師在編輯器看到的數字，不再依 PDF 量到的原始字級換算。
TEXT_FONT_SIZE_PT = 18

# 素材文字捷徑（見 docs/specs/illustrator-style-nested-groups-v2.md）：
# link 存在 layout 頂層，有非空 links 就必須帶 contract。
MATERIAL_TEXT_LINK_KIND = "material-text-v1"
NESTED_GROUP_CONTRACT = "nested-world-v2"

# 分析框放不下預留字樣時的補救順序：先試最小角度的素材旋轉，再試最小幅度的
# 等比例放大。旋轉的是素材本身（存旋轉後的圖、文字框仍水平），不是把文字轉斜。
# 上限都是保險，避免極端形狀一路轉/放大到破版；到頂仍放不下就維持原樣。
MATERIAL_ROTATION_STEP = 2.0
MATERIAL_ROTATION_LIMIT = 20.0
MATERIAL_GROWTH_STEP = 0.02
MATERIAL_GROWTH_LIMIT = 1.60

DOCX_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
}
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

PHOTO_TITLE_RE = re.compile(r"^//(個人|共同)-\d+$")


# ── 第一階段：docm → PDF（Word COM 自動化，巨集停用） ──────────────────────

def convert_office_to_pdf(input_path: Path, out_pdf_path: Path) -> None:
    import win32com.client as win32

    word = win32.gencache.EnsureDispatch("Word.Application")
    word.Visible = False
    word.AutomationSecurity = 3  # msoAutomationSecurityForceDisable：不執行巨集
    doc = None
    try:
        doc = word.Documents.Open(
            str(input_path), ReadOnly=True, ConfirmConversions=False, AddToRecentFiles=False
        )
        doc.ExportAsFixedFormat(OutputFileName=str(out_pdf_path), ExportFormat=17)  # wdExportFormatPDF
    finally:
        if doc is not None:
            doc.Close(False)
        word.Quit()


# ── 第二階段：docx 原生 XML → 個人/共同照片格 ──────────────────────────────

def parse_docx_anchors(docm_path: Path) -> list[dict]:
    import zipfile
    from lxml import etree

    z = zipfile.ZipFile(docm_path)
    xml_bytes = z.read("word/document.xml")
    rels_bytes = z.read("word/_rels/document.xml.rels")

    rels_root = etree.fromstring(rels_bytes)
    rid_to_target = {rel.get("Id"): rel.get("Target") for rel in rels_root}

    root = etree.fromstring(xml_bytes)
    anchors = root.findall(".//wp:anchor", DOCX_NS)

    items = []
    for i, anchor in enumerate(anchors):
        docPr = anchor.find("wp:docPr", DOCX_NS)
        title = docPr.get("title") if docPr is not None else None
        relH = int(anchor.get("relativeHeight", "0"))
        posH = anchor.find("wp:positionH/wp:posOffset", DOCX_NS)
        posV = anchor.find("wp:positionV/wp:posOffset", DOCX_NS)
        posH_rel = anchor.find("wp:positionH", DOCX_NS)
        posV_rel = anchor.find("wp:positionV", DOCX_NS)
        ext = anchor.find("wp:extent", DOCX_NS)
        pic = anchor.find(".//pic:pic", DOCX_NS)
        txbx_texts = [t.text for t in anchor.findall(".//w:t", DOCX_NS) if t.text]
        xfrm = anchor.find(".//a:xfrm", DOCX_NS)
        rot = int(xfrm.get("rot")) if xfrm is not None and xfrm.get("rot") else 0
        embed = None
        if pic is not None:
            blip = pic.find(".//a:blip", DOCX_NS)
            if blip is not None:
                embed = blip.get(f"{{{R_NS}}}embed")
        media = rid_to_target.get(embed) if embed else None

        items.append({
            "idx": i,
            "kind": "pic" if pic is not None else ("txbx" if txbx_texts else "other"),
            "title": title,
            "relH": relH,
            "pos_rel": (
                posH_rel.get("relativeFrom") if posH_rel is not None else None,
                posV_rel.get("relativeFrom") if posV_rel is not None else None,
            ),
            "x_emu": int(posH.text) if posH is not None else None,
            "y_emu": int(posV.text) if posV is not None else None,
            "w_emu": int(ext.get("cx")) if ext is not None else None,
            "h_emu": int(ext.get("cy")) if ext is not None else None,
            "rot_raw": rot,
            "media": media,
            "text": "".join(txbx_texts) if txbx_texts else None,
        })
    return items


def norm_angle(rot_raw: int) -> float:
    deg = rot_raw / 60000
    if deg > 180:
        deg -= 360
    return deg


def assign_pages_by_background(anchors: list[dict], overrides: dict[str, int]) -> dict[int, list[dict]]:
    """用背景圖（page-relative、近全頁尺寸）在文件順序中出現的位置切頁。

    這是啟發式規則，不是排版引擎：多數裝飾物件跟著最近的背景走沒問題，
    但少數段落錨定的物件實際落在哪一頁，Word 排版時才會決定，這裡猜不到，
    需要靠 overrides（--force-page media_filename=page_index）人工修正。
    """
    bg_idxs = [
        it["idx"] for it in anchors
        if it["kind"] == "pic" and it["w_emu"] and it["h_emu"]
        and it["w_emu"] * PX_PER_EMU > CANVAS_W * 0.9
        and it["h_emu"] * PX_PER_EMU > CANVAS_H * 0.9
    ]
    if not bg_idxs:
        raise SystemExit("找不到任何近全頁尺寸的背景圖，無法切頁——請確認輸入檔案正確")

    groups: dict[int, list[dict]] = {p: [] for p in range(len(bg_idxs))}
    page_no = 0
    for it in anchors:
        if it["idx"] > bg_idxs[page_no] and page_no < len(bg_idxs) - 1:
            page_no += 1
        groups[page_no].append(it)

    for it in anchors:
        media_name = (it["media"] or "").split("/")[-1]
        if media_name in overrides:
            forced_page = overrides[media_name]
            for p in groups:
                groups[p] = [x for x in groups[p] if x["idx"] != it["idx"]]
            groups.setdefault(forced_page, []).append(it)

    return groups


BRAND_TITLE_KEYWORDS = ("derni", "logo", "商標", "品牌")


def find_brand_anchor_pages(page_groups: dict[int, list[dict]]) -> dict[int, list[str]]:
    """列出每頁裡 title 疑似園所品牌標／logo 的物件，供人工檢查是否要換成統一素材。

    這裡故意只偵測、印出警告，不自動猜哪些貼圖屬於同一個 logo 再合併替換——
    上一輪匯入就是因為「以為做了、其實忘了」才漏掉 logo 替換，比起自動但可能
    默默失敗的合併規則，明確印出「這幾頁有品牌標，你换了嗎」更可靠。

    只回傳頁碼，不嘗試用 bbox 去找同一區域的其他貼圖——試過用 docx anchor 的
    EMU 座標比對，但 logo 這類裝飾物件幾乎都是 column/paragraph-relative
    （只有 photo_slots 用的 `//個人-N`／`//共同-N` 是可靠的 page-relative），
    paragraph-relative 的絕對頁面座標要走版面引擎才能算出來，anchor XML 本身
    沒有，所以 bbox 比對不可靠。改成呼叫端（main()）印警告時，直接把該頁的
    完整貼圖清單一起列出來讓人核對——logo 美術稿常被 Word 拆成好幾個 PDF
    image xref（icon、文字、日期章），比起猜哪些貼圖屬於同一組，列出「這頁
    全部貼圖」更可靠，反正這種頁面貼圖數量通常不多，人工核對成本不高。"""
    result: dict[int, list[str]] = {}
    for page_no, anchors in page_groups.items():
        hits = [
            (it["title"] or "") + f"（{(it['media'] or '').split('/')[-1]}）"
            for it in anchors
            if it["kind"] == "pic" and it["title"]
            and any(kw in it["title"].lower() for kw in BRAND_TITLE_KEYWORDS)
        ]
        if hits:
            result[page_no] = hits
    return result


def build_photo_boxes(page_groups: dict[int, list[dict]]) -> dict[int, list[dict]]:
    result = {}
    for page_no, anchors in page_groups.items():
        boxes = []
        for it in anchors:
            if it["kind"] != "pic" or not it["title"] or not PHOTO_TITLE_RE.match(it["title"]):
                continue
            if it["pos_rel"] != ("page", "page"):
                # 沒有用 page-relative 定位的「照片」標題物件，位置無法直接換算，跳過
                continue
            x = it["x_emu"] * PX_PER_EMU
            y = it["y_emu"] * PX_PER_EMU
            w = it["w_emu"] * PX_PER_EMU
            h = it["h_emu"] * PX_PER_EMU
            boxes.append({
                "title": it["title"], "media": it["media"], "relH": it["relH"],
                "x": x, "y": y, "w": w, "h": h,
                "cx": x + w / 2, "cy": y + h / 2,
                "angle": norm_angle(it["rot_raw"]),
            })
        result[page_no] = boxes
    return result


# ── 第三階段：PDF → 背景 / 貼圖（SMask 去背 + 仿射 warp）/ 文字位置 ─────────

def get_smask_xref(doc, xref: int) -> int | None:
    obj = doc.xref_object(xref, compressed=True)
    m = re.search(r"/SMask\s+(\d+)\s+0\s+R", obj)
    return int(m.group(1)) if m else None


def load_clean_rgba_source(doc, xref: int) -> Image.Image:
    base_dict = doc.extract_image(xref)
    base_img = Image.open(io.BytesIO(base_dict["image"])).convert("RGB")
    smask_xref = get_smask_xref(doc, xref)
    if smask_xref:
        mask_dict = doc.extract_image(smask_xref)
        mask_img = Image.open(io.BytesIO(mask_dict["image"])).convert("L")
        if mask_img.size != base_img.size:
            mask_img = mask_img.resize(base_img.size, Image.LANCZOS)
    else:
        mask_img = Image.new("L", base_img.size, 255)
    rgba = base_img.convert("RGBA")
    rgba.putalpha(mask_img)
    return rgba


def warp_sticker_to_canvas_crop(doc, xref: int, transform_pt, scale: float, pad: int = 4):
    """直接用 PDF 的仿射矩陣把來源圖 warp 到畫布座標再裁切，取代「拆解成
    x/y/width/height/rotation 交給前端 resize+rotate 重建」——後者在非正方形
    ＋大角度旋轉的素材上驗證過會有位置誤差（見 SKILL.md 的踩雷紀錄）。"""
    a, b, c, d, e, f = [v * scale for v in transform_pt]
    src = load_clean_rgba_source(doc, xref)
    sw, sh = src.size

    M = np.array([[a / sw, c / sh], [b / sw, d / sh]])
    Minv = np.linalg.inv(M)
    data = (
        Minv[0, 0], Minv[0, 1], -(Minv[0, 0] * e + Minv[0, 1] * f),
        Minv[1, 0], Minv[1, 1], -(Minv[1, 0] * e + Minv[1, 1] * f),
    )

    corners = [(e, f), (a + e, b + f), (a + c + e, b + d + f), (c + e, d + f)]
    x0 = max(0, int(min(p[0] for p in corners)) - pad)
    y0 = max(0, int(min(p[1] for p in corners)) - pad)
    x1 = min(CANVAS_W, int(max(p[0] for p in corners)) + pad)
    y1 = min(CANVAS_H, int(max(p[1] for p in corners)) + pad)

    full = src.transform((CANVAS_W, CANVAS_H), Image.AFFINE, data, resample=Image.BICUBIC)
    crop = full.crop((x0, y0, x1, y1))
    return crop, (x0, y0, x1 - x0, y1 - y0)


def largest_opaque_rect(mask: np.ndarray) -> tuple[int, int, int, int]:
    """找出不透明遮罩（bool 陣列，True=不透明）裡最大的軸對齊全不透明矩形。

    對話泡泡這類素材是「圓角矩形本體＋一個尖角尾巴」，尾巴會把 alpha 通道的
    外接矩形（bbox）往尾巴那個方向撐大很多，但主體本身在尾巴那側其實窄很多。
    只用 bbox 加一個固定比例的內縮，會在尾巴那個角落算出「看起來還在 bbox 裡、
    實際上已經超出實色本體」的框，導致文字疊到背景上。用直方圖法找最大內接
    矩形（標準演算法），保證框一定落在實色本體內，不用針對尾巴另外寫特例。"""
    rows, cols = mask.shape
    heights = [0] * cols
    best = (0, 0, 0, 0, 0)  # area, x0, y0, w, h
    for r in range(rows):
        for c in range(cols):
            heights[c] = heights[c] + 1 if mask[r, c] else 0
        stack: list[int] = []
        c = 0
        while c <= cols:
            h = heights[c] if c < cols else 0
            if not stack or h >= heights[stack[-1]]:
                stack.append(c)
                c += 1
            else:
                top = stack.pop()
                width = c if not stack else c - stack[-1] - 1
                area = heights[top] * width
                if area > best[0]:
                    x0 = (stack[-1] + 1) if stack else 0
                    y0 = r - heights[top] + 1
                    best = (area, x0, y0, width, heights[top])
    _, x0, y0, w, h = best
    return x0, y0, w, h


def is_effectively_invisible(crop) -> bool:
    """偵測完全（或幾乎完全）透明的貼圖——docm 原檔裡就存在的隱藏殘留物件。

    這種圖不是腳本處理出錯，是 Word 原始檔案本身的問題：某些形狀被作者用
    「透明度調到 0%」的方式隱藏，而不是真的刪除（常見於反覆修改設計草稿、
    複製貼上舊版素材後蓋掉但沒清掉），Word 匯出 PDF 時這些隱藏形狀仍然是
    完整的 image XObject，只是 SMask 全黑（alpha=0）。實際驗證過（環保小尖兵
    page3 xref=84）：底層 RGB 不是全透明貼圖的線索、SMask 本身在 PDF 裡就是
    全零，不是我們 warp/resize 過程搞壞的。這種圖怎麼疊都不會顯示，直接排除，
    不像 looks_like_placeholder_card 那樣需要視覺啟發式判斷、有誤判風險。"""
    alpha = np.asarray(crop.convert("RGBA"))[:, :, 3]
    return alpha.mean() < 2


def looks_like_placeholder_card(crop) -> bool:
    """偵測「單一底色、印有 01/02.../個人照/團體照 數字」的殘留佔位卡圖層。

    這種圖是 docm 裡「照片格」本體美術稿的殘留匯出（同一張卡在 Word 排版計算
    時位置跟我們用 page-relative EMU 算出來的 photo_slot 位置對不上——原因未明，
    懷疑是 Word 匯出 PDF 時對某些形狀重新計算了位置），視覺上是大面積實色填滿
    （灰底白字、黃底黃字都遇過），跟真正的裝飾插畫（線條/漸層/多色變化、通常
    面積較小或大量透明）用顏色標準差 + 不透明面積比例做啟發式判斷。

    **這個函式只是輔助條件，呼叫端一定要先過「跟某個 photo_slot 尺寸接近」的
    篩選，不能單獨用這個函式的結果來排除貼圖**——實測過一個純棕色實心填滿
    ＋白色虛線邊框的對話泡泡（非洲與大洋洲模板），沒有內建大字文案，色彩
    標準差跟不透明面積比例剛好也符合這裡的判斷特徵，單獨用這個函式會把真正
    的裝飾貼圖誤刪掉、完全看不出來（不像漏掉整頁文字那麼容易發現）。占位卡
    的真正特徵是「跟某個 photo_slot 尺寸幾乎一樣」（因為它是同一張照片格美術
    稿的殘留），這個尺寸比對才是可靠的篩選條件，色彩判斷只用來輔助縮小範圍。"""
    arr = np.asarray(crop.convert("RGBA"))
    alpha = arr[:, :, 3]
    mask = alpha > 200
    if mask.mean() < 0.6:
        return False
    rgb = arr[:, :, :3][mask]
    std = rgb.std(axis=0).mean()
    return std < 20


_MEASURE_CANVAS = Image.new("RGB", (10, 10))
_MEASURE_DRAW = ImageDraw.Draw(_MEASURE_CANVAS)


def estimate_placeholder_height(width_px: float, font_size: float, line_height: float, line_height_px: float) -> float:
    """量出 PLACEHOLDER_TEXT 在給定寬度下真正會排幾行，回傳對應的框高。

    直接呼叫正式渲染引擎用的 get_font/wrap_text，保證這裡算出的行數跟
    render_text_label() 實際排版結果一致——不能用固定倍數猜（例如「抓 2.4 行高」），
    因為預留字樣的寬度是固定的，但每個對話泡泡的框寬是照原始文案量出來的，
    原始文案越短、框越窄，同樣的長預留字樣就要排越多行，固定倍數在窄框上
    會算出不夠高的框，導致文字被裁切。"""
    measurement_scale = TEXT_LAYOUT_MEASUREMENT_SCALE
    font = get_font(font_size * measurement_scale)
    lines = wrap_text(
        PLACEHOLDER_TEXT,
        font,
        max(1, width_px * measurement_scale),
        _MEASURE_DRAW,
    )
    return max(2, len(lines)) * line_height_px + line_height_px * 0.3


def detect_background_xref(page) -> int:
    info = page.get_image_info(xrefs=True)
    bg = max(info, key=lambda im: (im["bbox"][2] - im["bbox"][0]) * (im["bbox"][3] - im["bbox"][1]))
    return bg["xref"]


def detect_caption_regions(page, scale: float, stickers: list[dict],
                            sticker_visual_bounds: dict[int, tuple[float, float, float, float]]
                            ) -> list[tuple[float, float, float, float]]:
    """把疑似對話泡泡文字的 span 依垂直相鄰關係分組，回傳每組的聯集 bbox（pt）。

    不能用「白色」判斷是不是對話泡泡文案——同一系列範本裡文案顏色其實不固定
    （環保小尖兵是白色，昆蟲世界是橘色，感官世界1月是藍色，寫死顏色會直接
    漏掉整頁文字，肉眼在小張截圖上很容易沒發現「其實一個字都沒有」）。改成
    判斷「這個文字 span 是不是疊在某張貼圖（對話泡泡）的可見範圍上」——這才是
    對話泡泡文案的真正定義，跟顏色無關，只跟版面位置有關。"""
    spans = []
    d2 = page.get_text("dict")
    for block in d2["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                # 字級上限排除大型裝飾數字/標題字樣（例如頁面大標題、logo 旁的年份）
                if not (10 <= span["size"] <= 30):
                    continue
                if not span["text"].strip():
                    continue
                sx0, sy0, sx1, sy1 = [v * scale for v in span["bbox"]]
                on_sticker = any(
                    min(sx1, vx + vw) > max(sx0, vx) and min(sy1, vy + vh) > max(sy0, vy)
                    for s in stickers
                    for vx, vy, vw, vh in [sticker_visual_bounds.get(s["id"], (s["x"], s["y"], s["width"], s["height"]))]
                )
                if not on_sticker:
                    continue
                spans.append(span)

    spans.sort(key=lambda s: (s["bbox"][1], s["bbox"][0]))
    groups: list[list[dict]] = []
    for s in spans:
        placed = False
        for g in groups:
            last = g[-1]
            same_line = abs(s["bbox"][1] - last["bbox"][1]) < 2
            # 行距門檻從 0.8 放寬到 1.1：實測感官世界1月的行距剛好卡在
            # 0.8 倍字級的邊界外一點點（14.65pt vs 門檻 14.4pt），導致兩行
            # 文案沒被合併成一組，各自獨立找到同一張貼圖當 backing，兩組算出
            # 完全一樣的座標，變成貼圖清單裡出現兩個內容相同、疊在一起的
            # 「老師可填文字」欄位——肉眼在算圖上看不出來（反正疊在一起，
            # 顯示結果一樣），但資料是重複的
            next_line = 0 <= s["bbox"][1] - last["bbox"][3] < last["size"] * 1.1
            if same_line or next_line:
                g.append(s)
                placed = True
                break
        if not placed:
            groups.append([s])

    regions = []
    for g in groups:
        x0 = min(s["bbox"][0] for s in g)
        y0 = min(s["bbox"][1] for s in g)
        x1 = max(s["bbox"][2] for s in g)
        y1 = max(s["bbox"][3] for s in g)
        # 用這組裡最常見的顏色當代表色——不能寫死白色，見上面的踩雷紀錄：
        # 昆蟲世界文案是橘色疊在米白色泡泡上，白字疊上去會整段隱形看不到
        color_int = Counter(s["color"] for s in g).most_common(1)[0][0]
        color_hex = f"#{color_int:06X}"
        regions.append((x0, y0, x1, y1, color_hex))
    return regions


def build_page_layout(pdf_doc, page_no: int, photo_boxes_px: list[dict], scale: float) -> dict:
    page = pdf_doc[page_no]
    bg_xref = detect_background_xref(page)

    pt_per_px = 1 / scale
    photo_boxes_pt = [
        {"cx": pb["cx"] * pt_per_px, "cy": pb["cy"] * pt_per_px,
         "w": pb["w"] * pt_per_px, "h": pb["h"] * pt_per_px}
        for pb in photo_boxes_px
    ]

    content = page.read_contents().decode("latin1")
    paint_order = [int(m) for m in re.findall(r"/Image(\d+)\s+Do", content)]
    positions_by_xref: dict[int, list[int]] = {}
    for i, xr in enumerate(paint_order):
        positions_by_xref.setdefault(xr, []).append(i)

    info = page.get_image_info(xrefs=True)
    # 用「實例清單」而非以 xref 為 key 的字典收集座標——同一個 xref（例如同一張
    # 對話泡泡素材）在同一頁重複貼好幾次是常見情況（這裡曾經用 dict 收集，後貼
    # 的實例會把先貼的實例直接覆蓋掉，導致每頁固定少一個貼圖、肉眼在縮圖上很難
    # 發現），必須保留每個實例各自的座標，不能假設同一個 xref 只出現一次。
    instances = [(im["xref"], im["transform"]) for im in info if im["xref"] != 0]

    def area(b):
        return max(0, b[2] - b[0]) * max(0, b[3] - b[1])

    def center(b):
        return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

    sticker_instances = []
    for xr, tr in instances:
        if xr == bg_xref:
            continue
        a, b, c, d, e, f = tr
        corners = [(e, f), (a + e, b + f), (a + c + e, b + d + f), (c + e, d + f)]
        bbox = (min(p[0] for p in corners), min(p[1] for p in corners),
                max(p[0] for p in corners), max(p[1] for p in corners))
        icx, icy = center(bbox)
        is_photo = any(
            math.hypot(icx - pb["cx"], icy - pb["cy"]) < 40 and area(bbox) > pb["w"] * pb["h"] * 0.5
            for pb in photo_boxes_pt
        )
        if not is_photo:
            true_w, true_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            sticker_instances.append((xr, tr, true_w, true_h))

    stickers = []
    sticker_assets = {}
    # 貼圖素材原始檔（裁切出的 PNG）常常比視覺上看到的圖案本身還大——warp 後的
    # 裁切框是整張來源圖的平行四邊形外接矩形，來源圖本身留白/透明邊距都會算
    # 進 width/height 裡。文字要「貼合素材大小」指的是貼合看得到的圖案範圍，
    # 不是這個含留白的檔案尺寸，所以另外存一份用 alpha 通道量出來的可見範圍
    # （canvas 座標），給文字排版用；layout.json 裡 sticker 本身的 x/y/width/
    # height 維持原樣（那是貼圖本體真正的擺放位置，不能動）。
    sticker_visual_bounds: dict[int, tuple[float, float, float, float]] = {}
    for si, (xr, tr, true_w, true_h) in enumerate(sticker_instances, start=1):
        crop, (x0, y0, w, h) = warp_sticker_to_canvas_crop(pdf_doc, xr, tr, scale)
        matches_photo_size = any(
            abs(true_w - pb["w"]) < pb["w"] * 0.15 and abs(true_h - pb["h"]) < pb["h"] * 0.15
            for pb in photo_boxes_pt
        )
        if is_effectively_invisible(crop) or (matches_photo_size and looks_like_placeholder_card(crop)):
            continue
        # 檔名帶實例序號（si），不能只用 xref——同一個 xref 可能對應多個實例，
        # 只用 xref 當檔名會讓後面的實例存檔時蓋掉前一個相同 xref 的素材檔案
        fname = f"p{page_no}_img{xr}_{si}.png"
        positions = positions_by_xref.get(xr) or []
        z = positions.pop(0) if positions else si
        sticker_assets[fname] = crop
        # 用最大內接矩形而不是 alpha bbox：對話泡泡這類「本體＋尖角尾巴」的素材，
        # alpha bbox 會被尾巴撐大，尾巴那個角落其實不是實色本體，文字貼齊 bbox
        # 內縮的固定比例會在尾巴那側超出實際看得到的圖案（見這次的踩雷紀錄）。
        # 泡泡邊框常見一圈虛線裝飾（一顆顆不透明的圓點中間夾透明縫隙），alpha
        # 直接門檻化會把這圈邊框處理成一堆小洞，逼最大矩形往內縮到只剩很小一塊
        # 乾淨區域——先用 Max/MinFilter 做一次「閉運算」把這些小洞補起來，矩形
        # 才能長到接近真正視覺上完整的泡泡本體大小。
        alpha_mask = (np.asarray(crop.convert("RGBA"))[:, :, 3] > 200).astype(np.uint8) * 255
        closed = Image.fromarray(alpha_mask, mode="L").filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
        opaque = np.asarray(closed) > 127
        if opaque.any():
            rx0, ry0, rw, rh = largest_opaque_rect(opaque)
            sticker_visual_bounds[si] = (x0 + rx0, y0 + ry0, rw, rh)
        else:
            sticker_visual_bounds[si] = (x0, y0, w, h)
        stickers.append({
            "id": si, "path": fname, "filename": fname,
            "x": x0, "y": y0, "width": w, "height": h,
            "rotation": 0, "z_index": z,
        })

    def nearest_sticker_z(tx0, ty0, tx1, ty1):
        tcx, tcy = (tx0 + tx1) / 2 * scale, (ty0 + ty1) / 2 * scale
        best, best_d = None, 1e18
        for s in stickers:
            scx, scy = s["x"] + s["width"] / 2, s["y"] + s["height"] / 2
            d = math.hypot(tcx - scx, tcy - scy)
            if d < best_d:
                best_d, best = d, s
        return best["z_index"] if best else 0

    # 對話泡泡「看得到的圖案」本體有圓角/尾巴，文字框貼齊可見範圍邊緣還是會
    # 壓到造型，所以在可見範圍內再內縮一點比例
    BUBBLE_PAD_X_RATIO, BUBBLE_PAD_Y_RATIO = 0.06, 0.08

    def find_backing_sticker(cx0, cy0, cx1, cy1):
        """找出這個文字說明實際疊在哪張貼圖（對話泡泡）上面：取原始文案 bbox
        跟每張貼圖「可見範圍」（sticker_visual_bounds，alpha 通道量出來的，
        不是含留白的檔案外接矩形）重疊比例最高者。用重疊比例而不是「距離最近」，
        是因為貼圖大小差很多，距離近不代表文字真的畫在它上面。"""
        best, best_ratio = None, 0.0
        cap_area = max(1e-6, (cx1 - cx0) * (cy1 - cy0))
        for s in stickers:
            vx, vy, vw, vh = sticker_visual_bounds[s["id"]]
            ix0, iy0 = max(cx0, vx), max(cy0, vy)
            ix1, iy1 = min(cx1, vx + vw), min(cy1, vy + vh)
            inter = max(0, ix1 - ix0) * max(0, iy1 - iy0)
            ratio = inter / cap_area
            if ratio > best_ratio:
                best_ratio, best = ratio, s
        return best if best_ratio > 0.3 else None

    font_size = TEXT_FONT_SIZE_PT
    line_height = 1.3
    line_height_px = font_size * line_height

    def analyzed_box_for(sticker):
        """用後端素材分析器算這張貼圖的文字框（跟編輯器「重新分析並重設」同一套）。

        不自己另寫一套內縮規則：編輯器的素材文字捷徑走
        services/material_text_box.py 的 alpha-inner-rect 偵測 + 投影，匯入時
        若用別的算法，同一張貼圖在「匯入結果」與「按下重新分析」會得到兩個不同
        的框，之後每次重新分析都會讓版面跳一次。分析不出來（低信心／形狀不明）
        時才退回舊的可見範圍內縮法。

        分析框放不下預留字樣時，**就地最小幅度放大素材**再重新投影——放大素材
        而不是把框撐出泡泡，框才會一直等於分析結果（編輯器按重新分析不會跳），
        同時佔位字也不會被裁掉。放大以素材中心為基準、等比例，所以泡泡造型與
        文字的相對位置不變。
        """
        asset = sticker_assets.get(sticker["filename"])
        if asset is None:
            return None
        try:
            analysis = analyze_material_text_box(asset)
        except Exception:  # 分析失敗不該讓整份匯入中斷，退回 fallback
            return None
        if analysis.get("status") != "suggested":
            return None
        px_per_unit_x = asset.width / sticker["width"]
        px_per_unit_y = asset.height / sticker["height"]
        center_x = sticker["x"] + sticker["width"] / 2
        center_y = sticker["y"] + sticker["height"] / 2
        normalized_box = analysis["normalized_box"]

        def geometry_for(image, scale_factor):
            """把素材圖換算成畫布幾何：素材實際大小不變（同 px/unit），中心不動。"""
            width = image.width / px_per_unit_x * scale_factor
            height = image.height / px_per_unit_y * scale_factor
            return {
                "x": center_x - width / 2, "y": center_y - height / 2,
                "width": width, "height": height, "rotation": 0,
            }

        def evaluate(image, box_source, scale_factor):
            geom = geometry_for(image, scale_factor)
            box = project_normalized_box_to_sticker(geom, box_source)
            need = estimate_placeholder_height(box["width"], font_size, line_height, line_height_px)
            return geom, box, need

        try:
            geom, box, need = evaluate(asset, normalized_box, 1.0)
        except ValueError:
            return None
        if need <= box["height"]:
            return box

        # 放不下時找「總幅度最小」的補救：底圖可以旋轉、可以放大，也可以兩者混用。
        # 兩個手段各自歸一化後相加當成本，所以 10° 不會被當成跟放大 10% 一樣輕微。
        # 旋轉的是素材圖本身（存旋轉後的圖），文字框仍水平——底圖轉、文字不轉。
        def cost_of(degree, factor):
            return (
                abs(degree) / MATERIAL_ROTATION_LIMIT
                + (factor - 1) / (MATERIAL_GROWTH_LIMIT - 1)
            )

        degrees = [0.0]
        step = MATERIAL_ROTATION_STEP
        while step <= MATERIAL_ROTATION_LIMIT:
            degrees.extend((step, -step))
            step = round(step + MATERIAL_ROTATION_STEP, 4)

        best = None
        for degree in degrees:
            # 角度本身的成本已超過目前最佳解時，再小的放大也贏不了，直接剪枝
            if best is not None and cost_of(degree, 1.0) >= best[0]:
                continue
            image = (
                asset if degree == 0
                else asset.rotate(degree, expand=True, resample=Image.BICUBIC)
            )
            if degree != 0:
                try:
                    rotated_analysis = analyze_material_text_box(image)
                except Exception:
                    continue
                if rotated_analysis.get("status") != "suggested":
                    continue
                candidate_box = rotated_analysis["normalized_box"]
            else:
                candidate_box = normalized_box

            factor = 1.0
            while factor <= MATERIAL_GROWTH_LIMIT:
                if best is not None and cost_of(degree, factor) >= best[0]:
                    break
                try:
                    geom, box, need = evaluate(image, candidate_box, factor)
                except ValueError:
                    break
                if need <= box["height"]:
                    best = (cost_of(degree, factor), degree, factor, image, geom, box)
                    break
                factor = round(factor + MATERIAL_GROWTH_STEP, 4)

        if best is None:
            # 轉到底、放大到頂都塞不下：維持原樣，交由人工調整（不硬撐破版）
            return box

        _, degree, factor, image, geom, box = best
        if degree != 0:
            sticker_assets[sticker["filename"]] = image
        sticker.update(
            x=geom["x"], y=geom["y"], width=geom["width"], height=geom["height"]
        )
        changes = []
        if degree:
            changes.append(f"旋轉 {degree:+.0f}°")
        if factor > 1.0:
            changes.append(f"放大 {factor:.0%}")
        print(f"      第 {page_no + 1} 頁 {sticker['filename']}："
              f"底圖{'＋'.join(changes)} 讓文字放得下")
        return box

    text_labels = []
    material_text_links = []
    seen_backing_ids: set[int] = set()
    caption_regions = detect_caption_regions(page, scale, stickers, sticker_visual_bounds)
    for ti, (x0, y0, x1, y1, color_hex) in enumerate(caption_regions, start=1):
        cx0, cy0, cx1, cy1 = x0 * scale, y0 * scale, x1 * scale, y1 * scale
        backing = find_backing_sticker(cx0, cy0, cx1, cy1)
        if backing is not None:
            if backing["id"] in seen_backing_ids:
                # 同一張貼圖（對話泡泡）不該有兩個文字說明——多半是上游分行分組
                # 把同一段文案的兩行拆成兩組，各自疊到同一張貼圖上，算出來的
                # 座標會完全一樣（因為座標是跟著 backing 貼圖走，不是跟著原始
                # 文案本身），留第一個、跳過重複的，不然貼圖清單會出現兩個內容
                # 相同、疊在一起的「老師可填文字」欄位
                continue
            seen_backing_ids.add(backing["id"])
            # 文字底下有素材框時，交給素材分析器決定框，並把兩者連結成素材文字
            # 捷徑：之後在編輯器按「重新分析並重設」會得到同一個框，不會跳動。
            analyzed = analyzed_box_for(backing)
            if analyzed is not None:
                text_labels.append({
                    "id": ti,
                    "x": analyzed["x"], "y": analyzed["y"],
                    "width": analyzed["width"], "height": analyzed["height"],
                    "rotation": analyzed["rotation"],
                    "text": PLACEHOLDER_TEXT, "font_size": font_size,
                    "font_color": color_hex, "text_align": "left",
                    "line_height": line_height, "z_index": backing["z_index"] + 0.5,
                })
                material_text_links.append({
                    "kind": MATERIAL_TEXT_LINK_KIND,
                    "material_id": backing["id"],
                    "text_id": ti,
                })
                continue
            # 分析不出來才退回：框寬高跟著背後對話泡泡「看得到的圖案範圍」走
            # （不是素材檔案含留白的外接矩形），而不是原始（通常短很多的）文案
            # 量出來的窄框——預留字樣比原始文案長很多，貼著素材可見大小排版，
            # 視覺上才會跟泡泡形狀吻合，不會小小一塊擠在泡泡一角、也不會因為
            # 留白被撐得太大
            vx, vy, vw, vh = sticker_visual_bounds[backing["id"]]
            pad_x = vw * BUBBLE_PAD_X_RATIO
            pad_y = vh * BUBBLE_PAD_Y_RATIO
            width_px = max(20, vw - 2 * pad_x)
            box_x = vx + pad_x
            box_cy = vy + vh / 2 - pad_y * 0.2
            z = backing["z_index"]
        else:
            width_px = cx1 - cx0
            box_x = cx0
            box_cy = (cy0 + cy1) / 2
            z = nearest_sticker_z(x0, y0, x1, y1)
        # 用「跟正式渲染引擎相同的 wrap_text/字型」量出預留字樣實際會排幾行，
        # 而不是猜一個固定倍數——固定倍數在窄的泡泡（原始文案短、框窄）上會
        # 算出不夠高的框，導致長預留字樣被裁切、看起來像「文字消失」
        target_h = estimate_placeholder_height(width_px, font_size, line_height, line_height_px)
        text_labels.append({
            "id": ti, "x": box_x, "y": box_cy - target_h / 2,
            "width": width_px, "height": target_h,
            "text": PLACEHOLDER_TEXT, "font_size": font_size, "font_color": color_hex,
            "text_align": "left", "line_height": line_height, "z_index": z + 0.5,
        })

    photo_slots = []
    for i, pb in enumerate(photo_boxes_px):
        photo_slots.append({
            "id": i + 1, "x": pb["x"], "y": pb["y"], "width": pb["w"], "height": pb["h"],
            "rotation": pb["angle"], "border": False,
            "shadow_enabled": True, "shadow_offset_x": 4, "shadow_offset_y": 6,
            "shadow_blur": 10, "shadow_opacity": 110,
            "z_index": pb["relH"] / 100000 if pb.get("relH") else 0,
        })

    bg_fname = f"page{page_no}_bg.jpg"
    bg_bytes = pdf_doc.extract_image(bg_xref)["image"]

    layout = {
        "canvas_width": CANVAS_W, "canvas_height": CANVAS_H,
        "background_filename": bg_fname,
        "photo_slots": photo_slots,
        "text_labels": text_labels, "stickers": stickers,
        "footer": None,
    }
    # 契約：有非空 material_text_links[] 就必須帶 contract；兩者都空時省略，
    # 不寫入空 marker（見 nested-groups-v2 規格的 validation invariants）。
    if material_text_links:
        layout["material_text_links"] = material_text_links
        layout["group_contract"] = NESTED_GROUP_CONTRACT
    return layout, {bg_fname: bg_bytes}, sticker_assets


# logo／素材統一（例如換成單一乾淨版本）不在這支腳本裡自動處理——
# 需要先看過 dry-run 算圖結果才知道哪些貼圖屬於同一個視覺元素，
# 步驟與範例指令見 SKILL.md 的「換成統一素材」章節。


# ── 第四階段：寫入資料庫 + storage ─────────────────────────────────────────

def create_template(db_path: Path, uploads_dir: Path, name: str, period_id: int,
                     layouts: dict, bg_assets: dict, sticker_assets: dict) -> int:
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO templates (name, period_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        (name, period_id),
    )
    template_id = cur.lastrowid

    sticker_dir = uploads_dir / "templates" / f"tmpl{template_id}" / "stickers"
    bg_dir = uploads_dir / "templates" / f"tmpl{template_id}" / "backgrounds"
    sticker_dir.mkdir(parents=True, exist_ok=True)
    bg_dir.mkdir(parents=True, exist_ok=True)

    for page_no in sorted(layouts.keys()):
        layout = json.loads(json.dumps(layouts[page_no]))  # deep copy
        cur.execute(
            "INSERT INTO template_pages (template_id, page_number, layout_json) VALUES (?, ?, '{}')",
            (template_id, page_no),
        )
        page_id = cur.lastrowid

        bg_fname = layout["background_filename"]
        bg_key = f"templates/tmpl{template_id}/backgrounds/page{page_id}_{bg_fname}"
        (uploads_dir / bg_key).write_bytes(bg_assets[page_no][bg_fname])
        layout["background_filename"] = bg_key

        for sticker in layout["stickers"]:
            fname = sticker["filename"]
            key = f"templates/tmpl{template_id}/stickers/{fname}"
            asset = sticker_assets[page_no][fname]
            asset.save(uploads_dir / key)
            sticker["path"] = key

        cur.execute(
            "UPDATE template_pages SET layout_json = ?, background_filename = ? WHERE id = ?",
            (json.dumps(layout, ensure_ascii=False), bg_key, page_id),
        )

    conn.commit()
    conn.close()
    return template_id


def render_previews(layouts: dict, preview_dir: Path, bg_assets: dict, sticker_assets: dict) -> None:
    """dry-run 用：把每頁的背景/貼圖存到本地資料夾，供人眼核對用（不寫資料庫）。
    要看到完整合成畫面，另外用 backend 的 render_service 搭配這個資料夾當
    ALBUM_MAKER_UPLOADS_DIR 手動跑一次（SKILL.md 有範例指令）。"""
    preview_dir.mkdir(parents=True, exist_ok=True)
    for page_no, layout in layouts.items():
        page_dir = preview_dir / f"page{page_no}"
        page_dir.mkdir(parents=True, exist_ok=True)
        for fname, data in bg_assets[page_no].items():
            (page_dir / fname).write_bytes(data)
        for fname, img in sticker_assets[page_no].items():
            img.save(page_dir / fname)
        (page_dir / "layout.json").write_text(
            json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8"
        )


# ── CLI ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="來源檔案（.docm/.doc 或已轉好的 .pdf）")
    parser.add_argument("--name", required=True, help="新模板名稱")
    parser.add_argument("--period-id", type=int, required=True, help="要放入的 template_periods.id")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--uploads-dir", type=Path, default=DEFAULT_UPLOADS_DIR)
    parser.add_argument("--preview-dir", type=Path, default=ROOT_DIR / ".tmp" / "office_template_preview")
    parser.add_argument("--force-page", action="append", default=[],
                         help="手動指定某個媒體檔案屬於哪一頁，格式 filename=page_index，可重複給")
    parser.add_argument("--commit", action="store_true", help="真正寫入資料庫；不加這個參數只做 dry-run 預覽")
    args = parser.parse_args()

    import fitz

    overrides = {}
    for spec in args.force_page:
        fname, _, pno = spec.partition("=")
        overrides[fname] = int(pno)

    if args.input.suffix.lower() in (".docm", ".doc", ".docx"):
        pdf_path = args.input.with_suffix(".generated.pdf")
        print(f"轉換 {args.input.name} -> PDF（Word 自動化，巨集已停用）...")
        convert_office_to_pdf(args.input, pdf_path)
        anchors = parse_docx_anchors(args.input)
        page_groups = assign_pages_by_background(anchors, overrides)
        photo_boxes_by_page = build_photo_boxes(page_groups)
        brand_pages = find_brand_anchor_pages(page_groups)
    elif args.input.suffix.lower() == ".pdf":
        pdf_path = args.input
        print("輸入是 PDF，跳過 docx 原生照片抽取，本版本尚未實作 PDF-only 的照片格偵測——"
              "請改用含 docm 來源的路徑，或自行擴充 stroke-rect 偵測。")
        raise SystemExit(1)
    else:
        raise SystemExit(f"不支援的副檔名：{args.input.suffix}")

    pdf_doc = fitz.open(str(pdf_path))
    scale = CANVAS_W / pdf_doc[0].rect.width
    n_pages = len(pdf_doc)

    layouts, bg_assets, sticker_assets = {}, {}, {}
    for page_no in range(n_pages):
        boxes = photo_boxes_by_page.get(page_no, [])
        layout, bg, stk = build_page_layout(pdf_doc, page_no, boxes, scale)
        layouts[page_no] = layout
        bg_assets[page_no] = bg
        sticker_assets[page_no] = stk
        print(f"第 {page_no + 1} 頁：{len(layout['photo_slots'])} 張照片格、"
              f"{len(layout['stickers'])} 個貼圖、{len(layout['text_labels'])} 個文字")

    if brand_pages:
        print("\n⚠ 偵測到品牌標／logo，換成統一素材了嗎？（這步不會自動做，SKILL.md 有換法）")
        for pno, hits in sorted(brand_pages.items()):
            print(f"   第 {pno + 1} 頁：{', '.join(hits)}")
            page_stickers = layouts[pno]["stickers"]
            if page_stickers:
                sizes = ", ".join(f"{s['filename']}({s['width']:.0f}x{s['height']:.0f})" for s in page_stickers)
                print(f"      這頁全部貼圖（logo 美術稿常被拆成好幾個，日期章這類碎片"
                      f"不一定有命名，一併核對）：{sizes}")

    if not args.commit:
        render_previews(layouts, args.preview_dir, bg_assets, sticker_assets)
        print(f"\ndry-run 完成，素材已存到 {args.preview_dir}，尚未寫入資料庫。")
        print("請依 SKILL.md 的步驟核對算圖結果後，加 --commit 真正建立模板。")
        return

    template_id = create_template(args.db, args.uploads_dir, args.name, args.period_id,
                                   layouts, bg_assets, sticker_assets)
    print(f"\n已建立 Template id={template_id}，共 {n_pages} 頁。")
    if brand_pages:
        print("⚠ 再提醒一次：上面列的頁面有品牌標，記得換成統一素材（見 SKILL.md）。")


if __name__ == "__main__":
    main()
