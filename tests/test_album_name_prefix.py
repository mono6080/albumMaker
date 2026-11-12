"""相本全名＝模板名稱＋自訂名稱，由伺服器在建立時組好。

停在舊版畫面的瀏覽器會送出沒有前綴的名稱（2026-11 安平校九階A/B）；新版畫面若老師
又打了一次模板名稱則會重複。兩種都要在伺服器端收斂成「模板名稱 自訂名稱」。
前端鏡像 frontend/src/utils/albumName.js 由 frontend/tests/unit/album-name.test.mjs 釘住。
"""

from database import Project, SessionLocal, Template
from services.organization_service import compose_album_name
from tests.helpers import assert_status, login, started_client, unique_name
from tests.test_period_album_creation_lock import (
    _active_members,
    _create_album,
    _setup_classroom,
)

TEMPLATE = "2026-08~10 9階 我的身體 副本"


def test_compose_adds_missing_prefix():
    assert compose_album_name(TEMPLATE, " 安平校-九階A ") == f"{TEMPLATE} 安平校-九階A"


def test_compose_keeps_a_single_prefix():
    assert compose_album_name(TEMPLATE, f"{TEMPLATE} 安平校-九階A") == f"{TEMPLATE} 安平校-九階A"
    assert (
        compose_album_name(TEMPLATE, f"{TEMPLATE} {TEMPLATE} 安平校-九階A")
        == f"{TEMPLATE} 安平校-九階A"
    )
    assert compose_album_name(TEMPLATE, TEMPLATE) == TEMPLATE


def test_compose_does_not_strip_a_partial_match():
    # 「我的身體」不是「我的身體 副本」：只是開頭相像時整串保留，前面照樣補前綴
    submitted = "2026-08~10 9階 我的身體 安平校-九階C"
    assert compose_album_name(TEMPLATE, submitted) == f"{TEMPLATE} {submitted}"
    # 模板名稱後面直接接字（沒有空白）也不算前綴
    assert compose_album_name("2026-10 6階", "2026-10 6階美洲") == "2026-10 6階 2026-10 6階美洲"


def _template_name(template_id: int) -> str:
    with SessionLocal() as db:
        return db.get(Template, template_id).name


def _project_name(project_id: int) -> str:
    with SessionLocal() as db:
        return db.get(Project, project_id).name


def test_old_client_name_without_prefix_gets_template_prefix():
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        template_name = _template_name(setup["template_id"])
        custom = unique_name("安平校-九階A")

        created = _create_album(client, setup, name=custom)

    assert_status(created, 201)
    assert created.json()["name"] == f"{template_name} {custom}"
    assert _project_name(created.json()["id"]) == f"{template_name} {custom}"


def test_repeated_prefix_is_collapsed_and_correct_name_is_unchanged():
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client, student_names=[unique_name("甲"), unique_name("乙")])
        template_name = _template_name(setup["template_id"])
        custom = unique_name("安平校-七階A")
        first_child, second_child = (
            member["roster_child_id"] for member in _active_members(client, setup["classroom_id"])
        )

        doubled = _create_album(
            client, setup, name=f"{template_name} {template_name} {custom}",
            roster_child_ids=[first_child],
        )
        correct = _create_album(
            client, setup, name=f"{template_name} {custom}", roster_child_ids=[second_child],
        )

    assert_status(doubled, 201)
    assert_status(correct, 201)
    assert doubled.json()["name"] == f"{template_name} {custom}"
    assert correct.json()["name"] == f"{template_name} {custom}"


def test_prefix_that_pushes_name_over_the_limit_is_rejected():
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        template_name = _template_name(setup["template_id"])

        too_long = _create_album(client, setup, name="校" * (100 - len(template_name)))

    assert_status(too_long, 422)
