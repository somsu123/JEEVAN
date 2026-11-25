@echo off
setlocal
color 0A

set ESPTOOL=C:\Users\somsubhro\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe
set BIN_DIR=d:\JEEVAN\firmware\fall_bracelet\build
set PORT=COM14

echo.
echo  =================================================================
echo    JEEVAN FALL BELT — FLASH TO COM14
echo  =================================================================
echo.
echo  STEP 1: Hold [BOOT] button on ESP32
echo  STEP 2: Press+release [EN] or [RST] button
echo  STEP 3: Release [BOOT]
echo  STEP 4: Press any key here within 3 seconds...
echo.
pause >nul

echo  Flashing...
echo.

"%ESPTOOL%" ^
  --chip esp32 ^
  --port %PORT% ^
  --baud 460800 ^
  --before default-reset ^
  --after hard-reset ^
  --connect-attempts 10 ^
  write-flash ^
  -z ^
  --flash-mode dio ^
  --flash-freq 80m ^
  --flash-size detect ^
  0x1000  "%BIN_DIR%\fall_bracelet.ino.bootloader.bin" ^
  0x8000  "%BIN_DIR%\fall_bracelet.ino.partitions.bin" ^
  0x10000 "%BIN_DIR%\fall_bracelet.ino.bin"

if %ERRORLEVEL% == 0 (
  color 0A
  echo.
  echo  =================================================================
  echo    SUCCESS! Belt firmware flashed.
  echo    Press [EN]/[RST] on the ESP32 to boot normally.
  echo    Then open serial monitor to see calibration prompt.
  echo  =================================================================
) else (
  color 0C
  echo.
  echo  FLASH FAILED - make sure you held BOOT before pressing EN/RST
  echo  Try again: Hold BOOT -> tap EN/RST -> release BOOT -> press key
)
echo.
pause
