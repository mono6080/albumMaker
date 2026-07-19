from services.draw_helpers import _line_width_with_spacing, _text_units, wrap_text
from services.text_layout import layout_text_label


class FixedAdvanceFont:
    def getmetrics(self):
        return (8, 2)


class FixedAdvanceDraw:
    def textlength(self, text, *, font):
        del font
        widths = {" ": 4, "-": 5}
        return sum(widths.get(character, 10) for character in text)


def test_wrap_text_matches_konva_character_boundaries():
    draw = FixedAdvanceDraw()
    font = FixedAdvanceFont()

    assert wrap_text("ABC DEF", font, 44, draw, 0) == ["ABC D", "EF"]
    assert wrap_text("ABC-DEF", font, 45, draw, 0) == ["ABC-D", "EF"]


def test_wrap_text_preserves_explicit_newlines():
    draw = FixedAdvanceDraw()
    font = FixedAdvanceFont()

    assert wrap_text("ABC\nDEF", font, 100, draw, 0) == ["ABC", "DEF"]


def test_line_width_counts_trailing_letter_spacing_like_konva():
    draw = FixedAdvanceDraw()
    font = FixedAdvanceFont()

    assert _line_width_with_spacing(draw, "ABC", font, 2) == 36


def test_text_units_match_konva_zwj_pair_splitting():
    assert _text_units("👨‍👩‍👧‍👦") == ["👨‍", "👩‍", "👧‍", "👦"]
    assert _text_units("A\u0301👍🏽") == ["A\u0301", "👍🏽"]


def test_layout_keeps_first_visible_lines_and_preserves_float_line_height():
    draw = FixedAdvanceDraw()
    font = FixedAdvanceFont()

    plan = layout_text_label(
        "AAAA\nB\nCC\nDDD",
        font=font,
        box_width=100,
        box_height=25,
        font_size=10,
        line_height=1.25,
        letter_spacing=0,
        text_align="left",
        clip_overflow=True,
        draw=draw,
    )

    assert plan.full_lines == ["AAAA", "B", "CC", "DDD"]
    assert plan.visible_lines == ["AAAA", "B"]
    assert plan.max_visible_lines == 2
    assert plan.line_height_px == 12.5
    assert plan.line_baselines[1] - plan.line_baselines[0] == 12.5


def test_layout_alignment_uses_advance_width_including_letter_spacing():
    draw = FixedAdvanceDraw()
    font = FixedAdvanceFont()

    centered = layout_text_label(
        "ABC",
        font=font,
        box_width=100,
        box_height=30,
        font_size=10,
        line_height=1,
        letter_spacing=2,
        text_align="center",
        clip_overflow=True,
        draw=draw,
    )
    right = layout_text_label(
        "ABC",
        font=font,
        box_width=100,
        box_height=30,
        font_size=10,
        line_height=1,
        letter_spacing=2,
        text_align="right",
        clip_overflow=True,
        draw=draw,
    )

    assert centered.line_x_positions == [32]
    assert right.line_x_positions == [64]
