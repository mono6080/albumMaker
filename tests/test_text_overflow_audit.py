import csv
import sqlite3

import scripts.audit_text_overflow as overflow_script
from scripts.audit_text_overflow import measure_text_overflow, write_csv


def _label(text: str, *, width: int = 320, height: int = 100) -> dict:
    return {
        "id": 1,
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "text": text,
        "font_size": 24,
        "font_family": "msjh",
        "font_color": "#333333",
        "text_align": "center",
        "line_height": 1.4,
    }


def test_short_text_has_no_actual_glyph_overflow():
    result = measure_text_overflow(_label("短文字"), None, "小明")

    assert result is not None
    assert result["has_overflow"] is False
    assert result["overflow_top_px"] == 0
    assert result["overflow_bottom_px"] == 0


def test_long_text_reports_actual_glyph_overflow_without_shrinking():
    result = measure_text_overflow(
        _label("很長的文字" * 20, width=120, height=60),
        None,
        "小明",
    )

    assert result is not None
    assert result["has_overflow"] is True
    assert result["line_box_risk"] is True
    assert result["overflow_top_px"] > 0 or result["overflow_bottom_px"] > 0


def test_fillable_override_and_name_variable_are_measured_as_final_text():
    label = _label("{name}的預設文字", width=140, height=70)
    result = measure_text_overflow(
        label,
        {"text": "{name}的個別覆寫文字"},
        "王小朋友",
    )

    assert result is not None
    assert result["resolved_text"] == "王小朋友的個別覆寫文字"


def test_overflow_csv_is_formula_safe(tmp_path):
    report_path = tmp_path / "overflow.csv"

    write_csv(
        report_path,
        ["student_name", "resolved_text", "project_name"],
        [{
            "student_name": "=危險",
            "resolved_text": "@內容",
            "project_name": " \t+危險",
        }],
    )

    with report_path.open(encoding="utf-8-sig", newline="") as report_file:
        row = next(csv.DictReader(report_file))
    assert row == {
        "student_name": "'=危險",
        "resolved_text": "'@內容",
        "project_name": "' \t+危險",
    }


def test_overflow_reports_share_run_id_and_do_not_overwrite(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    with sqlite3.connect(database_path):
        pass
    monkeypatch.setattr(
        overflow_script,
        "collect_template_defaults",
        lambda *_args: (0, []),
    )
    detail_base = tmp_path / "details.csv"
    summary_base = tmp_path / "summary.csv"

    for run_id in ("audit-one", "audit-two"):
        assert overflow_script.main([
            "--db",
            str(database_path),
            "--scope",
            "template-defaults",
            "--detail-report",
            str(detail_base),
            "--summary-report",
            str(summary_base),
            "--run-id",
            run_id,
        ]) == 0

    assert not detail_base.exists()
    assert not summary_base.exists()
    for run_id in ("audit-one", "audit-two"):
        detail_path = tmp_path / f"details-{run_id}.csv"
        summary_path = tmp_path / f"summary-{run_id}.csv"
        assert detail_path.is_file()
        assert summary_path.is_file()
        with detail_path.open(
            encoding="utf-8-sig",
            newline="",
        ) as detail_file:
            assert next(csv.reader(detail_file))[0] == "run_id"
        with summary_path.open(
            encoding="utf-8-sig",
            newline="",
        ) as summary_file:
            assert next(csv.reader(summary_file))[0] == "run_id"

    first_detail = (tmp_path / "details-audit-one.csv").read_bytes()
    assert overflow_script.main([
        "--db",
        str(database_path),
        "--scope",
        "template-defaults",
        "--detail-report",
        str(detail_base),
        "--summary-report",
        str(summary_base),
        "--run-id",
        "audit-one",
    ]) == 2
    assert (tmp_path / "details-audit-one.csv").read_bytes() == first_detail
