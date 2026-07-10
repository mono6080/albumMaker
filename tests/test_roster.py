# 名冊與學期彙整匯出測試
# 覆蓋：學生建立/改名的名冊自動連結、同名歧義待確認、link/merge 端點、
# 學期匯出預覽分組與 ZIP 下載結構

from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from tests.test_api_smoke import (
    assert_status,
    create_user,
    jpeg_bytes,
    login,
    smoke_layout,
    started_client,
    unique_name,
    use_tmp_uploads,
)

from database import SessionLocal, Student


def create_active_period(client: TestClient, department: str = "infant") -> dict:
    response = client.post(
        "/api/templates/periods",
        data={"name": unique_name("period"), "department": department, "status": "active"},
    )
    assert_status(response, 200)
    return response.json()


def create_period_template_project(client: TestClient, period_id: int) -> int:
    """建立掛在指定期別下的模板（含一頁版型）與專案，回傳 project_id。"""
    template_response = client.post(
        "/api/templates/",
        data={"name": unique_name("template"), "period_id": str(period_id)},
    )
    assert_status(template_response, 200)
    template_id = template_response.json()["id"]

    page_response = client.post(f"/api/templates/{template_id}/pages")
    assert_status(page_response, 200)
    layout_response = client.put(
        f"/api/templates/{template_id}/pages/{page_response.json()['id']}/layout",
        json=smoke_layout(),
    )
    assert_status(layout_response, 200)

    project_response = client.post(
        "/api/projects/",
        data={"name": unique_name("project"), "template_id": str(template_id)},
    )
    assert_status(project_response, 201)
    return project_response.json()["id"]


def add_students(client: TestClient, project_id: int, names: list[str]) -> dict[str, int]:
    """批次新增學生並回傳 name → student_id 對照。"""
    response = client.post(f"/api/projects/{project_id}/students/batch", json=names)
    assert_status(response, 200)
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return {student["name"]: student["id"] for student in detail.json()["students"]}


def roster_child_id_of(student_id: int) -> int | None:
    db = SessionLocal()
    try:
        return db.query(Student).filter(Student.id == student_id).one().roster_child_id
    finally:
        db.close()


def test_autolink_same_name_across_projects_and_rename_relink():
    with started_client() as client:
        login(client)
        period_a = create_active_period(client)
        period_b = create_active_period(client)
        project_a = create_period_template_project(client, period_a["id"])
        project_b = create_period_template_project(client, period_b["id"])

        students_a = add_students(client, project_a, ["王小明", "李小華"])
        students_b = add_students(client, project_b, ["王 小明"])  # 空白視為同名

        ming_a = roster_child_id_of(students_a["王小明"])
        ming_b = roster_child_id_of(students_b["王 小明"])
        hua_a = roster_child_id_of(students_a["李小華"])
        assert ming_a is not None
        assert ming_a == ming_b  # 跨專案同名自動連到同一名冊孩子
        assert hua_a is not None and hua_a != ming_a

        # 匯出預覽依名冊孩子分組
        preview = client.get(
            "/api/roster/semester-export",
            params={"period_ids": [period_a["id"], period_b["id"]]},
        )
        assert_status(preview, 200)
        preview_data = preview.json()
        assert [period["id"] for period in preview_data["periods"]] == [period_a["id"], period_b["id"]]
        groups_by_name = {group["name"]: group for group in preview_data["children"]}
        assert len(groups_by_name["王小明"]["entries"]) == 2
        assert len(groups_by_name["李小華"]["entries"]) == 1
        assert preview_data["unlinked"] == []
        assert all(entry["has_pdf"] is False for entry in groups_by_name["王小明"]["entries"])

        # 改名後重新解析：李小華 改成 王小明 → 連到既有的王小明名冊項
        rename = client.put(
            f"/api/projects/{project_a}/students/{students_a['李小華']}",
            data={"name": "王小明二號"},
        )
        assert_status(rename, 200)
        renamed_child = roster_child_id_of(students_a["李小華"])
        assert renamed_child is not None and renamed_child not in (ming_a, hua_a)


def test_ambiguous_name_requires_manual_link_and_merge():
    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project_a = create_period_template_project(client, period["id"])
        project_b = create_period_template_project(client, period["id"])
        project_c = create_period_template_project(client, period["id"])

        students_a = add_students(client, project_a, ["王小明"])
        students_b = add_students(client, project_b, ["王小明"])
        child_original = roster_child_id_of(students_a["王小明"])

        # admin 把 B 的學生拆成新名冊項 → 名冊出現兩個「王小明」
        split = client.put(
            f"/api/roster/students/{students_b['王小明']}/link",
            json={"create_new": True},
        )
        assert_status(split, 200)
        child_split = split.json()["roster_child_id"]
        assert child_split != child_original

        # 之後再新增同名學生 → 歧義，留待確認
        students_c = add_students(client, project_c, ["王小明"])
        assert roster_child_id_of(students_c["王小明"]) is None

        preview = client.get(
            "/api/roster/semester-export",
            params={"period_ids": [period["id"]]},
        )
        assert_status(preview, 200)
        unlinked = preview.json()["unlinked"]
        assert len(unlinked) == 1
        assert unlinked[0]["student_id"] == students_c["王小明"]
        candidate_ids = {candidate["roster_child_id"] for candidate in unlinked[0]["candidates"]}
        assert candidate_ids == {child_original, child_split}

        # 手動配對到既有名冊項
        link = client.put(
            f"/api/roster/students/{students_c['王小明']}/link",
            json={"roster_child_id": child_original},
        )
        assert_status(link, 200)
        assert roster_child_id_of(students_c["王小明"]) == child_original

        # 合併誤拆的名冊項
        self_merge = client.post(f"/api/roster/children/{child_split}/merge/{child_split}")
        assert_status(self_merge, 400)
        merge = client.post(f"/api/roster/children/{child_split}/merge/{child_original}")
        assert_status(merge, 200)
        assert merge.json()["moved"] == 1
        assert roster_child_id_of(students_b["王小明"]) == child_original

        missing_merge = client.post(f"/api/roster/children/{child_split}/merge/{child_original}")
        assert_status(missing_merge, 404)


def roster_child_count(name: str) -> int:
    from database import RosterChild

    db = SessionLocal()
    try:
        return db.query(RosterChild).filter(RosterChild.name == name).count()
    finally:
        db.close()


def test_orphaned_roster_children_are_cleaned_up():
    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project = create_period_template_project(client, period["id"])
        students = add_students(client, project, ["孤兒測試甲", "孤兒測試乙"])

        # 改名：舊名冊項變孤兒 → 刪除
        rename = client.put(
            f"/api/projects/{project}/students/{students['孤兒測試甲']}",
            data={"name": "孤兒測試丙"},
        )
        assert_status(rename, 200)
        assert roster_child_count("孤兒測試甲") == 0
        assert roster_child_count("孤兒測試丙") == 1

        # 刪學生：名冊項孤兒 → 刪除
        delete = client.delete(f"/api/projects/{project}/students/{students['孤兒測試乙']}")
        assert_status(delete, 200)
        assert roster_child_count("孤兒測試乙") == 0

        # link create_new 拆分：來源仍有其他學生時保留
        project_b = create_period_template_project(client, period["id"])
        students_b = add_students(client, project_b, ["孤兒測試丙"])
        split = client.put(
            f"/api/roster/students/{students_b['孤兒測試丙']}/link",
            json={"create_new": True},
        )
        assert_status(split, 200)
        assert roster_child_count("孤兒測試丙") == 2  # 原項仍有專案 A 的學生


def test_copy_students_preserves_roster_links():
    with started_client() as client:
        login(client)
        period = create_active_period(client)
        source_project = create_period_template_project(client, period["id"])
        target_project = create_period_template_project(client, period["id"])

        source_students = add_students(client, source_project, ["王小明", "李小華"])
        # 目標專案先有一位同名學生 → 複製時跳過
        add_students(client, target_project, ["王小明"])

        copy_response = client.post(
            f"/api/projects/{target_project}/students/copy",
            json={"source_project_id": source_project},
        )
        assert_status(copy_response, 200)
        assert copy_response.json() == {"created": ["李小華"], "skipped": ["王小明"]}

        # 名冊連結直接沿用來源，不經同名解析
        target_detail = client.get(f"/api/projects/{target_project}")
        target_ids = {student["name"]: student["id"] for student in target_detail.json()["students"]}
        assert roster_child_id_of(target_ids["李小華"]) == roster_child_id_of(source_students["李小華"])

        # 來源專案不存在 → 404
        missing_source = client.post(
            f"/api/projects/{target_project}/students/copy",
            json={"source_project_id": 999999},
        )
        assert_status(missing_source, 404)


def test_roster_endpoints_require_admin():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        teacher, teacher_password = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])

        client.cookies.clear()
        login(client, teacher["username"], teacher_password)
        preview = client.get("/api/roster/semester-export", params={"period_ids": [1]})
        assert_status(preview, 403)
        link = client.put("/api/roster/students/1/link", json={"create_new": True})
        assert_status(link, 403)


def test_supervisor_scoped_preview_and_no_export():
    with started_client() as client:
        login(client)
        supervisor, supervisor_password = create_user(client, "supervisor")
        managed_teacher, teacher_password = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])
        period = create_active_period(client)
        # admin 自己的專案（主管不該看到）
        admin_project = create_period_template_project(client, period["id"])
        add_students(client, admin_project, ["管理員的學生"])

        # 管轄老師的專案
        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        teacher_detail = client.get("/api/projects/")
        assert_status(teacher_detail, 200)
        # 老師用 admin 建好的模板開自己的專案
        client.cookies.clear()
        login(client)
        templates = client.get("/api/templates/")
        template_id = templates.json()[0]["id"]
        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        teacher_project_response = client.post(
            "/api/projects/",
            data={"name": unique_name("teacher_proj"), "template_id": str(template_id)},
        )
        assert_status(teacher_project_response, 201)
        teacher_project = teacher_project_response.json()["id"]
        add_students(client, teacher_project, ["老師的學生"])

        # 主管：preview 只看得到管轄老師的專案
        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        preview = client.get("/api/roster/semester-export", params={"period_ids": [period["id"]]})
        assert_status(preview, 200)
        child_names = {group["name"] for group in preview.json()["children"]}
        assert "老師的學生" in child_names
        assert "管理員的學生" not in child_names

        # 匯出、補渲染、名冊操作對主管一律 403
        download = client.get(
            "/api/roster/semester-export/download", params={"period_ids": [period["id"]]}
        )
        assert_status(download, 403)
        render_missing = client.post(
            "/api/roster/semester-export/render-missing", json={"period_ids": [period["id"]]}
        )
        assert_status(render_missing, 403)


def test_teacher_overview_excel_export():
    from openpyxl import load_workbook

    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project = create_period_template_project(client, period["id"])
        add_students(client, project, ["王小明", "李小華"])

        export = client.get(
            "/api/roster/teacher-overview/export", params={"period_ids": [period["id"]]}
        )
        assert_status(export, 200)
        assert export.headers["content-type"].startswith("application/vnd.openxmlformats")

        workbook = load_workbook(BytesIO(export.content))
        assert workbook.sheetnames == ["摘要", "明細"]
        summary_rows = list(workbook["摘要"].iter_rows(values_only=True))
        assert summary_rows[0] == ("老師", "專案數", "學生數")
        assert any(row[2] == 2 for row in summary_rows[1:])  # admin 的兩位學生

        detail_rows = list(workbook["明細"].iter_rows(values_only=True))
        assert detail_rows[0] == ("老師", "期別", "專案（班級）", "學生")
        student_names = {row[3] for row in detail_rows[1:]}
        assert {"王小明", "李小華"} <= student_names


def test_render_missing_fills_absent_pdfs(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project = create_period_template_project(client, period["id"])
        students = add_students(client, project, ["王小明", "李小華"])
        # 只給王小明照片；兩人都未渲染
        photo = client.post(
            f"/api/projects/{project}/students/{students['王小明']}/pages/0/photos/1",
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo, 200)

        before = client.get("/api/roster/semester-export", params={"period_ids": [period["id"]]})
        assert all(
            not entry["has_pdf"]
            for group in before.json()["children"]
            for entry in group["entries"]
        )

        render_missing = client.post(
            "/api/roster/semester-export/render-missing", json={"period_ids": [period["id"]]}
        )
        assert_status(render_missing, 200)
        result = render_missing.json()
        assert result["rendered"] == 2
        assert result["errors"] == []

        after = client.get("/api/roster/semester-export", params={"period_ids": [period["id"]]})
        assert all(
            entry["has_pdf"]
            for group in after.json()["children"]
            for entry in group["entries"]
        )

        # 再跑一次：已全數渲染，rendered=0（冪等）
        rerun = client.post(
            "/api/roster/semester-export/render-missing", json={"period_ids": [period["id"]]}
        )
        assert_status(rerun, 200)
        assert rerun.json()["rendered"] == 0


def test_semester_export_zip_structure(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        period_a = create_active_period(client)
        period_b = create_active_period(client)
        project_a = create_period_template_project(client, period_a["id"])
        project_b = create_period_template_project(client, period_b["id"])

        students_a = add_students(client, project_a, ["王小明", "李小華"])
        students_b = add_students(client, project_b, ["王小明"])

        # 王小明兩期都渲染；李小華不渲染（應出現在匯出說明）
        for project_id, student_id in (
            (project_a, students_a["王小明"]),
            (project_b, students_b["王小明"]),
        ):
            photo = client.post(
                f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
                files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
            )
            assert_status(photo, 200)
            render = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
            assert_status(render, 200)

        # 老師手動刪除王小明期1 的第 1 頁 → 匯出說明應標註缺頁
        skip_response = client.patch(
            f"/api/projects/{project_a}/students/{students_a['王小明']}/pages/0/skip",
            json={"skip": True},
        )
        assert_status(skip_response, 200)

        download = client.get(
            "/api/roster/semester-export/download",
            params={"period_ids": [period_a["id"], period_b["id"]], "mode": "print"},
        )
        assert_status(download, 200)
        assert download.headers["content-type"] == "application/zip"

        with ZipFile(BytesIO(download.content)) as zip_archive:
            entry_names = zip_archive.namelist()
            manifest = zip_archive.read("匯出說明.txt").decode("utf-8")
        # 結構：孩子/期別_孩子.pdf（期別依所選順序排列）
        ming_entries = sorted(name for name in entry_names if name.startswith("王小明/"))
        assert len(ming_entries) == 2
        assert ming_entries[0] == f"王小明/{period_a['name']}_王小明.pdf"
        assert ming_entries[1] == f"王小明/{period_b['name']}_王小明.pdf"
        # 未渲染的李小華不進 ZIP，但列在匯出說明；班級對照含兩位孩子
        assert not any(name.startswith("李小華/") for name in entry_names)
        assert "【班級對照】" in manifest
        assert "李小華" in manifest and "尚未渲染" in manifest
        # 缺頁備註：王小明期1 老師刪除了第 1 頁
        assert "缺頁備註" in manifest
        assert "老師刪除了第 1 頁" in manifest

        # roster_child_ids 篩選：只勾李小華 → ZIP 不含王小明
        hua_child_id = roster_child_id_of(students_a["李小華"])
        filtered = client.get(
            "/api/roster/semester-export/download",
            params={
                "period_ids": [period_a["id"], period_b["id"]],
                "mode": "print",
                "roster_child_ids": [hua_child_id],
            },
        )
        assert_status(filtered, 200)
        with ZipFile(BytesIO(filtered.content)) as zip_archive:
            filtered_names = zip_archive.namelist()
        assert not any("/王小明/" in name for name in filtered_names)
