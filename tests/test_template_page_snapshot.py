from copy import deepcopy

from tests.helpers import (
    append_template_page_with_layout,
    assert_status,
    create_template_with_page,
    login,
    smoke_layout,
    started_client,
    unique_name,
)


def _add_page_with_layout(client, template_id: int, layout: dict) -> int:
    return append_template_page_with_layout(client, template_id, layout)


def _template_pages(client, template_id: int) -> list[dict]:
    response = client.get(f"/api/templates/{template_id}")
    assert_status(response, 200)
    return response.json()["pages"]


def _template_revision(client, template_id: int) -> int:
    response = client.get(f"/api/templates/{template_id}")
    assert_status(response, 200)
    return response.json()["revision"]


def _layout_with_text(text: str) -> dict:
    layout = smoke_layout()
    layout["text_labels"][0]["text"] = text
    return layout


def test_page_snapshot_atomically_updates_adds_deletes_and_reorders():
    with started_client() as client:
        login(client)
        template_id, first_page_id = create_template_with_page(client)
        second_page_id = _add_page_with_layout(client, template_id, _layout_with_text("第二頁舊內容"))
        third_page_id = _add_page_with_layout(client, template_id, _layout_with_text("第三頁待刪除"))

        first_layout = _layout_with_text("第一頁已更新")
        second_layout = _layout_with_text("第二頁已更新")
        new_layout = _layout_with_text("新增頁內容")
        response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id, second_page_id, third_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {
                        "id": second_page_id,
                        "client_id": "persisted-second",
                        "layout": second_layout,
                    },
                    {
                        "id": first_page_id,
                        "client_id": "persisted-first",
                        "layout": first_layout,
                    },
                    {
                        "client_id": "draft-new-page",
                        "layout": new_layout,
                    },
                ],
            },
        )
        assert_status(response, 200)

        saved_pages = response.json()["pages"]
        assert [page["page_number"] for page in saved_pages] == [0, 1, 2]
        assert saved_pages[0]["id"] == second_page_id
        assert saved_pages[0]["client_id"] == "persisted-second"
        assert saved_pages[0]["layout"]["text_labels"][0]["text"] == "第二頁已更新"
        assert saved_pages[1]["id"] == first_page_id
        assert saved_pages[1]["client_id"] == "persisted-first"
        assert saved_pages[1]["layout"]["text_labels"][0]["text"] == "第一頁已更新"
        assert saved_pages[2]["id"] not in {first_page_id, second_page_id, third_page_id}
        assert saved_pages[2]["client_id"] == "draft-new-page"
        assert saved_pages[2]["layout"]["text_labels"][0]["text"] == "新增頁內容"

        persisted_pages = _template_pages(client, template_id)
        assert [page["id"] for page in persisted_pages] == [page["id"] for page in saved_pages]
        assert [page["page_number"] for page in persisted_pages] == [0, 1, 2]
        assert third_page_id not in {page["id"] for page in persisted_pages}
        assert [page["layout"]["text_labels"][0]["text"] for page in persisted_pages] == [
            "第二頁已更新",
            "第一頁已更新",
            "新增頁內容",
        ]


def test_invalid_page_snapshot_rolls_back_every_change():
    with started_client() as client:
        login(client)
        template_id, first_page_id = create_template_with_page(client)
        second_page_id = _add_page_with_layout(client, template_id, _layout_with_text("第二頁原始內容"))
        before_pages = deepcopy(_template_pages(client, template_id))
        invalid_layout = _layout_with_text("不可寫入")
        invalid_layout["text_bubbles"] = [{"id": 99}]

        response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id, second_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"id": first_page_id, "layout": _layout_with_text("也不可寫入")},
                    {"client_id": "invalid-new-page", "layout": invalid_layout},
                ],
            },
        )
        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "removed_layout_element"
        assert _template_pages(client, template_id) == before_pages


def test_stale_page_snapshot_returns_conflict_without_mutation():
    with started_client() as client:
        login(client)
        template_id, first_page_id = create_template_with_page(client)
        stale_expected_ids = [first_page_id]
        second_page_id = _add_page_with_layout(client, template_id, _layout_with_text("並行新增頁"))
        before_pages = deepcopy(_template_pages(client, template_id))

        response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": stale_expected_ids,
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"id": first_page_id, "layout": _layout_with_text("過期修改")},
                ],
            },
        )
        assert_status(response, 409)
        detail = response.json()["detail"]
        assert detail["code"] == "template_page_structure_changed"
        assert detail["expected_page_ids"] == stale_expected_ids
        assert detail["actual_page_ids"] == [first_page_id, second_page_id]
        assert _template_pages(client, template_id) == before_pages


def test_page_snapshot_rejects_foreign_and_duplicate_references_without_mutation():
    with started_client() as client:
        login(client)
        template_id, first_page_id = create_template_with_page(client)
        other_template_id, foreign_page_id = create_template_with_page(
            client,
            name=unique_name("foreign_template"),
        )
        before_pages = deepcopy(_template_pages(client, template_id))
        foreign_before_pages = deepcopy(_template_pages(client, other_template_id))

        foreign_response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"id": foreign_page_id, "layout": _layout_with_text("外部頁面")},
                ],
            },
        )
        assert_status(foreign_response, 422)
        assert foreign_response.json()["detail"]["code"] == "invalid_template_page_snapshot"

        duplicate_id_response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"id": first_page_id, "layout": _layout_with_text("重複一")},
                    {"id": first_page_id, "layout": _layout_with_text("重複二")},
                ],
            },
        )
        assert_status(duplicate_id_response, 422)
        assert duplicate_id_response.json()["detail"]["code"] == "invalid_template_page_snapshot"

        duplicate_client_response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"client_id": "same-client-id", "layout": _layout_with_text("新增一")},
                    {"client_id": "same-client-id", "layout": _layout_with_text("新增二")},
                ],
            },
        )
        assert_status(duplicate_client_response, 422)
        assert duplicate_client_response.json()["detail"]["code"] == "invalid_template_page_snapshot"

        duplicate_expected_response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [first_page_id, first_page_id],
                "expected_revision": _template_revision(client, template_id),
                "pages": [
                    {"id": first_page_id, "layout": _layout_with_text("重複預期")},
                ],
            },
        )
        assert_status(duplicate_expected_response, 422)
        assert duplicate_expected_response.json()["detail"]["code"] == "invalid_template_page_snapshot"

        assert _template_pages(client, template_id) == before_pages
        assert _template_pages(client, other_template_id) == foreign_before_pages
