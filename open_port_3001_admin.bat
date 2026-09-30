@echo off
echo ============================================
echo  JEEVAN - Opening port 3001 for ESP32
echo ============================================
echo.
echo Adding Windows Firewall rule to allow
echo inbound TCP connections on port 3001...
echo (Required for ESP32 to reach the server)
echo.

netsh advfirewall firewall add rule ^
  name="JEEVAN BPM Server 3001" ^
  dir=in ^
  action=allow ^
  protocol=TCP ^
  localport=3001 ^
  profile=any ^
  description="Allows ESP32 bracelet to connect to JEEVAN vitals server on port 3001"

echo.
if %ERRORLEVEL%==0 (
  echo [SUCCESS] Port 3001 is now open for inbound connections!
  echo  Your PC IP   : 10.143.152.135
  echo  ESP32 target : ws://10.143.152.135:3001/ws/esp32
) else (
  echo [ERROR] Failed to add rule. Make sure you ran this as Administrator.
)
echo.
pause
