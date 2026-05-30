@echo off
title ElderCare Fall Detector Testing Launcher
echo ===================================================
echo   ElderCare Fall Detector Testing Launcher
echo ===================================================
echo.

:: Automatically check if MongoDB is running, and start it if not
tasklist /fi "imagename eq mongod.exe" | find /i "mongod.exe" > nul
if errorlevel 1 (
    echo [1/3] Starting local MongoDB Database...
    start "ElderCare: MongoDB" /min "C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe"
    timeout /t 3 /nobreak > nul
) else (
    echo [1/3] MongoDB Database is already running.
)

echo [2/3] Starting Central Backend API (Port 5000)...
start "ElderCare: Backend" cmd /c "py -3.11 backend\app.py"
timeout /t 4 /nobreak > nul

echo [3/3] Starting Dashboard Server (Port 5050)...
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
