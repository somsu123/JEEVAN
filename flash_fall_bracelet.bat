@echo off
setlocal
color 0E

set ESPTOOL=C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe
set BIN_DIR=%~dp0firmware\fall_bracelet\build
set PORT=%1
if "%PORT%"=="" set PORT=COM8

cls
color 0A
echo.
echo  ================================================================
echo    JEEVAN WEARABLE FALL DETECTOR — ESP32 + MPU6050 FLASH TOOL
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
  0x1000 "%BIN_DIR%\fall_bracelet.ino.bootloader.bin" ^
  0x8000 "%BIN_DIR%\fall_bracelet.ino.partitions.bin" ^
  0x10000 "%BIN_DIR%\fall_bracelet.ino.bin"

if %ERRORLEVEL% == 0 (
  color 0A
  echo.
  echo  ================================================================
  echo    SUCCESS! ESP32 Fall Detector Bracelet Flashed!
  echo    Sensor     : MPU-6050 (SDA: GPIO 21, SCL: GPIO 22)
  echo    Buzzer     : GPIO 25 (Heavy-Fall Alarm Siren)
  echo    WiFi SSID  : ElderCare
  echo    Dashboard  : http://10.122.37.135:5050
  echo  ================================================================
  echo.
) else (
  color 0C
  echo.
  echo  ================================================================
  echo    FLASH FAILED! Check COM port and try download mode again.
  echo  ================================================================
  echo.
)

pause
