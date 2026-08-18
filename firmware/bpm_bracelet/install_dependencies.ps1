<#
.SYNOPSIS
    Installs all Arduino dependencies for bpm_bracelet.ino (Elder-Care Wearable)

.LIBRARIES INSTALLED
    1. SparkFun MAX3010x Pulse and Proximity Sensor Library
       (provides: MAX30105.h, heartRate.h, spo2_algorithm.h)
    2. WebSockets by Markus Sattler
       (provides: WebSocketsClient.h)

.BOARD PACKAGE (ESP32 core - provides: Wire.h, WiFi.h)
    Installed via arduino-cli if present, otherwise instructions are printed.

.USAGE
    Run this script ONCE from PowerShell:
        cd d:\Elder--Care\firmware\bpm_bracelet
        .\install_dependencies.ps1
#>

$ErrorActionPreference = "Stop"

# Paths
$ArduinoLibDir = "$env:USERPROFILE\Documents\Arduino\libraries"
$TempDir       = "$env:TEMP\arduino_deps"

New-Item -ItemType Directory -Force -Path $ArduinoLibDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir       | Out-Null

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Elder-Care BPM Bracelet - Arduino Dependency Installer" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# Helper: Download + Extract ZIP
function Install-ArduinoLib {
    param(
        [string]$Name,
        [string]$Url,
        [string]$ZipInternalDir
    )

    $dest = Join-Path $ArduinoLibDir $Name

    if (Test-Path $dest) {
        Write-Host "[SKIP]  $Name already exists at:" -ForegroundColor Yellow
        Write-Host "        $dest"
        Write-Host ""
        return
    }

    Write-Host "[GET]   Downloading $Name ..." -ForegroundColor Green
    $zip = Join-Path $TempDir "$Name.zip"
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing

    Write-Host "[UNZIP] Extracting $Name ..."
    $extractTo = Join-Path $TempDir "$Name-extracted"
    Expand-Archive -Path $zip -DestinationPath $extractTo -Force

    $inner = Join-Path $extractTo $ZipInternalDir
    if (-not (Test-Path $inner)) {
        $inner = (Get-ChildItem $extractTo -Directory | Select-Object -First 1).FullName
    }

    Copy-Item -Path $inner -Destination $dest -Recurse -Force
    Write-Host "[OK]    $Name installed to:" -ForegroundColor Green
    Write-Host "        $dest"
    Write-Host ""
}

# 1. SparkFun MAX3010x Library (MAX30105.h, heartRate.h, spo2_algorithm.h)
Install-ArduinoLib `
    -Name           "SparkFun_MAX3010x_Sensor_Library" `
    -Url            "https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library/archive/refs/heads/master.zip" `
    -ZipInternalDir "SparkFun_MAX3010x_Sensor_Library-master"

# 2. WebSockets by Markus Sattler (WebSocketsClient.h)
Install-ArduinoLib `
    -Name           "arduinoWebSockets" `
    -Url            "https://github.com/Links2004/arduinoWebSockets/archive/refs/heads/master.zip" `
    -ZipInternalDir "arduinoWebSockets-master"

# 3. ESP32 Board Package (Wire.h / WiFi.h)
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  ESP32 Board Package (Wire.h + WiFi.h)"                   -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$arduinoCli = Get-Command arduino-cli -ErrorAction SilentlyContinue

if ($arduinoCli) {
    Write-Host "[CLI]   arduino-cli found. Installing ESP32 board package ..." -ForegroundColor Green
    arduino-cli config add board_manager.additional_urls "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json"
    arduino-cli core update-index
    arduino-cli core install esp32:esp32
    Write-Host ""
    Write-Host "[OK]    ESP32 core installed. Wire.h and WiFi.h are now available." -ForegroundColor Green
} else {
    Write-Host "[INFO]  arduino-cli not found. Install ESP32 board manually in Arduino IDE:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. File > Preferences > Additional Boards Manager URLs, paste:"
    Write-Host "     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  2. Tools > Board > Boards Manager > search 'esp32'"
    Write-Host "     > Install 'esp32 by Espressif Systems'"
    Write-Host ""
    Write-Host "  3. Tools > Board > esp32 > 'ESP32 Dev Module'"
    Write-Host ""
}

# Cleanup
Write-Host "Cleaning up temp files ..." -ForegroundColor DarkGray
Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue

# Summary
Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Done! Libraries installed to:"                           -ForegroundColor Cyan
Write-Host "  $ArduinoLibDir"                                         -ForegroundColor White
Write-Host ""
Write-Host "  Open bpm_bracelet.ino in Arduino IDE,"                  -ForegroundColor White
Write-Host "  select Tools > Board > esp32 > ESP32 Dev Module,"       -ForegroundColor White
Write-Host "  and hit Compile."                                        -ForegroundColor White
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
