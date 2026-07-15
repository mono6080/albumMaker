"""Deprecated template page adapters 的精簡相容契約。"""

from tests.helpers import assert_status, login, smoke_layout, started_client, unique_name


def test_legacy_page_add_layout_delete_adapters_remain_compatible():
    with started_client() as client:
        login(client)
        template_response = client.post(
            "/api/templates/",
            data={"name": unique_name("legacy-page-template")},
        )
        assert_status(template_response, 200)
        template_id = template_response.json()["id"]

        add_response = client.post(f"/api/templates/{template_id}/pages")
        assert_status(add_response, 200)
        page_id = add_response.json()["id"]

        layout_response = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            json=smoke_layout(),
        )
        assert_status(layout_response, 200)
        assert layout_response.json() == {"ok": True}

        delete_response = client.delete(f"/api/templates/{template_id}/pages/{page_id}")
        assert_status(delete_response, 200)
        assert delete_response.json() == {"ok": True}

        template_detail = client.get(f"/api/templates/{template_id}")
        assert_status(template_detail, 200)
        assert template_detail.json()["pages"] == []
