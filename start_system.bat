@echo off
title ElderCare Automation System Launcher
echo ===================================================
echo     Starting ElderCare Automation System
echo ===================================================

echo [1/2] Starting Central Backend API (MongoDB)...
start "ElderCare: Backend" cmd /c "py -3.11 backend\app.py"
timeout /t 4 /nobreak > nul

echo [2/2] Starting Dashboard (Vite + Express)...
start "ElderCare: Dashboard" cmd /c "cd /d dashboard-v2 && npm run dev"

echo ===================================================
echo   System is running!
echo   Dashboard: http://localhost:5050  (or Vite port shown in its window)
echo   Backend:   http://localhost:5000
echo   Make sure MongoDB is running and ESP32 devices are powered on.
echo   Close the command prompt windows to stop the services.
echo ===================================================
pause
