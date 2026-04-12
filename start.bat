@echo off
echo 啟動幼兒園相本系統...
cd /d %~dp0backend
start "後端伺服器" python -m uvicorn main:app --host 0.0.0.0 --port 8765
timeout /t 3 /nobreak >nul
start http://localhost:8765
echo 已啟動！瀏覽器將自動開啟。
echo 按任意鍵關閉此視窗（伺服器會繼續運行）
pause >nul
