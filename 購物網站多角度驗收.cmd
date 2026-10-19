@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 本次完全離線驗收，不登入官網、不送真實訂單、不推播。
node scripts/commerce-acceptance.mjs
if errorlevel 1 echo 驗收未通過，請查看輸出的報告路徑。
echo.
pause
