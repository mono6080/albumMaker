@echo off
setlocal EnableExtensions DisableDelayedExpansion

echo 啟動幼兒園相本系統（本機 R2 staging）...

if not exist "%~dp0.env" (
    echo 找不到 .env，請先建立 R2 staging 設定。
    pause
    exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0.env") do (
    if /I "%%A"=="SECRET_KEY" set "%%A=%%B"
    if /I "%%A"=="STORAGE_BACKEND" set "%%A=%%B"
    if /I "%%A"=="R2_ACCOUNT_ID" set "%%A=%%B"
    if /I "%%A"=="R2_ACCESS_KEY_ID" set "%%A=%%B"
    if /I "%%A"=="R2_SECRET_ACCESS_KEY" set "%%A=%%B"
    if /I "%%A"=="R2_BUCKET" set "%%A=%%B"
    if /I "%%A"=="R2_ENDPOINT_URL" set "%%A=%%B"
    if /I "%%A"=="R2_SERVE_MODE" set "%%A=%%B"
    if /I "%%A"=="R2_PUBLIC_BASE_URL" set "%%A=%%B"
    if /I "%%A"=="R2_KEY_PREFIX" set "%%A=%%B"
    if /I "%%A"=="R2_READ_CACHE_MAX_BYTES" set "%%A=%%B"
    if /I "%%A"=="R2_LOCAL_CACHE_DIR" set "%%A=%%B"
    if /I "%%A"=="R2_LOCAL_CACHE_MAX_BYTES" set "%%A=%%B"
    if /I "%%A"=="R2_LOCAL_MIRROR_DIR" set "%%A=%%B"
)

if /I not "%STORAGE_BACKEND%"=="r2" (
    echo .env 的 STORAGE_BACKEND 不是 r2，目前值：%STORAGE_BACKEND%
    pause
    exit /b 1
)

cd /d "%~dp0backend"
start "後端伺服器 R2" python -m uvicorn main:app --host 0.0.0.0 --port 8765
timeout /t 3 /nobreak >nul
start http://localhost:8765

echo 已啟動本機 R2 staging server。
echo 按任意鍵關閉此視窗（伺服器會繼續運行）
pause >nul
