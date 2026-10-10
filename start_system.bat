@echo off
title ElderCare Automation System Launcher
echo ===================================================
echo     Starting ElderCare Automation System
echo ===================================================

echo [1/4] Starting Central Backend API (Firebase)...
start "ElderCare: Backend" cmd /c "py -3.11 backend\app.py"
timeout /t 3 /nobreak > nul

echo [2/4] Starting Vitals WebSocket Server (Port 3001)...
start "ElderCare: Vitals Server" cmd /c "cd /d bpm-server && node server.js"
timeout /t 2 /nobreak > nul

echo [3/4] Starting Dashboard (Vite + Express)...
start "ElderCare: Dashboard" cmd /c "cd /d dashboard-v2 && npm run dev"
timeout /t 3 /nobreak > nul

echo [4/4] Starting USB Webcam Fall Detection Camera...
start "ElderCare: AI Fall Camera" cmd /c "py -3.11 webcam_fall_detector.py"

echo ===================================================
echo   ElderCare System is fully running!
echo   Dashboard:     http://localhost:5050
echo   AI Fall Cam:   Active with live Pose Tracking HUD
echo   Vitals Server: ws://10.122.37.135:3001/ws/esp32
echo   Backend API:   http://localhost:5000
echo ===================================================
pause
