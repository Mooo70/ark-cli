@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ark - local console  http://127.0.0.1:5199
echo   close this window or press Ctrl+C to stop
echo.
node bin\ark.js ui --port 5199 --open
if errorlevel 1 (
  echo.
  echo   Failed to start. Check Node.js is installed: node --version
  pause
)
