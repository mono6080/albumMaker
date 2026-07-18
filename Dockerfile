# ── Stage 1：編譯前端 ──────────────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ .
RUN npm run build


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
# 正式備份、一次性資料遷移與上線後驗證必須由同一個 candidate image 執行。
COPY scripts/backup_data.py \
     scripts/data_script_utils.py \
     scripts/run_startup_migrations.py \
     scripts/migrate_production_organization_202607.py \
     scripts/repair_project_203.py \
     scripts/audit_production_migration_202607.py \
     scripts/rerender_production_projects_202607.py \
     /app/scripts/

# 前端編譯結果（放在 main.py 預期的相對位置）
COPY --from=frontend-builder /build/dist/ /frontend/dist/

# 建立 uploads 目錄（會被 volume 覆蓋，但確保初始存在）
RUN mkdir -p uploads
RUN mkdir -p backups

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "healthcheck.py"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
