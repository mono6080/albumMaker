from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime

SQLALCHEMY_DATABASE_URL = "sqlite:///./album_maker.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


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
    layout_json = Column(Text, nullable=False, default="{}")  # photo slots, text bubbles, footer, logo
    template = relationship("Template", back_populates="pages")


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    template_id = Column(Integer, ForeignKey("templates.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Project-level bubble texts: {"<page_index>": {"<bubble_id>": "text", ...}, ...}
    # Overrides template defaults; overridden by per-student bubble_texts.
    bubble_texts_json = Column(Text, nullable=False, default="{}")
    template = relationship("Template", back_populates="projects")
    students = relationship("Student", back_populates="project", cascade="all, delete-orphan", order_by="Student.order_index")


class Student(Base):
    __tablename__ = "students"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    order_index = Column(Integer, default=0)
    pages_data_json = Column(Text, nullable=False, default="[]")  # per-page: photos + bubble texts
    output_filename = Column(String, nullable=True)
    project = relationship("Project", back_populates="students")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
