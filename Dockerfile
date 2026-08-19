# ── Stage 1：編譯前端 ──────────────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
# APP_BUILD_ID 由部署帶入 git SHA：被下面的 build 指令消費，
# 因此 commit 一變就強制重編前端——不倚賴 COPY 的內容雜湊快取，
# 避免 backend 有更新但前端 build layer 被重用而服務到舊 bundle
ARG APP_BUILD_ID=dev
COPY frontend/ .
RUN APP_BUILD_ID="${APP_BUILD_ID}" npm run build


# ── Stage 2：Python 後端 ───────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# 系統依賴：Pillow 所需的圖形函式庫 + 中文字型
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        fonts-wqy-zenhei \
        fonts-wqy-microhei \
        libheif1 \
    && rm -rf /var/lib/apt/lists/*

# Python 依賴
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 後端程式碼
COPY backend/ .
# 正式備份、名冊同步與上線後驗證必須由同一個 candidate image 執行。
COPY scripts/backup_data.py \
     scripts/data_script_utils.py \
     scripts/run_startup_migrations.py \
     scripts/backfill_student_serials.py \
     scripts/backfill_new_student_serials.py \
     scripts/report_websystem_drift.py \
     scripts/sync_websystem_roster.py \
     /app/scripts/
# 讀已改名資料表的一次性腳本一律不納入 image，在容器裡只會找不到表：
# - correct_roster_names.py / fill_missing_album_names.py 讀 `roster_children`，
#   2026-08-01 在正式站執行完畢後標記退場。
# - 2026-07 切換的五支 `*_202607.py`／`repair_project_203.py` 讀 `academic_term_*`
#   與 `students.project_id`，已於 2026-08-18 連同測試一併刪除；那次切換的紀錄見
#   docs/dev/production-cutover-202607.md，內容留在 git 歷史。

# 前端編譯結果（放在 main.py 預期的相對位置）
COPY --from=frontend-builder /build/dist/ /frontend/dist/

# 建立 uploads 目錄（會被 volume 覆蓋，但確保初始存在）
RUN mkdir -p uploads
RUN mkdir -p backups

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "healthcheck.py"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
