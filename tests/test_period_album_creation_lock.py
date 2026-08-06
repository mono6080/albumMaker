"""期別建立相本鎖：取代「只能在目前正式學期建立相本」的硬閘。

契約見 docs/specs/period-album-creation-lock-v1.md。這裡釘住三件事：鎖本身的
開關語意、學期結束後未鎖期別仍可補建，以及補建用的名冊與編制 carryover 判準。
"""

from database import (
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomMember,
    ClassroomTeacher,
    Semester,
    SemesterPeriod,
    SessionLocal,
)
from tests.helpers import (
    USER_PASSWORD,
    _create_classroom_with_lead,
    _find_classroom_work_slot_id,
    assert_status,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _create_active_template(client, department: str = "infant") -> int:
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("lock_period"),
            "department": department,
            "status": "active",
        },
    )
    assert_status(period_response, 200)
    return create_template_with_page(
        client,
        period_id=period_response.json()["id"],
    )[0]


def _setup_classroom(client, student_names=None):
    template_id = _create_active_template(client)
    classroom_id, lead_teacher_id, _ = _create_classroom_with_lead(
        client,
        template_id,
        student_names=student_names or [unique_name("lock_child")],
    )
    work_slot_id = _find_classroom_work_slot_id(client, classroom_id, template_id)
    work_slot = _work_slot(client, work_slot_id)
    return {
        "template_id": template_id,
        "classroom_id": classroom_id,
        "lead_teacher_id": lead_teacher_id,
        "work_slot_id": work_slot_id,
        "semester_id": work_slot["semester_id"],
        "semester_period_id": work_slot["semester_period_id"],
    }


def _work_slot(client, work_slot_id):
    overview = client.get("/api/organization/overview")
    assert_status(overview, 200)
    return next(
        slot for slot in overview.json()["work_slots"] if slot["id"] == work_slot_id
    )


def _active_members(client, classroom_id):
    overview = client.get("/api/organization/overview")
    assert_status(overview, 200)
    return next(
        classroom["members"]
        for campus in overview.json()["campuses"]
        for classroom in campus["classrooms"]
        if classroom["id"] == classroom_id
    )


def _teacher_username(client, teacher_id: int) -> str:
    return next(
        user["username"]
        for user in client.get("/api/users/").json()
        if user["id"] == teacher_id
    )


def _set_lock(client, setup, locked: bool):
    return client.patch(
        f"/api/organization/semesters/{setup['semester_id']}"
        f"/periods/{setup['semester_period_id']}",
        json={"album_creation_locked": locked},
    )


def _create_album(client, setup, *, name=None, roster_child_ids=None):
    body = {
        "name": name or unique_name("lock_album"),
        "template_id": setup["template_id"],
        "work_slot_id": setup["work_slot_id"],
        "owner_id": setup["lead_teacher_id"],
    }
    if roster_child_ids is not None:
        body["roster_child_ids"] = roster_child_ids
    return client.post(
        f"/api/organization/classrooms/{setup['classroom_id']}/projects",
        json=body,
    )


def _close_semester_like_term_apply(
    classroom_id: int,
    *,
    member_end_reasons: dict[str, str] | None = None,
):
    """模擬套用編班的結果：先結束名冊與編制，再把學期關掉。

    順序不能顛倒——closed 學期的 classroom_members / classroom_teachers 由 trigger
    凍結，先關學期就再也改不動了。`member_end_reasons` 依學生姓名指定結束原因，
    未指定者一律 `term_reassignment`。
    """
    from database import utc_now

    db = SessionLocal()
    try:
        classroom = db.get(Classroom, classroom_id)
        applied_at = utc_now()
        for member in classroom.roster_members:
            if member.ended_at is not None:
                continue
            member.ended_at = applied_at
            member.end_reason = (member_end_reasons or {}).get(
                member.roster_child.name, "term_reassignment"
            )
        for assignment in classroom.teacher_assignments:
            if assignment.ended_at is None:
                assignment.ended_at = applied_at
                assignment.end_reason = "term_reassignment"
        db.flush()
        db.get(Semester, classroom.semester_id).status = "closed"
        db.get(Semester, classroom.semester_id).closed_at = applied_at
        db.commit()
    finally:
        db.close()


def test_locking_a_period_blocks_new_albums_and_unlocking_restores_them():
    """鎖住一期就不能再開新相本；解鎖之後可以，既有相本不受影響。"""
    with started_client() as client:
        login(client)
        first_child = unique_name("鎖前收錄")
        second_child = unique_name("解鎖後收錄")
        setup = _setup_classroom(
            client, student_names=[first_child, second_child]
        )
        child_id_by_name = {
            member["name"]: member["roster_child_id"]
            for member in _active_members(client, setup["classroom_id"])
        }

        first = _create_album(
            client, setup, roster_child_ids=[child_id_by_name[first_child]]
        )
        assert_status(first, 201)
        existing_project_id = first.json()["id"]

        assert_status(_set_lock(client, setup, True), 200)
        blocked = _create_album(client, setup)
        assert_status(blocked, 409)
        assert blocked.json()["detail"]["code"] == "work_slot_period_locked"

        # 鎖只擋「開新相本」：既有那本照樣讀得到、改得動
        assert_status(client.get(f"/api/projects/{existing_project_id}"), 200)
        assert_status(
            client.patch(
                f"/api/projects/{existing_project_id}",
                data={"name": unique_name("鎖住後仍可改名")},
            ),
            200,
        )
        assert _work_slot(client, setup["work_slot_id"])["can_create_project"] is False

        assert_status(_set_lock(client, setup, False), 200)
        second = _create_album(
            client, setup, roster_child_ids=[child_id_by_name[second_child]]
        )
        assert_status(second, 201)
        reopened_slot = _work_slot(client, setup["work_slot_id"])
        assert reopened_slot["can_create_project"] is True
        assert reopened_slot["album_creation_locked_at"] is None


def test_repeated_lock_and_unlock_are_idempotent():
    """重複上鎖不覆寫既有時間戳，重複解鎖也不報錯。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)

        first_lock = _set_lock(client, setup, True)
        assert_status(first_lock, 200)
        locked_at = first_lock.json()["album_creation_locked_at"]
        assert locked_at is not None

        second_lock = _set_lock(client, setup, True)
        assert_status(second_lock, 200)
        assert second_lock.json()["album_creation_locked_at"] == locked_at

        assert_status(_set_lock(client, setup, False), 200)
        repeated_unlock = _set_lock(client, setup, False)
        assert_status(repeated_unlock, 200)
        assert repeated_unlock.json()["album_creation_locked_at"] is None


def test_only_admin_can_toggle_the_lock():
    """切鎖是 admin 的決定；老師與主管都不行。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        supervisor, supervisor_password = create_user(client, "supervisor")

        client.cookies.clear()
        login(client, supervisor["username"], supervisor_password)
        assert_status(_set_lock(client, setup, True), 403)


def test_unlocked_period_still_accepts_albums_after_the_semester_closed():
    """學期結束不再封死：未鎖的期別仍可由原任主教補開漏掉的那一本。"""
    with started_client() as client:
        login(client)
        child_name = unique_name("lock_child")
        setup = _setup_classroom(client, student_names=[child_name])
        lead_username = _teacher_username(client, setup["lead_teacher_id"])
        _close_semester_like_term_apply(setup["classroom_id"])

        # 原任主教自己補建：編制只因為學期輪替而結束，權限仍在
        client.cookies.clear()
        login(client, lead_username, USER_PASSWORD)
        late_album = _create_album(client, setup, name=unique_name("補建相本"))
        assert_status(late_album, 201)
        # 名冊 carryover：學期結束時仍在班的孩子照樣收得到
        assert [
            student["name"] for student in late_album.json()["students"]
        ] == [child_name]

        # 鎖上之後連 admin 也開不了新的
        client.cookies.clear()
        login(client)
        assert_status(_set_lock(client, setup, True), 200)
        blocked = _create_album(client, setup)
        assert_status(blocked, 409)
        assert blocked.json()["detail"]["code"] == "work_slot_period_locked"


def test_replaced_lead_cannot_create_albums_after_the_semester_closed():
    """被換掉的主教不因為學期結束而拿回建立權——認的是結束原因，不是曾經任教。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        replaced_lead_username = _teacher_username(client, setup["lead_teacher_id"])
        successor, _ = create_user(client, "teacher")
        # 換主教的端點會把舊指派結束成 assignment_replaced，正是要擋的那種結束
        assert_status(
            client.put(
                f"/api/organization/classrooms/{setup['classroom_id']}/teachers",
                json={"teachers": [{"teacher_id": successor["id"], "duty": "lead"}]},
            ),
            200,
        )
        _close_semester_like_term_apply(setup["classroom_id"])

        client.cookies.clear()
        login(client, replaced_lead_username, USER_PASSWORD)
        assert_status(_create_album(client, setup), 403)


def test_late_creation_roster_follows_carryover_reasons():
    """補建收錄的是「學期結束時仍在這個班」的孩子。

    期中轉出（transfer）與期中離園（departed）的孩子不算——他們在該學期的歸屬
    已經不是這個班；學期末離園（term_departed）整期在籍，要收。
    """
    with started_client() as client:
        login(client)
        stayed = unique_name("留到期末")
        term_departed = unique_name("期末離園")
        mid_term_departed = unique_name("期中離園")
        setup = _setup_classroom(
            client,
            student_names=[stayed, term_departed, mid_term_departed],
        )
        member_id_by_name = {
            member["name"]: member["id"]
            for member in _active_members(client, setup["classroom_id"])
        }

        # 期中離園走正式端點，結束原因是 departed
        assert_status(
            client.patch(
                f"/api/organization/classrooms/{setup['classroom_id']}"
                f"/members/{member_id_by_name[mid_term_departed]}",
                json={"status": "ended", "end_reason": "departed"},
            ),
            200,
        )
        _close_semester_like_term_apply(
            setup["classroom_id"],
            member_end_reasons={term_departed: "term_departed"},
        )

        late_album = _create_album(client, setup, name=unique_name("補建全班"))
        assert_status(late_album, 201)
        assert sorted(
            student["name"] for student in late_album.json()["students"]
        ) == sorted([stayed, term_departed])


def test_archived_template_period_no_longer_blocks_album_creation():
    """期別退役與否由建立鎖決定，不再由設計端的 template_periods.status 決定。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        template = client.get(f"/api/templates/{setup['template_id']}").json()

        assert_status(
            client.patch(
                f"/api/templates/periods/{template['period_id']}",
                data={"status": "archived"},
            ),
            200,
        )
        assert_status(_create_album(client, setup), 201)


def test_draft_semester_cannot_receive_albums_even_when_the_period_is_unlocked():
    """草稿學期不是「還沒鎖」，是名冊還在編排中，根本不能開相本。

    目前草稿學期長不出工作格，所以這裡直接塞一格進去，驗的是那條防線本身還在。
    """
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)

        db = SessionLocal()
        try:
            campus_id = db.get(Classroom, setup["classroom_id"]).campus_id
            draft_semester = Semester(
                label=unique_name("草稿學期"),
                status="draft",
                created_by_name_snapshot="admin",
            )
            db.add(draft_semester)
            db.commit()
            draft_semester_id = draft_semester.id
        finally:
            db.close()

        # 期別與模板都合法且屬於這個草稿學期，唯一不合法的只有學期狀態
        draft_period = client.post(
            "/api/templates/periods",
            data={
                "name": unique_name("草稿期別"),
                "department": "infant",
                "status": "active",
                "semester_id": str(draft_semester_id),
            },
        )
        assert_status(draft_period, 200)
        draft_template_id = create_template_with_page(
            client, period_id=draft_period.json()["id"]
        )[0]

        db = SessionLocal()
        try:
            draft_semester_period = (
                db.query(SemesterPeriod)
                .filter(SemesterPeriod.semester_id == draft_semester_id)
                .one()
            )
            draft_classroom = Classroom(
                semester_id=draft_semester_id,
                campus_id=campus_id,
                department="infant",
                name=unique_name("草稿班"),
            )
            db.add(draft_classroom)
            db.flush()
            draft_slot = ClassPeriodWorkSlot(
                classroom_id=draft_classroom.id,
                semester_period_id=draft_semester_period.id,
            )
            db.add(draft_slot)
            db.commit()
            draft_setup = {
                **setup,
                "template_id": draft_template_id,
                "classroom_id": draft_classroom.id,
                "work_slot_id": draft_slot.id,
            }
        finally:
            db.close()

        blocked = _create_album(client, draft_setup)
        assert_status(blocked, 409)
        assert blocked.json()["detail"]["code"] == "work_slot_term_not_open"


def test_admin_my_classrooms_does_not_accumulate_closed_terms():
    """admin 的「我的班級」只給目前學期；補建入口在園所設定，不在這裡堆歷屆。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        _close_semester_like_term_apply(setup["classroom_id"])

        my_classrooms = client.get("/api/organization/my-classrooms")
        assert_status(my_classrooms, 200)
        assert setup["classroom_id"] not in {
            classroom["id"] for classroom in my_classrooms.json()["classrooms"]
        }

        # 但園所設定仍然看得到那一格，否則 admin 就沒有補建入口了
        overview = client.get("/api/organization/overview")
        assert_status(overview, 200)
        assert setup["work_slot_id"] in {
            work_slot["id"] for work_slot in overview.json()["work_slots"]
        }


def test_upgrade_locks_closed_semester_periods_but_leaves_current_ones_open():
    """升級當下：已結束學期的期別預設鎖上，進行中學期的維持開放。

    這樣上線行為與升級前一致（舊學期本來就不能開新相本），不會讓全園老師突然多出
    歷屆班級與補建入口。要補做哪一期由 admin 明確解鎖。
    """
    from database import TemplatePeriod, engine, utc_now
    from migrations import _backfill_closed_semester_period_locks

    with started_client() as client:
        login(client)
        current_setup = _setup_classroom(client)

        # 另一屆：已結束的學期與它自己的期別（期別對學期是 1:1，不能共用）
        db = SessionLocal()
        try:
            closed_semester = Semester(
                label=unique_name("上一屆"),
                status="closed",
                closed_at=utc_now(),
                created_by_name_snapshot="admin",
            )
            retired_period = TemplatePeriod(
                department="infant",
                name=unique_name("上一屆期別"),
                status="active",
            )
            db.add_all([closed_semester, retired_period])
            db.flush()
            closed_semester_period = SemesterPeriod(
                semester_id=closed_semester.id,
                template_period_id=retired_period.id,
                period_name_snapshot=retired_period.name,
                department="infant",
                position=0,
            )
            db.add(closed_semester_period)
            db.commit()
            closed_semester_period_id = closed_semester_period.id
        finally:
            db.close()

        # 升級時對既有資料跑的那一步（欄位剛建立、全部還是 NULL 的狀態）
        with engine.connect() as connection:
            _backfill_closed_semester_period_locks(connection)
            connection.commit()

        db = SessionLocal()
        try:
            closed_period = db.get(SemesterPeriod, closed_semester_period_id)
            current_period = db.get(
                SemesterPeriod, current_setup["semester_period_id"]
            )
            assert closed_period.album_creation_locked_at is not None, (
                "已結束學期的期別要預設鎖上，否則上線瞬間全部開放"
            )
            # 不是某個人按下的，所以沒有 actor
            assert closed_period.album_creation_locked_by_id is None
            assert closed_period.album_creation_locked_by_name_snapshot is None
            assert current_period.album_creation_locked_at is None, (
                "進行中學期不該被回填鎖上"
            )
        finally:
            db.close()

        # 進行中學期照常可以開新相本
        assert_status(_create_album(client, current_setup), 201)


def test_rerunning_migrations_does_not_relock_a_period_admin_reopened():
    """升級回填只做一次：admin 解鎖某一期之後，重跑 migration 不可以把它鎖回去。

    這是本 migration 冪等性的實質內容——「不重複加欄位」是最低標準，真正會傷人的是
    每次部署都把 admin 的決定覆蓋掉。
    """
    from migrations import run_migrations

    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        _close_semester_like_term_apply(setup["classroom_id"])

        # 已結束學期的期別在升級時被預設鎖上，admin 為了補建把它解鎖
        assert_status(_set_lock(client, setup, False), 200)
        run_migrations()

        db = SessionLocal()
        try:
            semester_period = db.get(SemesterPeriod, setup["semester_period_id"])
            assert semester_period.album_creation_locked_at is None, (
                "重跑 migration 不該覆蓋 admin 的解鎖決定"
            )
        finally:
            db.close()

        assert_status(_create_album(client, setup), 201)


def test_closed_term_roster_and_staffing_stay_frozen_during_late_creation():
    """補建不得寫到已結束學期的名冊或編制——那兩張表由 trigger 凍結。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client)
        _close_semester_like_term_apply(setup["classroom_id"])

        db = SessionLocal()
        try:
            before_members = db.query(ClassroomMember).filter(
                ClassroomMember.classroom_id == setup["classroom_id"]
            ).count()
            before_assignments = db.query(ClassroomTeacher).filter(
                ClassroomTeacher.classroom_id == setup["classroom_id"]
            ).count()
        finally:
            db.close()

        assert_status(_create_album(client, setup), 201)

        db = SessionLocal()
        try:
            assert db.query(ClassroomMember).filter(
                ClassroomMember.classroom_id == setup["classroom_id"]
            ).count() == before_members
            assert db.query(ClassroomTeacher).filter(
                ClassroomTeacher.classroom_id == setup["classroom_id"]
            ).count() == before_assignments
        finally:
            db.close()
