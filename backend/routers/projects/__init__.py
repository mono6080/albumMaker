# projects 套件入口
# 將各子模組路由合併，對外暴露單一 router 供 main.py 掛載

from fastapi import APIRouter

from . import assignments, comments, crud, photos, render, texts

router = APIRouter(prefix="/api/projects", tags=["projects"])

router.include_router(crud.router)
router.include_router(assignments.router)
router.include_router(photos.router)
router.include_router(texts.router)
router.include_router(render.router)
router.include_router(comments.router)
