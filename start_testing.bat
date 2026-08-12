@echo off
title ElderCare Fall Detector Testing Launcher
echo ===================================================
echo   ElderCare Fall Detector Testing Launcher
echo ===================================================
echo.

echo [1/2] Starting Central Backend API (Port 5000)...
start "ElderCare: Backend" cmd /c "py -3.11 backend\app.py"
timeout /t 4 /nobreak > nul

echo [2/2] Starting Dashboard Server (Port 5050)...
start "ElderCare: Dashboard" cmd /c "cd /d dashboard-v2 && npm run dev"

echo ===================================================
echo   Testing Suite is running!
echo   Dashboard: http://localhost:5050
echo   Backend:   http://localhost:5000
echo.
echo   To trigger a simulated fall and check alerts:
echo   Open a separate CMD and run:
echo   python "D:\elder care fall\test_alert.py"
echo ===================================================
pause
