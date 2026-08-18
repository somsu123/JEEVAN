@echo off
setlocal
color 0E

set ESPTOOL=C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe
set BIN_DIR=C:\Users\somsubhro\AppData\Local\Temp\bpm_build_out
set PORT=COM7

cls
color 0A
echo.
echo  ================================================================
echo    ELDER-CARE BPM — ESP32 FLASH TOOL  (HW-827 / MAX30102)
echo  ================================================================
echo.
echo  HOW TO PUT ESP32 IN BOOT MODE:
echo  --------------------------------
echo.
echo   STEP 1:  Press and HOLD the [BOOT] button  (keep holding!)
echo   STEP 2:  Press and release the [EN] / [RST] button
echo   STEP 3:  Release [BOOT]  — the blue LED should dim/go out
echo   STEP 4:  Press ANY KEY HERE (board is now in download mode)
echo.
echo  *** DO STEPS 1-3 NOW, THEN PRESS A KEY ***
echo.
pause > nul

echo.
echo  Flashing NOW...
echo.

"%ESPTOOL%" ^
  --chip esp32 ^
  --port %PORT% ^
  --baud 115200 ^
  --before no-reset ^
  --after hard-reset ^
  --connect-attempts 5 ^
  write-flash ^
  -z ^
  --flash-mode dio ^
  --flash-freq 80m ^
  --flash-size detect ^
  0x0000 "%BIN_DIR%\bpm_bracelet.ino.bootloader.bin" ^
  0x8000 "%BIN_DIR%\bpm_bracelet.ino.partitions.bin" ^
  0x10000 "%BIN_DIR%\bpm_bracelet.ino.bin"

if %ERRORLEVEL% == 0 (
  color 0A
  echo.
  echo  ================================================================
  echo    SUCCESS! ESP32 flashed!
  echo    WiFi SSID : ElderCare
  echo    Server    : ws://10.113.44.135:3001/ws/esp32
  echo    Baud rate : 115200  (open Serial Monitor to verify)
  echo  ================================================================
  echo.
  echo  Open Serial Monitor now? Run: serial_monitor.bat
) else (
  color 0C
  echo.
  echo  ================================================================
  echo    FAILED. Most likely cause: board not in boot mode.
  echo.
  echo   Try this sequence BEFORE running script:
  echo    1. Hold BOOT  (GPIO0 pin pulled LOW)
  echo    2. Tap EN/RST
  echo    3. Release BOOT
  echo    4. Blue LED should be OFF or dim
  echo    5. Press any key in THIS window
  echo.
  echo   Alternative: Connect GPIO0 directly to GND with a jumper wire
  echo   while pressing RST — then remove the wire after flash starts.
  echo  ================================================================
)
echo.
pause
