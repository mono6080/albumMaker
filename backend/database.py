import os
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker


def utc_now() -> datetime:
    """回傳 SQLite 相容的 naive UTC；來源使用 timezone-aware API。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)

SQLALCHEMY_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite:///./album_maker.db"
)
def _set_sqlite_pragmas(dbapi_connection, connection_record):
    """SQLite 連線層設定。

    - foreign_keys：啟用外鍵約束（預設關閉）
    - WAL：寫入不再阻塞讀取——多人同時操作時（A 老師存檔、B 老師瀏覽）
      不會互相卡住；WAL 檔與主檔同目錄，備份時一併帶走
    - busy_timeout：罕見的寫寫衝突改為等待重試，而非立刻 database is locked
    - synchronous=NORMAL：WAL 模式下的建議值，斷電最多丟最後一個 checkpoint
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()

from sqlalchemy import event as _sa_event
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
_sa_event.listen(engine, "connect", _set_sqlite_pragmas)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=False, unique=True)
    display_name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    # 角色：admin | art_team | supervisor | teacher | none
    role = Column(String, nullable=False, default="none")
    # 密碼重設時遞增；JWT 的 ver 必須相同，讓既有登入狀態立即失效。
    auth_version = Column(Integer, nullable=False, default=0, server_default="0")
    ui_font_scale = Column(Float, nullable=False, default=1.0, server_default="1.0")
    created_at = Column(DateTime, default=utc_now)

    owned_projects = relationship("Project", back_populates="owner", foreign_keys="Project.owner_id")
    created_projects = relationship(
        "Project",
        back_populates="creator",
        foreign_keys="Project.created_by_id",
        passive_deletes=True,
    )
    classroom_teacher_assignments = relationship(
        "ClassroomTeacher",
        back_populates="teacher",
        foreign_keys="ClassroomTeacher.teacher_id",
        passive_deletes=True,
    )
    organization_supervisor_assignments = relationship(
        "OrganizationSupervisorAssignment",
        back_populates="supervisor",
        foreign_keys="OrganizationSupervisorAssignment.supervisor_id",
        passive_deletes=True,
    )
    project_editor_assignments = relationship(
        "ProjectEditorAssignment",
        back_populates="user",
        foreign_keys="ProjectEditorAssignment.user_id",
        passive_deletes=True,
    )
    comments = relationship("ProjectComment", back_populates="author")


class TemplatePeriod(Base):
    __tablename__ = "template_periods"
    id = Column(Integer, primary_key=True, index=True)
    department = Column(String, nullable=False)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="draft")
    created_at = Column(DateTime, default=utc_now)

    templates = relationship("Template", back_populates="period", order_by="Template.created_at.desc()")
    projects = relationship("Project", back_populates="template_period")
    semester_period = relationship(
        "SemesterPeriod",
        back_populates="template_period",
        uselist=False,
    )


class Template(Base):
    __tablename__ = "templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    period_id = Column(Integer, ForeignKey("template_periods.id"), nullable=True)
    # 每次會影響專案內容／畫面的模板儲存都遞增；用來防止舊編輯器覆寫新版，
    # 也供專案端立即換掉模板與預覽快取。
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    created_at = Column(DateTime, default=utc_now)
    period = relationship("TemplatePeriod", back_populates="templates")
    pages = relationship("TemplatePage", back_populates="template", cascade="all, delete-orphan", order_by="TemplatePage.page_number")
    projects = relationship("Project", back_populates="template")


class TemplatePage(Base):
    __tablename__ = "template_pages"
    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    page_number = Column(Integer, nullable=False)
    background_filename = Column(String, nullable=True)
    layout_json = Column(Text, nullable=False, default="{}")
    template = relationship("Template", back_populates="pages")


class Campus(Base):
    __tablename__ = "campuses"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="1")
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    classrooms = relationship(
        "Classroom",
        back_populates="campus",
        order_by="(Classroom.sort_order.is_(None), Classroom.sort_order, Classroom.id)",
    )
    supervisor_assignments = relationship(
        "OrganizationSupervisorAssignment",
        back_populates="campus",
        order_by="OrganizationSupervisorAssignment.started_at",
    )


class OrganizationSupervisorAssignment(Base):
    __tablename__ = "organization_supervisor_assignments"
    __table_args__ = (
        CheckConstraint(
            "department IS NULL OR department IN ('infant', 'academy')",
            name="ck_organization_supervisor_assignments_department",
        ),
        Index(
            "ux_organization_supervisor_active_campus",
            "campus_id",
            "supervisor_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL AND department IS NULL"),
        ),
        Index(
            "ux_organization_supervisor_active_department",
            "campus_id",
            "department",
            "supervisor_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL AND department IS NOT NULL"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    campus_id = Column(Integer, ForeignKey("campuses.id"), nullable=False)
    department = Column(String, nullable=True)
    supervisor_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    supervisor_name_snapshot = Column(String, nullable=False)
    started_at = Column(DateTime, nullable=False, default=utc_now)
    ended_at = Column(DateTime, nullable=True)
    end_reason = Column(Text, nullable=True)
    started_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_by_name_snapshot = Column(String, nullable=False)
    ended_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    ended_by_name_snapshot = Column(String, nullable=True)

    campus = relationship("Campus", back_populates="supervisor_assignments")
    supervisor = relationship(
        "User",
        back_populates="organization_supervisor_assignments",
        foreign_keys=[supervisor_id],
    )
    started_by = relationship("User", foreign_keys=[started_by_id])
    ended_by = relationship("User", foreign_keys=[ended_by_id])


class ClassroomMember(Base):
    __tablename__ = "classroom_members"
    id = Column(Integer, primary_key=True, index=True)
    classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id"),
        nullable=False,
    )
    roster_child_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    started_at = Column(DateTime, nullable=False, default=utc_now)
    ended_at = Column(DateTime, nullable=True)
    end_reason = Column(Text, nullable=True)
    classroom = relationship(
        "Classroom",
        back_populates="roster_members",
    )
    roster_child = relationship("Student", back_populates="class_roster_members")
    term_placements = relationship(
        "TermStudentPlacement",
        back_populates="source_membership",
    )


class ClassroomTeacher(Base):
    __tablename__ = "classroom_teachers"
    __table_args__ = (
        CheckConstraint(
            "duty IN ('lead', 'co_teacher')",
            name="ck_classroom_teachers_duty",
        ),
        Index(
            "ux_classroom_teacher_active",
            "classroom_id",
            "teacher_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
        ),
        Index(
            "ux_classroom_teacher_active_lead",
            "classroom_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL AND duty = 'lead'"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id"),
        nullable=False,
    )
    teacher_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    teacher_name_snapshot = Column(String, nullable=False)
    duty = Column(String, nullable=False)
    started_at = Column(DateTime, nullable=False, default=utc_now)
    ended_at = Column(DateTime, nullable=True)
    end_reason = Column(Text, nullable=True)
    started_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_by_name_snapshot = Column(String, nullable=False)
    ended_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    ended_by_name_snapshot = Column(String, nullable=True)

    classroom = relationship(
        "Classroom",
        back_populates="teacher_assignments",
    )
    teacher = relationship(
        "User",
        back_populates="classroom_teacher_assignments",
        foreign_keys=[teacher_id],
    )
    started_by = relationship("User", foreign_keys=[started_by_id])
    ended_by = relationship("User", foreign_keys=[ended_by_id])


# 「目前」的唯一定義：班級沒有自己的啟用旗標，由所屬學期的狀態決定
CURRENT_SEMESTER_STATUSES = ("imported", "active")


class Semester(Base):
    __tablename__ = "semesters"
    __table_args__ = (
        CheckConstraint(
            "status IN ('imported', 'draft', 'active', 'closed', 'cancelled')",
            name="ck_semesters_status",
        ),
        Index(
            "ux_semesters_current",
            text("(1)"),
            unique=True,
            sqlite_where=text("status IN ('imported', 'active')"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    label = Column(String, nullable=False)
    status = Column(String, nullable=False)
    migration_key = Column(String, nullable=True, unique=True)
    starts_on = Column(Date, nullable=True)
    ends_on = Column(Date, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utc_now)
    activated_at = Column(DateTime, nullable=True)
    closed_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)
    created_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_by_name_snapshot = Column(String, nullable=False)
    activated_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    activated_by_name_snapshot = Column(String, nullable=True)
    closed_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    closed_by_name_snapshot = Column(String, nullable=True)
    cancelled_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    cancelled_by_name_snapshot = Column(String, nullable=True)

    created_by = relationship("User", foreign_keys=[created_by_id])
    activated_by = relationship("User", foreign_keys=[activated_by_id])
    closed_by = relationship("User", foreign_keys=[closed_by_id])
    cancelled_by = relationship("User", foreign_keys=[cancelled_by_id])
    periods = relationship(
        "SemesterPeriod",
        back_populates="semester",
        cascade="all, delete-orphan",
        order_by="SemesterPeriod.position",
    )
    classrooms = relationship(
        "Classroom",
        back_populates="semester",
        cascade="all, delete-orphan",
        order_by="(Classroom.sort_order.is_(None), Classroom.sort_order, Classroom.id)",
    )
    reclassification_plan = relationship(
        "TermReclassificationPlan",
        back_populates="target_semester",
        uselist=False,
    )


class SemesterPeriod(Base):
    __tablename__ = "semester_periods"
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_semester_periods_position"),
        UniqueConstraint(
            "semester_id",
            "position",
            name="ux_semester_periods_term_position",
        ),
        UniqueConstraint(
            "template_period_id",
            name="ux_semester_periods_template_period",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    semester_id = Column(
        Integer,
        ForeignKey("semesters.id", ondelete="CASCADE"),
        nullable=False,
    )
    template_period_id = Column(
        Integer,
        ForeignKey("template_periods.id"),
        nullable=False,
    )
    period_name_snapshot = Column(String, nullable=False)
    department = Column(String, nullable=False)
    position = Column(Integer, nullable=False)
    # 建立相本鎖：非 NULL 代表這一期已停止開新相本。取代舊的「只能在目前正式學期
    # 建立相本」硬閘——學期結束不再自動封死，鎖與解鎖都由 admin 決定。
    # 見 docs/specs/period-album-creation-lock-v1.md
    album_creation_locked_at = Column(DateTime, nullable=True)
    album_creation_locked_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    album_creation_locked_by_name_snapshot = Column(String, nullable=True)

    semester = relationship("Semester", back_populates="periods")
    album_creation_locked_by = relationship(
        "User",
        foreign_keys=[album_creation_locked_by_id],
    )
    template_period = relationship(
        "TemplatePeriod",
        back_populates="semester_period",
    )
    work_slots = relationship(
        "ClassPeriodWorkSlot",
        back_populates="semester_period",
        cascade="all, delete-orphan",
        order_by="ClassPeriodWorkSlot.id",
    )


class Classroom(Base):
    """班級本體：一個班就是「學期 × 分校 × 部門 × 班名」，不跨學期延續。

    名冊成員與老師編制直接掛在這裡，所以不需要另一層學期快照——班本身就只活一個
    學期。跨學期的識別一律靠 Student／User，見
    docs/specs/term-scoped-classroom-v1.md。
    """
    __tablename__ = "classrooms"
    __table_args__ = (
        UniqueConstraint(
            "semester_id",
            "campus_id",
            "department",
            "name",
            name="ux_classrooms_term_scope_name",
        ),
        Index(
            "idx_classrooms_term_scope",
            "semester_id",
            "campus_id",
            "department",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    semester_id = Column(
        Integer,
        ForeignKey("semesters.id", ondelete="CASCADE"),
        nullable=False,
    )
    campus_id = Column(Integer, ForeignKey("campuses.id"), nullable=False)
    name = Column(String, nullable=False)
    department = Column(String, nullable=False)
    # 顯示順序：班名是「一二階／三階／十階」這種中文數字，字面排序與階段順序無關
    # （字面排會排成 一二階 七階 三階 九階 五階…）。順序是園所自己的意思，
    # 沒有可靠的推導方式，只能存下來。NULL 排在最後，沿用 id 當次序。
    sort_order = Column(Integer, nullable=True)

    semester = relationship("Semester", back_populates="classrooms")
    campus = relationship("Campus", back_populates="classrooms")
    roster_members = relationship(
        "ClassroomMember",
        back_populates="classroom",
        order_by="ClassroomMember.started_at",
    )
    teacher_assignments = relationship(
        "ClassroomTeacher",
        back_populates="classroom",
        order_by="ClassroomTeacher.started_at",
    )
    work_slots = relationship(
        "ClassPeriodWorkSlot",
        back_populates="classroom",
        cascade="all, delete-orphan",
        order_by="ClassPeriodWorkSlot.id",
    )
    projects = relationship(
        "Project",
        back_populates="classroom",
        order_by="Project.created_at",
    )

    @property
    def is_current(self) -> bool:
        """班級是否屬於目前正式學期：取代舊的班級啟用旗標。"""
        return (
            self.semester is not None
            and self.semester.status in CURRENT_SEMESTER_STATUSES
        )


class ClassPeriodWorkSlot(Base):
    __tablename__ = "class_period_work_slots"
    __table_args__ = (
        UniqueConstraint(
            "classroom_id",
            "semester_period_id",
            name="ux_class_period_work_slots_classroom_period",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
    )
    semester_period_id = Column(
        Integer,
        ForeignKey("semester_periods.id", ondelete="CASCADE"),
        nullable=False,
    )
    started_at = Column(DateTime, nullable=True)

    classroom = relationship(
        "Classroom",
        back_populates="work_slots",
    )
    semester_period = relationship("SemesterPeriod", back_populates="work_slots")
    projects = relationship(
        "Project",
        back_populates="class_period_work_slot",
        order_by="Project.created_at",
    )


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    department = Column(String, nullable=True)
    template_period_id = Column(Integer, ForeignKey("template_periods.id"), nullable=True)
    # 此專案已同步到的模板版本。專案仍 live-reference Template，這個欄位是
    # 同步完成／快取 bust 的明確水位，而不是另一份模板快照。
    template_revision = Column(Integer, nullable=False, default=1, server_default="1")
    # 專案負責人只供進度歸戶與稽核；授權一律由目前組織編制計算。
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    # 班級直接指向學期班級本體：權限判斷是每本相本、每次請求都要做的熱路徑，
    # 不繞 work slot 推導。work slot 不可變，兩者不會漂移。
    # NULL 只代表尚待歸班的遷移資料，那些相本維持 admin-only。
    classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id", ondelete="SET NULL"),
        nullable=True,
    )
    class_period_work_slot_id = Column(
        Integer,
        ForeignKey("class_period_work_slots.id"),
        nullable=True,
    )
    created_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 建立當下顯示名稱快照；帳號日後改名或刪除仍保留稽核文字。
    created_by_name = Column(String, nullable=True)
    # 建立或歸班時寫入的組織名稱快照；讀取層不以目前名稱補值。
    campus_id_snapshot = Column(Integer, nullable=True)
    campus_name_snapshot = Column(String, nullable=True)
    classroom_name_snapshot = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    deleted_at = Column(DateTime, nullable=True)
    archive_expires_at = Column(DateTime, nullable=True)
    # 全班完成時間：非 NULL 代表老師已確認完成，內容鎖定（主管/admin 可退回）
    completed_at = Column(DateTime, nullable=True)
    # server_default 讓 create_all 產生的 DDL 與升級上來的資料庫一致；
    # 值與 Python default 相同，寫入行為不變
    label_texts_json = Column(
        Text, nullable=False, default="{}", server_default=text("'{}'")
    )
    template = relationship("Template", back_populates="projects")
    template_period = relationship("TemplatePeriod", back_populates="projects")
    students = relationship("ProjectStudent", back_populates="project", cascade="all, delete-orphan", order_by="ProjectStudent.order_index")
    owner = relationship("User", back_populates="owned_projects", foreign_keys=[owner_id])
    creator = relationship(
        "User",
        back_populates="created_projects",
        foreign_keys=[created_by_id],
        passive_deletes=True,
    )
    classroom = relationship(
        "Classroom",
        back_populates="projects",
        foreign_keys=[classroom_id],
    )
    class_period_work_slot = relationship(
        "ClassPeriodWorkSlot",
        back_populates="projects",
    )
    assignment_history = relationship(
        "ProjectAssignmentHistory",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectAssignmentHistory.changed_at",
    )
    editor_assignments = relationship(
        "ProjectEditorAssignment",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectEditorAssignment.started_at",
    )
    comments = relationship("ProjectComment", back_populates="project", cascade="all, delete-orphan", order_by="ProjectComment.created_at")


class ProjectEditorAssignment(Base):
    __tablename__ = "project_editor_assignments"
    __table_args__ = (
        Index(
            "ux_project_editor_active",
            "project_id",
            "user_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    user_name_snapshot = Column(String, nullable=False)
    started_at = Column(DateTime, nullable=False, default=utc_now)
    ended_at = Column(DateTime, nullable=True)
    end_reason = Column(Text, nullable=True)
    started_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    started_by_name_snapshot = Column(String, nullable=False)
    ended_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    ended_by_name_snapshot = Column(String, nullable=True)

    project = relationship("Project", back_populates="editor_assignments")
    user = relationship(
        "User",
        back_populates="project_editor_assignments",
        foreign_keys=[user_id],
    )
    started_by = relationship("User", foreign_keys=[started_by_id])
    ended_by = relationship("User", foreign_keys=[ended_by_id])


class TermReclassificationPlan(Base):
    __tablename__ = "term_reclassification_plans"
    __table_args__ = (
        CheckConstraint(
            "scope_key = 'organization'",
            name="ck_term_reclassification_plans_scope",
        ),
        CheckConstraint(
            "status IN ('draft', 'applied', 'cancelled')",
            name="ck_term_reclassification_plans_status",
        ),
        CheckConstraint(
            "revision >= 1",
            name="ck_term_reclassification_plans_revision",
        ),
        Index(
            "ux_term_reclassification_draft_scope",
            "scope_key",
            unique=True,
            sqlite_where=text("status = 'draft'"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    target_semester_id = Column(
        Integer,
        ForeignKey("semesters.id"),
        nullable=True,
        unique=True,
    )
    scope_key = Column(
        String,
        nullable=False,
        default="organization",
        server_default="organization",
    )
    label = Column(String, nullable=False)
    status = Column(String, nullable=False, default="draft", server_default="draft")
    revision = Column(Integer, nullable=False, default=1, server_default="1")
    source_fingerprint = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=utc_now)
    updated_at = Column(DateTime, nullable=False, default=utc_now, onupdate=utc_now)
    applied_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)
    created_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_by_name_snapshot = Column(String, nullable=False)
    updated_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    updated_by_name_snapshot = Column(String, nullable=True)
    applied_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    applied_by_name_snapshot = Column(String, nullable=True)
    cancelled_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    cancelled_by_name_snapshot = Column(String, nullable=True)

    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])
    applied_by = relationship("User", foreign_keys=[applied_by_id])
    cancelled_by = relationship("User", foreign_keys=[cancelled_by_id])
    target_semester = relationship(
        "Semester",
        back_populates="reclassification_plan",
    )
    student_placements = relationship(
        "TermStudentPlacement",
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="TermStudentPlacement.id",
    )
    classroom_plans = relationship(
        "TermClassroomPlan",
        back_populates="plan",
        cascade="all, delete-orphan",
        order_by="TermClassroomPlan.classroom_id",
    )


class TermStudentPlacement(Base):
    __tablename__ = "term_student_placements"
    __table_args__ = (
        CheckConstraint(
            "outcome IN ('classroom', 'departed')",
            name="ck_term_student_placements_outcome",
        ),
        CheckConstraint(
            "(outcome = 'classroom' AND target_classroom_id IS NOT NULL) "
            "OR (outcome = 'departed' AND target_classroom_id IS NULL)",
            name="ck_term_student_placements_target",
        ),
        UniqueConstraint(
            "plan_id",
            "source_membership_id",
            name="ux_term_student_placements_plan_member",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    plan_id = Column(
        Integer,
        ForeignKey("term_reclassification_plans.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_membership_id = Column(
        Integer,
        ForeignKey("classroom_members.id"),
        nullable=False,
    )
    roster_child_id_snapshot = Column(Integer, nullable=False)
    student_name_snapshot = Column(String, nullable=False)
    source_campus_id_snapshot = Column(Integer, nullable=False)
    source_campus_name_snapshot = Column(String, nullable=False)
    source_classroom_id_snapshot = Column(Integer, nullable=False)
    source_classroom_name_snapshot = Column(String, nullable=False)
    outcome = Column(String, nullable=False)
    target_classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=True,
    )

    plan = relationship("TermReclassificationPlan", back_populates="student_placements")
    source_membership = relationship(
        "ClassroomMember",
        back_populates="term_placements",
    )
    target_classroom = relationship(
        "Classroom",
        foreign_keys=[target_classroom_id],
    )


class TermClassroomPlan(Base):
    __tablename__ = "term_classroom_plans"
    __table_args__ = (
        UniqueConstraint(
            "plan_id",
            "classroom_id",
            name="ux_term_classroom_plans_plan_classroom",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    plan_id = Column(
        Integer,
        ForeignKey("term_reclassification_plans.id", ondelete="CASCADE"),
        nullable=False,
    )
    classroom_id = Column(
        Integer,
        ForeignKey("classrooms.id", ondelete="CASCADE"),
        nullable=False,
    )

    plan = relationship("TermReclassificationPlan", back_populates="classroom_plans")
    classroom = relationship("Classroom")
    teacher_targets = relationship(
        "TermClassroomTeacherTarget",
        back_populates="classroom_plan",
        cascade="all, delete-orphan",
        order_by="TermClassroomTeacherTarget.id",
    )


class TermClassroomTeacherTarget(Base):
    __tablename__ = "term_classroom_teacher_targets"
    __table_args__ = (
        CheckConstraint(
            "duty IN ('lead', 'co_teacher')",
            name="ck_term_classroom_teacher_targets_duty",
        ),
        UniqueConstraint(
            "classroom_plan_id",
            "teacher_id",
            name="ux_term_classroom_teacher_targets_plan_teacher",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    classroom_plan_id = Column(
        Integer,
        ForeignKey("term_classroom_plans.id", ondelete="CASCADE"),
        nullable=False,
    )
    teacher_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    teacher_name_snapshot = Column(String, nullable=False)
    duty = Column(String, nullable=False)

    classroom_plan = relationship(
        "TermClassroomPlan",
        back_populates="teacher_targets",
    )
    teacher = relationship("User", foreign_keys=[teacher_id])


class Student(Base):
    """園所層級的孩子名冊：跨專案識別「同一個孩子」，供學期彙整匯出分組使用。

    名冊項只由園所設定建立／改名；轉班、復學與新學期編班沿用同一 id。
    name 不設 UNIQUE，因為園所內可能有同名不同人。
    """
    __tablename__ = "students"
    __table_args__ = (
        Index(
            "ux_students_student_serial",
            "student_serial",
            unique=True,
            sqlite_where=text("student_serial IS NOT NULL"),
        ),
    )
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    # 已歸班相本的相本稱呼唯一來源；所有既有與未來相本都即時引用。
    album_name = Column(String, nullable=True)
    # 行政系統學號：與行政系統對帳的唯一鍵。姓名會打錯（2026-08 就更正過 31 筆），
    # 學號不會。可為空——已離園、或從未在行政系統登記過的孩子沒有學號。
    student_serial = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    students = relationship("ProjectStudent", back_populates="roster_child")
    class_roster_members = relationship(
        "ClassroomMember",
        back_populates="roster_child",
    )

    @property
    def effective_album_name(self) -> str:
        """回傳名冊目前設定的有效相本稱呼。"""
        return self.album_name or self.name


class ProjectStudent(Base):
    __tablename__ = "project_students"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    # 只供未歸班舊相本相容；已歸班相本一律讀 Student.album_name。
    album_name = Column(String, nullable=True)
    order_index = Column(Integer, default=0)
    pages_data_json = Column(Text, nullable=False, default="[]")
    output_filename = Column(String, nullable=True)
    # 未歸班舊專案可為 NULL／暫定證據；歸班後由 DB trigger 凍結正式身分。
    roster_child_id = Column(Integer, ForeignKey("students.id"), nullable=True)
    # 單一學生相本完成時間：有效完成判斷一律走 project_access_service 的 predicate
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    project = relationship("Project", back_populates="students")
    roster_child = relationship("Student", back_populates="students")

    @property
    def resolved_album_name(self) -> str | None:
        """依相本是否正式歸班，解析唯一可信的相本稱呼來源。"""
        if self.project is not None and self.project.classroom_id is not None:
            # 已歸班資料即使 child link 異常，也不可回頭採用 ProjectStudent 的舊稱呼。
            return self.roster_child.album_name if self.roster_child is not None else None
        return self.album_name

    @property
    def effective_album_name(self) -> str:
        """回傳相本實際顯示名；未設定稱呼時沿用該本完整姓名快照。"""
        return self.resolved_album_name or self.name


class TemplateProjectSyncBackup(Base):
    """模板結構同步前的 DB JSON 備份。

    照片檔本身不會因頁面重排／刪除而搬移或刪除；這裡保存 binding 與舊模板
    快照，讓誤刪頁面仍可人工復原，而不會只剩無法判讀的 storage key。
    """
    __tablename__ = "template_project_sync_backups"
    id = Column(Integer, primary_key=True)
    sync_id = Column(String, nullable=False)
    template_id = Column(Integer, nullable=False)
    project_id = Column(Integer, nullable=True)
    old_revision = Column(Integer, nullable=False)
    old_pages_json = Column(Text, nullable=False)
    new_page_ids_json = Column(Text, nullable=False)
    project_completed_at = Column(DateTime, nullable=True)
    project_label_texts_json = Column(Text, nullable=True)
    students_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)


class ProjectAssignmentHistory(Base):
    """專案負責人每次實際轉交的稽核紀錄。"""

    __tablename__ = "project_assignment_history"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_owner_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    from_owner_name = Column(String, nullable=True)
    to_owner_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    to_owner_name = Column(String, nullable=False)
    changed_by_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    changed_by_name = Column(String, nullable=True)
    reason = Column(Text, nullable=True)
    changed_at = Column(DateTime, nullable=False, default=utc_now)
    project = relationship("Project", back_populates="assignment_history")


class ProjectComment(Base):
    """主管或美學組對專案留下的審閱意見。"""
    __tablename__ = "project_comments"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    author_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=utc_now)
    project = relationship("Project", back_populates="comments")
    author = relationship("User", back_populates="comments")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
