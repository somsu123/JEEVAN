@echo off
setlocal
color 0E

set ESPTOOL=C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe
set BIN_DIR=%~dp0firmware\medicine_box\build
set PORT=%1
if "%PORT%"=="" set PORT=COM8

cls
color 0A
echo.
echo  ================================================================
echo    JEEVAN SMART MEDICINE BOX — ESP32 4-SLOT FLASH TOOL
echo  ================================================================
echo.
echo  Target Port: %PORT%
echo.
echo  HOW TO PUT ESP32 IN BOOT MODE (if auto-reset does not trigger):
echo  ---------------------------------------------------------------
echo   1. Press and HOLD the [BOOT] button on the ESP32
echo   2. Press and release the [EN] / [RST] button
echo   3. Release [BOOT]
echo   4. Press ANY KEY in this window to flash...
echo.
pause > nul

echo.
echo  Flashing binary to %PORT%...
echo.

"%ESPTOOL%" ^
  --chip esp32 ^
  --port %PORT% ^
  --baud 115200 ^
  --before default_reset ^
  --after hard_reset ^
  --connect-attempts 5 ^
  write-flash ^
  -z ^
  --flash-mode dio ^
  --flash-freq 80m ^
  --flash-size detect ^
  0x1000 "%BIN_DIR%\medicine_box.ino.bootloader.bin" ^
  0x8000 "%BIN_DIR%\medicine_box.ino.partitions.bin" ^
  0x10000 "%BIN_DIR%\medicine_box.ino.bin"

if %ERRORLEVEL% == 0 (
  color 0A
  echo.
  echo  ================================================================
  echo    SUCCESS! ESP32 Medicine Box Flashed!
  echo    WiFi SSID  : ElderCare
  echo    Dashboard  : http://10.122.37.135:5050
  echo    Web Server : Port 80
  echo  ================================================================
  echo.
) else (
  color 0C
  echo.
  echo  [ERROR] Flashing failed. Please make sure the ESP32 is in Bootloader mode.
)
