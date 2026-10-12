@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] 安裝程式套件...
call npm.cmd install
if errorlevel 1 goto :error
echo [2/2] 安裝專用 Chromium 瀏覽器...
call npx.cmd playwright install chromium
if errorlevel 1 goto :error
if not exist .env copy .env.example .env >nul
if not exist config.json copy config.example.json config.json >nul
echo.
echo 安裝完成。請設定通知資料，再執行 01_啟動監控.bat。
pause
exit /b 0
:error
echo.
echo 安裝失敗，請保留此視窗中的錯誤訊息。
pause
exit /b 1
