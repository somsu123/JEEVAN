@echo off
echo Opening Serial Monitor on COM7 at 115200 baud...
echo Press Ctrl+C to exit.
echo.
C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe --chip esp32 --port COM7 --baud 115200 monitor
