import os
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, Table, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime

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

teacher_supervisors = Table(
    "teacher_supervisors",
    Base.metadata,
    Column("teacher_id", Integer, ForeignKey("users.id"), primary_key=True),
    Column("supervisor_id", Integer, ForeignKey("users.id"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=False, unique=True)
    display_name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    # 角色：admin | art_team | supervisor | teacher | none
    role = Column(String, nullable=False, default="none")
    ui_font_scale = Column(Float, nullable=False, default=1.0, server_default="1.0")
    # 舊版單一主管欄位；新版多主管資料存在 teacher_supervisors，保留此欄位相容舊資料/API
    supervisor_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    supervisor = relationship("User", remote_side="User.id", foreign_keys=[supervisor_id], back_populates="subordinates")
    subordinates = relationship("User", foreign_keys=[supervisor_id], back_populates="supervisor")
    supervisors = relationship(
        "User",
        secondary=teacher_supervisors,
        primaryjoin=id == teacher_supervisors.c.teacher_id,
        secondaryjoin=id == teacher_supervisors.c.supervisor_id,
        back_populates="managed_teachers",
    )
    managed_teachers = relationship(
        "User",
        secondary=teacher_supervisors,
        primaryjoin=id == teacher_supervisors.c.supervisor_id,
        secondaryjoin=id == teacher_supervisors.c.teacher_id,
        back_populates="supervisors",
    )
    owned_projects = relationship("Project", back_populates="owner", foreign_keys="Project.owner_id")
    comments = relationship("ProjectComment", back_populates="author")


class TemplatePeriod(Base):
    __tablename__ = "template_periods"
    id = Column(Integer, primary_key=True, index=True)
    department = Column(String, nullable=False)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="draft")
    created_at = Column(DateTime, default=datetime.utcnow)

    templates = relationship("Template", back_populates="period", order_by="Template.created_at.desc()")
    projects = relationship("Project", back_populates="template_period")


class Template(Base):
    __tablename__ = "templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    period_id = Column(Integer, ForeignKey("template_periods.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
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


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    department = Column(String, nullable=True)
    template_period_id = Column(Integer, ForeignKey("template_periods.id"), nullable=True)
    # 專案所有者（帶班老師或 admin），nullable 以相容歷史資料
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    deleted_at = Column(DateTime, nullable=True)
    archive_expires_at = Column(DateTime, nullable=True)
    # 全班完成時間：非 NULL 代表老師已確認完成，內容鎖定（主管/admin 可退回）
    completed_at = Column(DateTime, nullable=True)
    label_texts_json = Column(Text, nullable=False, default="{}")
    template = relationship("Template", back_populates="projects")
    template_period = relationship("TemplatePeriod", back_populates="projects")
    students = relationship("Student", back_populates="project", cascade="all, delete-orphan", order_by="Student.order_index")
    owner = relationship("User", back_populates="owned_projects", foreign_keys=[owner_id])
    comments = relationship("ProjectComment", back_populates="project", cascade="all, delete-orphan", order_by="ProjectComment.created_at")


class RosterChild(Base):
    """園所層級的孩子名冊：跨專案識別「同一個孩子」，供學期彙整匯出分組使用。

    名冊項由學生建立/改名時自動長出（見 services/roster_service.py），
    admin 只在同名歧義時介入。name 不設 UNIQUE — 同名不同人時由 admin 手動拆成兩筆。
    """
    __tablename__ = "roster_children"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    students = relationship("Student", back_populates="roster_child")


class Student(Base):
    __tablename__ = "students"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    order_index = Column(Integer, default=0)
    pages_data_json = Column(Text, nullable=False, default="[]")
    output_filename = Column(String, nullable=True)
    # 名冊連結：NULL 代表同名歧義待 admin 確認（見 roster_service.resolve_roster_child_id）
    roster_child_id = Column(Integer, ForeignKey("roster_children.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    project = relationship("Project", back_populates="students")
    roster_child = relationship("RosterChild", back_populates="students")


class ProjectComment(Base):
    """主管或美學組對專案留下的審閱意見。"""
    __tablename__ = "project_comments"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    author_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
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
