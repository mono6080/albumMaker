"""期別改名要傳到老師看得到的地方。

老師端一律讀 `semester_periods.period_name_snapshot`（進度總覽、工作格、學期匯出），
而期別列表讀 `template_periods.name`。只改後者的話，同一個期別在兩個端點會顯示不同
名字，而且老師那邊永遠停在舊名——2026-08-04 把演練用的「115上-infant」改成正式的
「202608」時就是這樣：期別列表變了，學期與工作格沒變。
"""
from tests.helpers import assert_status, login, started_client, unique_name


def _current_semester_periods(client):
    response = client.get("/api/organization/semesters")
    assert_status(response, 200)
    current = next(row for row in response.json() if row["is_current"])
    return {period["name"] for period in current["periods"]}


def test_renaming_a_period_updates_what_teachers_see():
    with started_client() as client:
        login(client)
        original = unique_name("period")
        created = client.post(
            "/api/templates/periods",
            data={"name": original, "department": "academy", "status": "active"},
        )
        assert_status(created, 200)
        period_id = created.json()["id"]
        assert original in _current_semester_periods(client), "新建的期別應掛上目前學期"

        renamed = client.patch(
            f"/api/templates/periods/{period_id}", data={"name": "202608"}
        )

        assert_status(renamed, 200)
        assert renamed.json()["name"] == "202608"
        names = _current_semester_periods(client)
        assert "202608" in names, "學期那邊也要看到新名字"
        assert original not in names, f"舊名字不該留著：{names}"


def test_changing_only_the_status_leaves_the_name_alone():
    """只改狀態時不要順手把名稱洗掉——PATCH 的欄位是各自獨立的。"""
    with started_client() as client:
        login(client)
        original = unique_name("period")
        created = client.post(
            "/api/templates/periods",
            data={"name": original, "department": "academy", "status": "active"},
        )
        assert_status(created, 200)
        period_id = created.json()["id"]

        updated = client.patch(
            f"/api/templates/periods/{period_id}", data={"status": "archived"}
        )

        assert_status(updated, 200)
        assert updated.json()["name"] == original
        assert original in _current_semester_periods(client)
