@echo off
REM LearnIQ AI — local run (Windows). Force-restart, guaranteed fresh code.
cd /d "%~dp0"
echo Stopping ALL old Python servers (so new code loads)...
taskkill /F /IM python.exe >nul 2>&1
timeout /t 2 /nobreak >nul
if not exist .venv ( echo Creating virtual environment... & python -m venv .venv )
call .venv\Scripts\activate.bat
REM Only install if FastAPI isn't already present (avoids slow/hanging pip on restart)
python -c "import fastapi, google.genai, reportlab" 1>nul 2>nul || python -m pip install -q -r requirements-dev.txt
echo.
echo ==================================================
echo   LearnIQ AI starting at http://localhost:8000
echo   Keep THIS window open. Ctrl+C to stop.
echo ==================================================
echo.
python api\index.py
echo.
echo *** Server stopped. Copy any red error above and send it. ***
pause
