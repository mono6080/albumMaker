"""模板跨資料庫搬運的規則。

這支腳本的每個錯誤都不會當場報錯，只會在畫面上變成「模板在、圖是空的」或「蓋掉別人的
模板」——所以三件事要釘住：期別用（部門，名稱）對而不是 id、template id 要重配、
layout_json 裡三處素材路徑都要跟著改。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from scripts import transfer_template


def _make_db(path, templates=(), periods=(), pages=()):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        create table template_periods (id integer primary key, department text, name text,
                                       status text, created_at text);
        create table templates (id integer primary key, name text, created_at text,
                                period_id integer, revision integer);
        create table template_pages (id integer primary key, template_id integer,
                                     page_number integer, background_filename text,
                                     layout_json text not null);
        """
    )
    for pid, dept, name in periods:
        conn.execute("insert into template_periods values (?,?,?,'active','2026-01-01')",
                     (pid, dept, name))
    for tid, name, period_id in templates:
        conn.execute("insert into templates values (?,?,'2026-01-01',?,1)", (tid, name, period_id))
    for tid, page_no, bg, layout in pages:
        conn.execute("insert into template_pages (template_id,page_number,background_filename,layout_json)"
                     " values (?,?,?,?)", (tid, page_no, bg, json.dumps(layout, ensure_ascii=False)))
    conn.commit()
    conn.close()


def _layout(tid):
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "background_filename": f"templates/tmpl{tid}/backgrounds/page9_page0_bg.jpg",
        "photo_slots": [{"id": "slot1"}],
        "stickers": [
            {"id": "s1", "filename": "a.png", "path": f"templates/tmpl{tid}/stickers/a.png"},
            {"id": "s2", "filename": "b.png", "path": f"templates/tmpl{tid}/stickers/b.png"},
        ],
        "text_labels": [{"id": "t1", "text": "x"}],
    }


@pytest.fixture
def workspace(tmp_path):
    src, dst = tmp_path / "source.db", tmp_path / "target.db"
    _make_db(src,
             periods=[(5, "infant", "202608")],
             templates=[(26, "2026-08 12階 感官世界", 5)],
             pages=[(26, 0, f"templates/tmpl26/backgrounds/page9_page0_bg.jpg", _layout(26))])
    # 目標的期別 id 故意跟來源不同——用 id 對就會對到錯的期別
    _make_db(dst,
             periods=[(9, "infant", "202608")],
             templates=[(40, "既有模板", 9)])
    uploads = tmp_path / "uploads" / "templates" / "tmpl26"
    (uploads / "stickers").mkdir(parents=True)
    (uploads / "backgrounds").mkdir(parents=True)
    (uploads / "stickers" / "a.png").write_bytes(b"a")
    (uploads / "stickers" / "b.png").write_bytes(b"b")
    (uploads / "backgrounds" / "page9_page0_bg.jpg").write_bytes(b"bg")
    return src, dst, tmp_path / "uploads", tmp_path / "staging"


def _run(monkeypatch, workspace, *extra):
    src, dst, uploads, staging = workspace
    argv = ["transfer_template.py", "--source-db", str(src), "--target-db", str(dst),
            "--template-id", "26", "--source-uploads", str(uploads),
            "--staging-dir", str(staging), *extra]
    monkeypatch.setattr("sys.argv", argv)
    return transfer_template.main()


def test_dry_run_writes_nothing(monkeypatch, workspace, capsys):
    src, dst, _, staging = workspace
    assert _run(monkeypatch, workspace) == 0
    assert "dry-run" in capsys.readouterr().out
    conn = sqlite3.connect(dst)
    assert conn.execute("select count(*) from templates").fetchone()[0] == 1, "dry-run 不該寫入"
    assert not staging.exists()


def test_apply_reallocates_id_and_rewrites_every_asset_path(monkeypatch, workspace):
    _src, dst, _uploads, staging = workspace
    assert _run(monkeypatch, workspace, "--apply") == 0

    conn = sqlite3.connect(dst)
    conn.row_factory = sqlite3.Row
    new = conn.execute("select * from templates where name like '2026-08%'").fetchone()
    # 目標已有 id=40，新 id 必須是 41，不能沿用來源的 26
    assert new["id"] == 41
    assert new["period_id"] == 9, "期別要用（部門,名稱）對到目標的 id"

    page = conn.execute("select * from template_pages where template_id=41").fetchone()
    layout = json.loads(page["layout_json"])
    # 三處路徑都要改：欄位、layout 的背景、每個貼圖
    assert page["background_filename"] == "templates/tmpl41/backgrounds/page9_page0_bg.jpg"
    assert layout["background_filename"] == "templates/tmpl41/backgrounds/page9_page0_bg.jpg"
    assert [s["path"] for s in layout["stickers"]] == [
        "templates/tmpl41/stickers/a.png",
        "templates/tmpl41/stickers/b.png",
    ]
    assert "tmpl26" not in json.dumps(layout), "不能有殘留的舊 id"
    # 版面其餘內容不能被動到
    assert len(layout["photo_slots"]) == 1 and len(layout["text_labels"]) == 1

    # 素材複製到用新 id 命名的暫存區，直接餵給 migrate_uploads_to_r2.py
    assert (staging / "templates" / "tmpl41" / "stickers" / "a.png").read_bytes() == b"a"
    assert (staging / "templates" / "tmpl41" / "backgrounds" / "page9_page0_bg.jpg").exists()


def test_missing_period_in_target_is_blocked(monkeypatch, tmp_path, capsys):
    src, dst = tmp_path / "s.db", tmp_path / "t.db"
    _make_db(src, periods=[(5, "infant", "202608")],
             templates=[(26, "新模板", 5)], pages=[(26, 0, None, _layout(26))])
    _make_db(dst, periods=[(9, "academy", "202608")])  # 部門不同＝不是同一個期別
    monkeypatch.setattr("sys.argv", ["x", "--source-db", str(src), "--target-db", str(dst),
                                     "--template-id", "26", "--apply"])
    assert transfer_template.main() == 1
    assert "目標沒有期別" in capsys.readouterr().out
    assert sqlite3.connect(dst).execute("select count(*) from templates").fetchone()[0] == 0


def test_same_name_in_target_period_is_not_transferred_twice(monkeypatch, workspace, capsys):
    _src, dst, _uploads, _staging = workspace
    assert _run(monkeypatch, workspace, "--apply") == 0
    assert _run(monkeypatch, workspace, "--apply") == 1, "第二次應該被擋"
    assert "已經有同名模板" in capsys.readouterr().out
    count = sqlite3.connect(dst).execute(
        "select count(*) from templates where name like '2026-08%'").fetchone()[0]
    assert count == 1, "重跑不能建出第二份"


def test_template_without_pages_is_blocked(monkeypatch, tmp_path, capsys):
    src, dst = tmp_path / "s.db", tmp_path / "t.db"
    _make_db(src, periods=[(5, "infant", "202608")], templates=[(26, "空模板", 5)])
    _make_db(dst, periods=[(9, "infant", "202608")])
    monkeypatch.setattr("sys.argv", ["x", "--source-db", str(src), "--target-db", str(dst),
                                     "--template-id", "26", "--apply"])
    assert transfer_template.main() == 1
    assert "沒有任何頁面" in capsys.readouterr().out


def test_source_and_target_must_differ(monkeypatch, tmp_path):
    db = tmp_path / "same.db"
    _make_db(db, periods=[(1, "infant", "202608")])
    monkeypatch.setattr("sys.argv", ["x", "--source-db", str(db), "--target-db", str(db),
                                     "--template-id", "1"])
    with pytest.raises(SystemExit):
        transfer_template.main()


def test_source_with_uncheckpointed_wal_is_refused(monkeypatch, workspace):
    """只複製 .db 漏掉 -wal 會讀到舊資料。

    2026-08-04 上線當天踩過：把演練庫 scp 到伺服器只送了主檔，最近匯入的 7 個模板
    還在 1.6MB 的 WAL 裡，腳本回報「來源沒有 template id=26」白跑一次。與其讓人自己
    看懂那個訊息，不如直接擋下並給出 checkpoint 指令。
    """
    src, dst, uploads, staging = workspace
    src.with_name(src.name + "-wal").write_bytes(b"x" * 4096)

    monkeypatch.setattr("sys.argv",
                        ["x", "--source-db", str(src), "--target-db", str(dst),
                         "--template-id", "26", "--source-uploads", str(uploads),
                         "--staging-dir", str(staging), "--apply"])
    with pytest.raises(SystemExit) as exc:
        transfer_template.main()

    # sys.exit(訊息) 的字串在例外裡，不是印到 stdout
    message = str(exc.value)
    assert "WAL" in message and "checkpoint" in message, message
    assert sqlite3.connect(dst).execute(
        "select count(*) from templates").fetchone()[0] == 1, "被擋下時不該寫入"


def test_empty_wal_does_not_block(workspace, monkeypatch):
    """WAL 檔存在但已 checkpoint（大小 0）是正常狀態，不該擋。"""
    src, dst, uploads, staging = workspace
    src.with_name(src.name + "-wal").write_bytes(b"")
    monkeypatch.setattr("sys.argv",
                        ["x", "--source-db", str(src), "--target-db", str(dst),
                         "--template-id", "26", "--source-uploads", str(uploads),
                         "--staging-dir", str(staging), "--apply"])
    assert transfer_template.main() == 0
