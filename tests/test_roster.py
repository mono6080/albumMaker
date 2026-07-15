# 名冊與學期彙整匯出測試
# 覆蓋：學生建立/改名的名冊自動連結、同名歧義待確認、link/merge 端點、
# 學期匯出預覽分組與 ZIP 下載結構

from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from tests.helpers import (
    assert_status,
    create_template_with_page,
    create_user,
    jpeg_bytes,
    login,
    revisioned_project_url,
    smoke_layout,
    started_client,
    unique_name,
    use_tmp_uploads,
)

from database import SessionLocal, Student
from services import semester_render_service
from services.teacher_overview_service import _summarize_student_progress


def create_active_period(client: TestClient, department: str = "infant") -> dict:
    response = client.post(
        "/api/templates/periods",
        data={"name": unique_name("period"), "department": department, "status": "active"},
    )
    assert_status(response, 200)
    return response.json()


def create_period_template_project(client: TestClient, period_id: int) -> int:
    """建立掛在指定期別下的模板（含一頁版型）與專案，回傳 project_id。"""
    template_id, _ = create_template_with_page(
        client,
        period_id=period_id,
    )

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
        assert summary_rows[0] == ("老師", "專案數", "已完成專案", "學生數", "照片已填/總格數", "空白文字格")
        assert any(row[3] == 2 for row in summary_rows[1:])  # admin 的兩位學生

        detail_rows = list(workbook["明細"].iter_rows(values_only=True))
        assert detail_rows[0] == ("老師", "期別", "專案（班級）", "學生", "照片已填", "照片總格", "空白文字格")
        student_names = {row[3] for row in detail_rows[1:]}
        assert {"王小明", "李小華"} <= student_names


def test_teacher_progress_includes_idle_teachers_and_photo_counts(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        supervisor, supervisor_password = create_user(client, "supervisor")
        managed_teacher, teacher_password = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])
        idle_teacher, _ = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])
        period = create_active_period(client)
        admin_project = create_period_template_project(client, period["id"])
        add_students(client, admin_project, ["管理員的學生"])
        templates = client.get("/api/templates/")
        template_id = templates.json()[0]["id"]

        # 管轄老師的專案：兩位學生、只有一格照片被填
        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        teacher_project_response = client.post(
            "/api/projects/",
            data={"name": unique_name("teacher_proj"), "template_id": str(template_id)},
        )
        assert_status(teacher_project_response, 201)
        teacher_project = teacher_project_response.json()["id"]
        students = add_students(client, teacher_project, ["王小明", "李小華"])
        photo = client.post(
            revisioned_project_url(
                client,
                teacher_project,
                f"/api/projects/{teacher_project}/students/{students['王小明']}/pages/0/photos/1",
            ),
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo, 200)

        # 主管視角：只看到管轄老師（含還沒開工的），看不到 admin 的專案
        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        progress = client.get("/api/roster/teacher-progress", params={"period_ids": [period["id"]]})
        assert_status(progress, 200)
        teachers = {teacher["user_id"]: teacher for teacher in progress.json()["teachers"]}
        assert idle_teacher["id"] in teachers
        assert teachers[idle_teacher["id"]]["projects"] == []
        student_names = {
            student["student_name"]
            for teacher in teachers.values()
            for project in teacher["projects"]
            for student in project["students"]
        }
        assert "管理員的學生" not in student_names

        managed_projects = teachers[managed_teacher["id"]]["projects"]
        assert len(managed_projects) == 1
        project_progress = managed_projects[0]
        # smoke_layout 每頁 1 照片格：2 位學生共 2 格、已填 1 格；預設文字非空 → 無空白格
        assert project_progress["photo_total"] == 2
        assert project_progress["photo_filled"] == 1
        assert project_progress["blank_text_count"] == 0
        progress_by_student = {
            student["student_name"]: student for student in project_progress["students"]
        }
        assert progress_by_student["王小明"]["photo_filled"] == 1
        assert progress_by_student["李小華"]["photo_filled"] == 0

        # 老師本人無權查看
        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        forbidden = client.get("/api/roster/teacher-progress", params={"period_ids": [period["id"]]})
        assert_status(forbidden, 403)


def test_teacher_progress_ignores_hidden_group_photos_and_texts():
    layout = smoke_layout()
    layout["photo_slots"].append({
        "id": 2,
        "x": 360,
        "y": 96,
        "width": 240,
        "height": 180,
    })
    layout["text_labels"].append({
        "id": 2,
        "x": 96,
        "y": 480,
        "width": 360,
        "height": 96,
        "text": "",
    })
    layout["group_contract"] = "nested-world-v2"
    layout["groups"] = [{
        "id": "hidden-progress",
        "z_index": 10,
        "selection_rotation": 0,
        "visible": False,
        "children": [
            {"type": "photo", "id": 2},
            {"type": "text", "id": 2},
        ],
    }]

    result = _summarize_student_progress(
        [{
            "page_index": 0,
            "photos": {"1": "visible.jpg", "2": "hidden.jpg"},
            "label_texts": {"2": ""},
        }],
        [layout],
        {},
    )

    assert result == (1, 1, 0)


def start_and_wait_render_job(client: TestClient, period_ids: list[int], timeout_seconds: float = 60) -> dict:
    """啟動補渲染 job 並輪詢到結束，回傳最終 job 狀態。"""
    import time

    start = client.post("/api/roster/semester-export/render-missing", json={"period_ids": period_ids})
    assert_status(start, 200)
    job_id = start.json()["job_id"]
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        progress = client.get(f"/api/roster/semester-export/render-missing/{job_id}")
        assert_status(progress, 200)
        state = progress.json()
        if state["status"] != "running":
            return state
        time.sleep(0.2)
    raise AssertionError("補渲染 job 逾時未完成")


def test_project_completion_locks_content_and_supervisor_reopens(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        supervisor, supervisor_password = create_user(client, "supervisor")
        managed_teacher, teacher_password = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])
        period = create_active_period(client)
        create_period_template_project(client, period["id"])  # 只為建立模板
        templates = client.get("/api/templates/")
        template_id = templates.json()[0]["id"]

        # 老師建專案、加學生、標記全班完成
        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        project_response = client.post(
            "/api/projects/",
            data={"name": unique_name("teacher_proj"), "template_id": str(template_id)},
        )
        assert_status(project_response, 201)
        project_id = project_response.json()["id"]

        # 空專案不可標記完成（一鎖名單就什麼都動不了）
        empty_complete = client.post(f"/api/projects/{project_id}/complete")
        assert_status(empty_complete, 400)

        students = add_students(client, project_id, ["王小明"])
        complete = client.post(f"/api/projects/{project_id}/complete")
        assert_status(complete, 200)
        assert complete.json()["completed_at"] is not None

        # 完成後：內容修改一律 403
        add_more = client.post(f"/api/projects/{project_id}/students/batch", json=["李小華"])
        assert_status(add_more, 403)
        rename = client.put(
            f"/api/projects/{project_id}/students/{students['王小明']}",
            data={"name": "王大明"},
        )
        assert_status(rename, 403)
        photo = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{students['王小明']}/pages/0/photos/1",
            ),
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo, 403)
        texts = client.put(
            revisioned_project_url(client, project_id, f"/api/projects/{project_id}/label_texts"),
            json={"0": {"1": "改字"}},
        )
        assert_status(texts, 403)
        skip = client.patch(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{students['王小明']}/pages/0/skip",
            ),
            json={"skip": True},
        )
        assert_status(skip, 403)

        # 渲染與下載不算內容修改，仍可執行
        render = client.post(f"/api/projects/{project_id}/students/{students['王小明']}/render")
        assert_status(render, 200)

        # 老師自己不能退回
        teacher_reopen = client.post(f"/api/projects/{project_id}/reopen")
        assert_status(teacher_reopen, 403)

        # 管轄主管視角：老師進度看得到 completed_at；退回後恢復可編輯
        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        progress = client.get("/api/roster/teacher-progress", params={"period_ids": [period["id"]]})
        assert_status(progress, 200)
        teacher_projects = {
            project["project_id"]: project
            for teacher in progress.json()["teachers"]
            for project in teacher["projects"]
        }
        assert teacher_projects[project_id]["completed_at"] is not None

        reopen = client.post(f"/api/projects/{project_id}/reopen")
        assert_status(reopen, 200)

        client.cookies.clear()
        login(client, managed_teacher["username"], teacher_password)
        add_after_reopen = client.post(f"/api/projects/{project_id}/students/batch", json=["李小華"])
        assert_status(add_after_reopen, 200)


def test_render_missing_fills_absent_pdfs(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project = create_period_template_project(client, period["id"])
        students = add_students(client, project, ["王小明", "李小華"])
        # 只給王小明照片；兩人都未渲染
        photo = client.post(
            revisioned_project_url(
                client,
                project,
                f"/api/projects/{project}/students/{students['王小明']}/pages/0/photos/1",
            ),
            files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(photo, 200)

        before = client.get("/api/roster/semester-export", params={"period_ids": [period["id"]]})
        assert all(
            not entry["has_pdf"]
            for group in before.json()["children"]
            for entry in group["entries"]
        )

        result = start_and_wait_render_job(client, [period["id"]])
        assert result["status"] == "done"
        assert result["total"] == 2
        assert result["done"] == 2
        assert result["rendered"] == 2
        assert result["errors"] == []

        after = client.get("/api/roster/semester-export", params={"period_ids": [period["id"]]})
        assert all(
            entry["has_pdf"]
            for group in after.json()["children"]
            for entry in group["entries"]
        )

        # 再跑一次：已全數渲染，rendered=0（冪等）
        rerun = start_and_wait_render_job(client, [period["id"]])
        assert rerun["status"] == "done"
        assert rerun["rendered"] == 0

        # 不存在的 job 回 404
        missing_job = client.get("/api/roster/semester-export/render-missing/nonexistent")
        assert_status(missing_job, 404)


def test_render_missing_keeps_partial_success_and_progress_after_one_failure(
    monkeypatch,
    tmp_path,
):
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        period = create_active_period(client)
        project_id = create_period_template_project(client, period["id"])
        student_ids = add_students(client, project_id, ["第一位失敗", "第二位成功"])

    rendered_students = []

    def render_one(project, student, requested_project_id, db):
        rendered_students.append(student.name)
        if student.id == student_ids["第一位失敗"]:
            raise RuntimeError("simulated single render failure")
        return {"pdf": "unused", "pages": 1}

    monkeypatch.setattr(
        semester_render_service,
        "render_and_save_student_album",
        render_one,
    )
    progress = []
    db = SessionLocal()
    try:
        result = semester_render_service.render_missing_semester_albums(
            db,
            [period["id"]],
            progress_callback=lambda done, total: progress.append((done, total)),
        )
    finally:
        db.close()

    assert rendered_students == ["第一位失敗", "第二位成功"]
    assert result["rendered"] == 1
    assert len(result["errors"]) == 1
    assert result["errors"][0]["student"] == "第一位失敗"
    assert result["errors"][0]["project"]
    assert result["errors"][0]["error"] == "產生失敗"
    assert progress == [(0, 2), (1, 2), (2, 2)]


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
                revisioned_project_url(
                    client,
                    project_id,
                    f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
                ),
                files={"file": ("smoke.jpg", jpeg_bytes(), "image/jpeg")},
            )
            assert_status(photo, 200)
            render = client.post(f"/api/projects/{project_id}/students/{student_id}/render")
            assert_status(render, 200)

        # 老師手動刪除王小明期1 的第 1 頁 → 匯出說明應標註缺頁
        skip_response = client.patch(
            revisioned_project_url(
                client,
                project_a,
                f"/api/projects/{project_a}/students/{students_a['王小明']}/pages/0/skip",
            ),
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
        # 結構：孩子/期別_孩子.pdf（期別名隨機生成，用集合比對不依賴排序）
        ming_entries = {name for name in entry_names if name.startswith("王小明/")}
        assert ming_entries == {
            f"王小明/{period_a['name']}_王小明.pdf",
            f"王小明/{period_b['name']}_王小明.pdf",
        }
        # 未渲染的李小華不進 ZIP，但列在匯出說明；班級對照含兩位孩子
        assert not any(name.startswith("李小華/") for name in entry_names)
        assert "【班級對照】" in manifest
        assert "李小華" in manifest and "尚未產生 PDF" in manifest
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
