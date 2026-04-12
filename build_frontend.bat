@echo off
echo 建置前端...
cd /d %~dp0frontend
npm run build
echo 前端建置完成！
pause
