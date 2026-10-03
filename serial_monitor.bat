@echo off
set PORT=%1
if "%PORT%"=="" set PORT=COM11
echo Opening Serial Monitor on %PORT% at 115200 baud...
echo Press Ctrl+C to exit.
echo.
C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe --chip esp32 --port %PORT% --baud 115200 monitor
