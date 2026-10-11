@echo off
title ElderCare Backend Suite Launcher
echo ===================================================
echo       Starting ElderCare Backend Services
echo ===================================================

echo [1/3] Starting Central Flask API Server (Port 5000)...
start "ElderCare: Flask API" cmd /k "py -3.11 backend\app.py"
timeout /t 3 /nobreak > nul

echo [2/3] Starting Vitals WebSocket Server (Port 3001)...
start "ElderCare: Vitals WS Server" cmd /k "cd bpm-server && node server.js"
timeout /t 2 /nobreak > nul

echo [3/3] Starting AI Voice Assistant...
start "ElderCare: Voice Assistant" cmd /k "py -3.11 ai_assistant\main_assistant.py"

echo ===================================================
echo   Backend services have been started!
echo   Flask REST API:       http://localhost:5000
echo   Vitals WS Server:     ws://localhost:3001
echo ===================================================
pause
