import os
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime

SQLALCHEMY_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "sqlite:///./album_maker.db"
)
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
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
    # 帶班老師的直屬主管（supervisor 角色使用者），其他角色為 null
    supervisor_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    supervisor = relationship("User", remote_side="User.id", foreign_keys=[supervisor_id], back_populates="subordinates")
    subordinates = relationship("User", foreign_keys=[supervisor_id], back_populates="supervisor")
    owned_projects = relationship("Project", back_populates="owner", foreign_keys="Project.owner_id")
    comments = relationship("ProjectComment", back_populates="author")


class Template(Base):
    __tablename__ = "templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
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
    # 專案所有者（帶班老師或 admin），nullable 以相容歷史資料
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    bubble_texts_json = Column(Text, nullable=False, default="{}")
    template = relationship("Template", back_populates="projects")
    students = relationship("Student", back_populates="project", cascade="all, delete-orphan", order_by="Student.order_index")
    owner = relationship("User", back_populates="owned_projects", foreign_keys=[owner_id])
    comments = relationship("ProjectComment", back_populates="project", cascade="all, delete-orphan", order_by="ProjectComment.created_at")


class Student(Base):
    __tablename__ = "students"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    order_index = Column(Integer, default=0)
    pages_data_json = Column(Text, nullable=False, default="[]")
    output_filename = Column(String, nullable=True)
    project = relationship("Project", back_populates="students")


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
