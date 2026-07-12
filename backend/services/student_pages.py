# 學生 pages_data_json 的併發安全寫入入口
#
# pages_data_json 是整包 JSON 的 read-modify-write：任何兩個併發請求
# （照片上傳、文字自動儲存、頁面跳過、照片 mapping⋯⋯）打同一學生，
# 後 commit 的會把先 commit 的改動整包蓋掉。
# 所有寫入端一律走 mutate_student_pages()：進鎖後先 refresh 拿最新資料、
# commit 完才放鎖。鎖是 process-local（單 uvicorn worker 假設，
# 多 worker 的開放問題見 known-issues.md）。

import json
import threading
from datetime import datetime

from fastapi import HTTPException

from database import Student
from services.file_service import delete_photo_thumbnails, get_photo_key

# ── 寫鎖 ─────────────────────────────────────────────────────────────────────

_student_write_locks: dict[int, threading.Lock] = {}
_student_write_locks_guard = threading.Lock()


def _student_write_lock(student_id: int) -> threading.Lock:
    with _student_write_locks_guard:
        return _student_write_locks.setdefault(student_id, threading.Lock())


# ── pages_data 基本操作（空頁 schema 與雙形態相容的唯一真相來源） ──────────────

def parse_pages_data(raw: str) -> list:
    """安全解析 pages_data_json，格式損壞時回 422 而非 500。"""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=422, detail="資料庫中的 pages_data_json JSON 格式損壞，請聯絡管理員")


def ensure_page_entry(pages_data: list, page_index: int) -> dict:
    """補齊至 page_index 的空頁條目並回傳該頁 dict。"""
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })
    return pages_data[page_index]


def photo_record_key(record) -> str:
    """照片紀錄的 storage key：相容舊版純字串與新版 dict 兩種形態。"""
    if not record:
        return ""
    return record if isinstance(record, str) else record.get("path", "")


def page_has_photo(pages_data: list, page_index: int, slot_id: int) -> bool:
    """判斷指定頁面/照片格是否已有照片紀錄。"""
    if page_index >= len(pages_data):
        return False
    record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    return bool(photo_record_key(record))


# ── 併發安全寫入入口 ──────────────────────────────────────────────────────────

def mutate_student_pages(db, student: Student, mutate):
    """在學生寫鎖內執行 pages_data 的 read-modify-write。

    流程：進鎖 → db.refresh(student) 拿最新 → mutate(pages_data)（可安全做
    storage 操作、設 updated_at）→ dumps 寫回 → commit → 放鎖。
    mutate 的回傳值原樣帶出。呼叫端若在 async 路由，整段下放 threadpool
    （持鎖狀態不可跨 await）。
    """
    with _student_write_lock(student.id):
        db.refresh(student)
        pages_data = parse_pages_data(student.pages_data_json)
        result = mutate(pages_data)
        student.pages_data_json = json.dumps(pages_data)
        db.commit()
        return result


# ── 照片寫入與 mapping（供 photos 路由使用的業務邏輯） ─────────────────────────

def apply_photo_to_page(
    pages_data: list,
    student: Student,
    project_id: int,
    page_index: int,
    slot_id: int,
    processed_upload,
    storage,
    now: datetime,
    source_key: str | None = None,
) -> str:
    """寫入單一學生指定照片格：刪舊縮圖→put 新檔→更新照片紀錄。回傳新 key。

    供單張上傳 / 共用照片展開 / 批次上傳共用；須在 mutate_student_pages 的
    mutate 內呼叫。source_key：共用照片全班展開時，第 2 位起用 storage.copy
    （R2 為零傳輸的 server-side copy）取代重複上傳同一份 bytes。
    """
    page_entry = ensure_page_entry(pages_data, page_index)

    slot_id_str = str(slot_id)
    old_key = photo_record_key(page_entry.get("photos", {}).get(slot_id_str))
    if old_key:
        delete_photo_thumbnails(storage, old_key)
        storage.delete(old_key)

    key = get_photo_key(project_id, student.id, page_index, slot_id, processed_upload.filename)
    if source_key and source_key != key:
        storage.copy(source_key, key)
    else:
        storage.put(key, processed_upload.data)
    page_entry.setdefault("photos", {})[slot_id_str] = {
        "path": key,
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
        # 上傳版本（毫秒）：同名重傳時 key 不變、bytes 會變，預覽快取靠這個欄位換 hash
        "v": int(now.timestamp() * 1000),
    }
    student.updated_at = now
    return key


def apply_photo_mapping(pages_data: list, all_pages: dict, storage) -> None:
    """更新照片欄位對應關係，支援跨頁移動、位移縮放與清除。

    兩步驟協議（前後端共同約定）：
    1. 寫入（第一步）：所有非 null 項目先寫入目標格位資料，但不重命名檔案。
       storage key 只代表檔案位置，不需要跟目前格位同步；避免 R2 互動操作變成 copy/delete。
    2. 清除（第二步）：所有 null 項目統一刪除，但只刪除未被移走的檔案。
       跨頁互換時先收集 incoming_paths，確保「A 移到 B、B 移到 A」不誤刪。

    all_pages 格式：{ "頁面索引": { "slot_id": { path, scale, offset_x, offset_y } | null } }
    須在 mutate_student_pages 的 mutate 內呼叫。
    """
    # 跨頁統一收集所有「即將被寫入」的路徑，防止跨頁互換時先刪後找不到
    incoming_paths: set[str] = set()
    for slot_updates in all_pages.values():
        for photo_path in slot_updates.values():
            if photo_path is not None:
                path_str = photo_record_key(photo_path)
                if path_str:
                    incoming_paths.add(path_str)

    # 前端送來的照片物件不帶 v（上傳版本），先依 path 收集現有的 v，
    # 寫入時補回去——否則移動/調整照片會遺失版本欄位，
    # 之後同名重傳的預覽快取就換不了 hash
    photo_version_by_path: dict[str, int] = {}
    for page in pages_data:
        for record in (page.get("photos") or {}).values():
            if isinstance(record, dict) and record.get("path") and "v" in record:
                photo_version_by_path[record["path"]] = record["v"]

    # 第一步：所有頁面的非 null 項目先寫入。不要為了格位異動重命名檔案；
    # R2 copy/delete 對拖曳交換太慢，且 render 只需要 DB mapping 中的 path。
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        page_entry = ensure_page_entry(pages_data, page_index)
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is None:
                continue
            if isinstance(photo_path, dict) and photo_path.get("path") in photo_version_by_path and "v" not in photo_path:
                photo_path = {**photo_path, "v": photo_version_by_path[photo_path["path"]]}
            page_entry["photos"][slot_id_str] = photo_path

    # 第二步：所有頁面的 null 項目統一清除，只刪除未被移走的檔案
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is not None:
                continue
            old_key = photo_record_key(pages_data[page_index]["photos"].get(slot_id_str))
            if old_key and old_key not in incoming_paths:
                delete_photo_thumbnails(storage, old_key)
                storage.delete(old_key)
            pages_data[page_index]["photos"].pop(slot_id_str, None)
