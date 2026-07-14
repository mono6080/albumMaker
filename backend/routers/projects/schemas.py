# 專案相關 API 回應 Schema
# 明確定義主要端點的回應格式，供 FastAPI 文件化與回應驗證使用

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class ProjectSummary(BaseModel):
    """專案清單項目（精簡版）"""
    id: int
    name: str
    template_id: int
    department: Optional[str] = None
    department_label: Optional[str] = None
    template_period_id: Optional[int] = None
    template_period_name: Optional[str] = None
    created_at: Optional[datetime] = None
    student_count: int
    # 審閱留言數：老師端在專案卡上看到主管留言的入口（閉環提示）
    comment_count: int = 0
    owner_id: Optional[int] = None
    owner_name: Optional[str] = None
    deleted_at: Optional[datetime] = None
    archive_expires_at: Optional[datetime] = None
    # 全班完成時間：非 NULL 代表內容鎖定
    completed_at: Optional[datetime] = None


class StudentInProject(BaseModel):
    """學生資料（內嵌於 ProjectDetail）"""
    id: int
    name: str
    order_index: int
    pages_data: Any  # JSON 結構，不強制型別
    output_filename: Optional[str] = None
    # 前端預覽 URL 的版本戳（瀏覽器快取 busting 用）
    updated_at: Optional[datetime] = None


class ProjectDetail(BaseModel):
    """專案完整資訊（含所有學生）"""
    id: int
    name: str
    template_id: int
    template_revision: int
    department: Optional[str] = None
    department_label: Optional[str] = None
    template_period_id: Optional[int] = None
    template_period_name: Optional[str] = None
    created_at: Optional[datetime] = None
    owner_id: Optional[int] = None
    deleted_at: Optional[datetime] = None
    archive_expires_at: Optional[datetime] = None
    # 全班完成時間：非 NULL 代表內容鎖定
    completed_at: Optional[datetime] = None
    # 前端預覽 URL 的版本戳（瀏覽器快取 busting 用）
    updated_at: Optional[datetime] = None
    label_texts: Any
    students: list[StudentInProject]


class StudentEditorStudentSummary(BaseModel):
    """學生切換器只需的最小資料。"""
    id: int
    name: str
    order_index: int


class StudentEditorProject(BaseModel):
    """個別學生編輯器所需的精簡專案資料。"""
    id: int
    name: str
    template_id: int
    template_revision: int
    owner_id: Optional[int] = None
    completed_at: Optional[datetime] = None
    label_texts: Any
    students: list[StudentEditorStudentSummary]


class StudentEditorDetail(BaseModel):
    project: StudentEditorProject
    student: StudentInProject


class CommentOut(BaseModel):
    """審閱留言"""
    id: int
    author_id: int
    author_name: str
    content: str
    created_at: Optional[datetime] = None


class RenderStudentResult(BaseModel):
    """單生渲染結果；skipped=True 表示內容未變、沿用既有輸出"""
    pdf: Optional[str] = None
    pages: Optional[int] = None
    skipped: bool = False


class PhotoSlotValue(BaseModel):
    """單一照片欄位的資料（null 表示清除）"""
    path: str = Field(..., min_length=1, max_length=500)
    scale: float = Field(1.0, ge=0.1, le=10.0)
    offset_x: float = Field(0.0, ge=-10.0, le=10.0)
    offset_y: float = Field(0.0, ge=-10.0, le=10.0)
    brightness: float = Field(1.0, ge=0.1, le=3.0)
    contrast: float = Field(1.0, ge=0.1, le=3.0)


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

    mapping 規則：
    - 照片移到新欄位時只更新 DB mapping，不重命名 storage key。
    - 跨頁互換時先收集所有 incoming_paths，避免先刪後找不到。
    - renames 保留為向後相容欄位，目前固定回傳空物件。
    """
    pages: dict[str, dict[str, PhotoSlotValue | None]] = Field(default_factory=dict)


class PhotoMappingResult(BaseModel):
    """照片映射更新結果"""
    ok: bool
    renames: dict[str, dict[str, str]] = {}


class ProjectCreated(BaseModel):
    """建立專案回應"""
    id: int
    name: str
    department: Optional[str] = None
    template_period_id: Optional[int] = None


class BatchAddResult(BaseModel):
    """批次新增學生回應"""
    created: list[str]
    skipped: list[str]


class CopyStudentsPayload(BaseModel):
    """從既有專案複製學生名單的 payload"""
    source_project_id: int


class RenderStudentError(BaseModel):
    """單生渲染失敗紀錄"""
    student: str
    error: str


class RenderStudentSuccess(BaseModel):
    """單生渲染成功紀錄"""
    student: str
    pdf: Optional[str] = None


class RenderAllResult(BaseModel):
    """批次渲染全班回應"""
    rendered: list[RenderStudentSuccess]
    errors: list[RenderStudentError]


class PhotoUploadResult(BaseModel):
    """照片上傳回應"""
    filename: str
    path: str


class SharedPhotoUploadResult(BaseModel):
    """專案層級共用照片上傳回應"""
    ok: bool = True
    updated: int
    filename: str
    page_index: int
    slot_id: int
    compressed: bool = False


class BatchPhotoUploadItem(BaseModel):
    """批次上傳中單一學生的處理結果"""
    student_id: int
    filename: str
    path: Optional[str] = None
    reason: Optional[str] = None


class BatchPhotoUploadResult(BaseModel):
    """
    批次照片上傳回應。

    succeeded：成功寫入的學生與檔案
    failed：解碼、儲存失敗的紀錄（含原因代碼）
    skipped：依 overwrite_existing=false 跳過的學生
    """
    ok: bool = True
    page_index: int
    slot_id: int
    succeeded: list[BatchPhotoUploadItem] = []
    failed: list[BatchPhotoUploadItem] = []
    skipped: list[BatchPhotoUploadItem] = []


class PageSkipPayload(BaseModel):
    """設定頁面跳過旗標的 payload"""
    skip: bool


class OkResult(BaseModel):
    """通用成功回應"""
    ok: bool = True


class BatchTextsPayload(BaseModel):
    """
    批次更新多位學生對應文字的 payload。

    格式：
      students: {
        "student_id": {
          "page_index": { "label_id": "text" }
        }
      }
    """
    students: dict[str, dict[str, dict[str, Any]]] = {}
