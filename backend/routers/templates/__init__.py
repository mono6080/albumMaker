# templates 套件入口
# 將各子模組路由合併，對外暴露單一 router 供 main.py 掛載
# 注意：periods 必須先掛載，避免 /departments、/periods 被 /{template_id} 吃掉

from fastapi import APIRouter

from . import assets, crud, periods, render

router = APIRouter(prefix="/api/templates", tags=["templates"])

router.include_router(periods.router)
router.include_router(crud.router)
router.include_router(assets.router)
router.include_router(render.router)
