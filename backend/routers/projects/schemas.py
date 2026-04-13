# 專案相關 API 回應 Schema
# 明確定義主要端點的回應格式，供 FastAPI 文件化與回應驗證使用

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class ProjectSummary(BaseModel):
    """專案清單項目（精簡版）"""
    id: int
    name: str
    template_id: int
    created_at: Optional[datetime] = None
    student_count: int
    owner_id: Optional[int] = None
    owner_name: Optional[str] = None


class StudentInProject(BaseModel):
    """學生資料（內嵌於 ProjectDetail）"""
    id: int
    name: str
    order_index: int
    pages_data: Any  # JSON 結構，不強制型別
    output_filename: Optional[str] = None


class ProjectDetail(BaseModel):
    """專案完整資訊（含所有學生）"""
    id: int
    name: str
    template_id: int
    created_at: Optional[datetime] = None
    owner_id: Optional[int] = None
    label_texts: Any
    students: list[StudentInProject]


class CommentOut(BaseModel):
    """審閱留言"""
    id: int
    author_id: int
    author_name: str
    content: str
    created_at: Optional[datetime] = None


class RenderStudentResult(BaseModel):
    """單生渲染結果"""
    pdf: Optional[str] = None
    pages: Optional[int] = None


class PhotoSlotValue(BaseModel):
    """單一照片欄位的資料（null 表示清除）"""
    path: str
    scale: float = 1.0
    offset_x: float = 0.0
    offset_y: float = 0.0


class PhotoMappingPayload(BaseModel):
    """
    照片欄位對應關係更新 Payload。

    格式範例：
    {
      "pages": {
        "0": {                         # 頁面索引（字串）
          "1": {                       # slot_id（字串）
            "path": "projects/...",    # Storage key
            "scale": 1.2,
            "offset_x": -0.1,
            "offset_y": 0.05
          },
          "2": null                    # null 表示清除此欄位
        }
      }
    }

    重命名規則：
    - 照片移到新欄位時，後端自動重命名檔案使前綴與欄位對齊。
    - 跨頁互換時先收集所有 incoming_paths，避免先刪後找不到。
    - 回傳 renames 讓前端同步更新 serverPath。
    """
    pages: dict[str, dict[str, Any]] = {}


class PhotoMappingResult(BaseModel):
    """照片映射更新結果"""
    ok: bool
    renames: dict[str, dict[str, str]] = {}
