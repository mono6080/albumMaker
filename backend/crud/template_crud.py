# 模板 CRUD 輔助模組
# 封裝對 Template / TemplatePage 的常用資料庫查詢，
# 並在查無資料時統一拋出 HTTP 404，避免各路由重複撰寫相同邏輯

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Template, TemplatePage


def get_template_or_404(template_id: int, db: Session) -> Template:
    """查詢指定模板，若不存在則拋出 404。"""
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


def get_template_page_or_404(page_id: int, template_id: int, db: Session) -> TemplatePage:
    """查詢指定模板頁面，若不存在或不屬於該模板則拋出 404。"""
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    return page
