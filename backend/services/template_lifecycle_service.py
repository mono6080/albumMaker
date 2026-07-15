"""模板改名、移動期別與刪除 use cases。"""

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.template_crud import get_period_or_404, get_template_or_404
from database import Project
from services.storage_factory import get_storage


logger = logging.getLogger(__name__)


def rename_template(
    db: Session,
    template_id: int,
    *,
    name: str | None,
    period_id: int | None,
) -> None:
    """修改模板名稱或期別，維持現況無 T 鎖與單次 commit。"""
    template = get_template_or_404(template_id, db)
    if name is not None:
        template_name = name.strip()
        if not template_name:
            raise HTTPException(status_code=400, detail="模板名稱不可空白")
        template.name = template_name
    if period_id is not None:
        period = get_period_or_404(period_id, db)
        template.period_id = period.id
    db.commit()


def delete_template(db: Session, template_id: int) -> None:
    """DB commit 後 best-effort 清除模板素材 namespace。"""
    template = get_template_or_404(template_id, db)
    if db.query(Project).filter(Project.template_id == template_id).first():
        raise HTTPException(status_code=409, detail="此模板仍有專案使用，無法刪除")
    db.delete(template)
    db.commit()
    try:
        get_storage().delete_prefix(f"templates/tmpl{template_id}")
    except Exception as storage_error:
        logger.error("模板已刪除但素材清理失敗 template_id=%s: %s", template_id, storage_error)
