/*
 * ================================================================
 *  bpm_bracelet.ino — ESP32 Wearable BPM + SpO2 Monitor
 * ================================================================
 *  Hardware:
 *    • ESP32 Dev Module (2.4 GHz WiFi)
 *    • MAX30102 / MAX30105 Pulse Oximeter Sensor (I2C)
 *        VIN → 3V3, GND → GND, SDA → GPIO21, SCL → GPIO22
 *    • Optional 128x32 / 128x64 OLED Display (I2C 0x3C)
 *        Shares SDA (GPIO21) and SCL (GPIO22)
 *    • Optional Buzzer (GPIO4 or configured pin)
 *    • Built-in LED (GPIO2)
 *
 *  Algorithm:
 *    • High-Speed 400Hz Sampling (No digital averaging, 2.5ms interval)
 *    • Wire I2C Clock: Fast Mode (400 kHz)
 *    • Filtering: High-Pass IIR DC Filter + 4-Sample LPF Moving Average
 *    • BPM: Dynamic Peak Threshold with Exponential Decay & 300ms Refractory
 * Window • SpO2: Beat-to-Beat Cardiac-Cycle Peak-to-Peak Ratio of Ratios R =
 * (AC_red / DC_red) / (AC_ir / DC_ir) SpO2 = 104 - 17 * R
 * ================================================================
 */

#include "MAX30105.h"
#include "esp_wifi.h"
#include "heartRate.h"
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>

// ────────────────────────────────────────────────────────────────
//  WiFi / Server Configuration
// ────────────────────────────────────────────────────────────────
#define WIFI_SSID "ElderCare "
#define WIFI_PASS "ami bolbona"
#define SERVER_HOST "10.143.152.135"   // ← Updated: PC Wi-Fi IP (run ipconfig to verify)
#define SERVER_PORT 3001
#define SERVER_PATH "/ws/esp32"

// ────────────────────────────────────────────────────────────────
//  Hardware Pin Definitions (ESP32)
// ────────────────────────────────────────────────────────────────
#define I2C_SDA_PIN 21      // MAX30102 SDA & OLED SDA
#define I2C_SCL_PIN 22      // MAX30102 SCL & OLED SCL
#define LED_PIN 2           // Built-in LED on ESP32
#define BUZZER_PIN 4        // Buzzer Pin (set to -1 if no buzzer)
#define ENABLE_BUZZER false // Change to true if buzzer is wired

// ────────────────────────────────────────────────────────────────
//  OLED Display Settings
// ────────────────────────────────────────────────────────────────
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32 // Set to 64 if using 128x64 OLED
#define OLED_RESET -1

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledFound = false;

// ────────────────────────────────────────────────────────────────
//  Heart Rate & Sensor Objects
// ────────────────────────────────────────────────────────────────
MAX30105 particleSensor;
bool sensorFound = false;
WebSocketsClient ws;

#define FINGER_THRESHOLD 20000L  // IR value threshold for finger contact
#define BEAT_BEEP_MS     80       // Duration of pulse beep/flash in ms
#define REPORT_INTERVAL  250      // Send report every 250 ms (4 Hz) for instant dashboard

// ── Living Tissue Detection ───────────────────────────────────────
// A non-living object reflects IR but has zero pulsatile (AC) component.
// Perfusion Index = (AC amplitude / DC baseline) * 100
// Living tissue: PI typically 0.02%–20% | Dead/non-living: PI ≈ 0
#define MIN_PERFUSION_INDEX 0.30f  // Below this % → not a living finger
#define BEAT_TIMEOUT_MS     5000   // No beat for 5 s → reset BPM (non-living)

// ── BPM Dynamic Peak Detection State ─────────────────────────────
float currentBPM = 0.0f;
int beatAvg = 0;
float dynamicThreshold = 100.0f;
float runningMaxIR = -1e6f;
float runningMinIR = 1e6f;
float lastPeakVal = 200.0f;
float lastTroughVal = 0.0f;
float prevFilteredIR = 0.0f;
unsigned long lastPeakSample = 0;
unsigned long sampleCount = 0;
const unsigned long REFRACTORY_PERIOD_MS = 380; // Limits max BPM to ~158

// ── LPF (Moving Average) Variables ──────────────────────────────
const int LPF_WINDOW = 4;
float lpfBufferIR[LPF_WINDOW];
float lpfBufferRed[LPF_WINDOW];
int lpfIndex = 0;
float lpfSumIR = 0;
float lpfSumRed = 0;

// ── SpO2 State & DC-Filtered R-Ratio Method ─────────────────────
const float alpha =
    0.992f; // High-pass filter coefficient (~0.5Hz cutoff at 400Hz sample rate)
float dcIR = 0.0f;
float dcRed = 0.0f;

// Peak-to-peak tracking within each cardiac cycle
float cycleAcRedMax = -1e6f, cycleAcRedMin = 1e6f;
float cycleAcIRMax = -1e6f, cycleAcIRMin = 1e6f;

const byte SPO2_AVG_SIZE = 5;
int spo2Buffer[SPO2_AVG_SIZE];
byte spo2Spot = 0;
byte spo2Count = 0;
int estimatedSpo2 = 0;
bool spo2Valid = false;

// Runtime state variables
long latestIR = 0;
long latestRed = 0;
bool fingerDetected = false;
bool beatActive = false;
unsigned long beatTriggerMs = 0;
unsigned long lastReportMs = 0;
unsigned long lastSensorRetryMs = 0;
unsigned long lastDisplayMs = 0;
unsigned long bootMs = 0;
bool wifiOk = false;
bool wsConnected = false;
bool wsInitialized = false;

// Living tissue detection state
unsigned long lastBeatMs   = 0;     // millis() of last confirmed heartbeat peak
bool          livingTissue = false; // true only when PI + beat cadence confirm living finger
float         perfusionPct = 0.0f;  // current perfusion index %

const char *signalQuality = "none";

// ────────────────────────────────────────────────────────────────
//  Heart Bitmaps for OLED Animation
// ────────────────────────────────────────────────────────────────
static const unsigned char PROGMEM logo2_bmp[] = {
    0x03, 0xC0, 0xF0, 0x06, 0x71, 0x8C, 0x0C, 0x1B, 0x06, 0x18, 0x0E,
    0x02, 0x10, 0x0C, 0x03, 0x10, 0x04, 0x01, 0x10, 0x04, 0x01, 0x10,
    0x40, 0x01, 0x10, 0x40, 0x01, 0x10, 0xC0, 0x03, 0x08, 0x88, 0x02,
    0x08, 0xB8, 0x04, 0xFF, 0x37, 0x08, 0x01, 0x30, 0x18, 0x01, 0x90,
    0x30, 0x00, 0xC0, 0x60, 0x00, 0x60, 0xC0, 0x00, 0x31, 0x80, 0x00,
    0x1B, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x04, 0x00};

static const unsigned char PROGMEM logo3_bmp[] = {
    0x01, 0xF0, 0x0F, 0x80, 0x06, 0x1C, 0x38, 0x60, 0x18, 0x06, 0x60, 0x18,
    0x10, 0x01, 0x80, 0x08, 0x20, 0x01, 0x80, 0x04, 0x40, 0x00, 0x00, 0x02,
    0x40, 0x00, 0x00, 0x02, 0xC0, 0x00, 0x08, 0x03, 0x80, 0x00, 0x08, 0x01,
    0x80, 0x00, 0x18, 0x01, 0x80, 0x00, 0x1C, 0x01, 0x80, 0x00, 0x14, 0x00,
    0x80, 0x00, 0x14, 0x00, 0x80, 0x00, 0x14, 0x00, 0x40, 0x10, 0x12, 0x00,
    0x40, 0x10, 0x12, 0x00, 0x7E, 0x1F, 0x23, 0xFE, 0x03, 0x31, 0xA0, 0x04,
    0x01, 0xA0, 0xA0, 0x0C, 0x00, 0xA0, 0xA0, 0x08, 0x00, 0x60, 0xE0, 0x10,
    0x00, 0x20, 0x60, 0x20, 0x06, 0x00, 0x40, 0x60, 0x03, 0x00, 0x40, 0xC0,
    0x01, 0x80, 0x01, 0x80, 0x00, 0xC0, 0x03, 0x00, 0x00, 0x60, 0x06, 0x00,
    0x00, 0x60, 0x06, 0x00, 0x00, 0x30, 0x0C, 0x00, 0x00, 0x08, 0x10, 0x00,
    0x00, 0x06, 0x60, 0x00, 0x00, 0x03, 0xC0, 0x00, 0x00, 0x01, 0x80, 0x00};

// ────────────────────────────────────────────────────────────────
//  DC Removal Filter (High-Pass Filter)
// ────────────────────────────────────────────────────────────────
float removeDC_IR(uint32_t rawSample) {
  dcIR = (alpha * dcIR) + ((1.0f - alpha) * rawSample);
  return (float)rawSample - dcIR;
}

float removeDC_Red(uint32_t rawSample) {
  dcRed = (alpha * dcRed) + ((1.0f - alpha) * rawSample);
  return (float)rawSample - dcRed;
}

// ────────────────────────────────────────────────────────────────
//  Low-Pass Filter (Moving Average)
// ────────────────────────────────────────────────────────────────
float lowPassIR(float input) {
  lpfSumIR -= lpfBufferIR[lpfIndex];
  lpfBufferIR[lpfIndex] = input;
  lpfSumIR += input;
  return lpfSumIR / (float)LPF_WINDOW;
}

float lowPassRed(float input) {
  lpfSumRed -= lpfBufferRed[lpfIndex];
  lpfBufferRed[lpfIndex] = input;
  lpfSumRed += input;
  float out = lpfSumRed / (float)LPF_WINDOW;
  lpfIndex = (lpfIndex + 1) % LPF_WINDOW;
  return out;
}

// ────────────────────────────────────────────────────────────────
//  Reset Vitals State
// ────────────────────────────────────────────────────────────────
void resetVitals() {
  currentBPM = 0.0f;
  beatAvg = 0;
  dynamicThreshold = 100.0f;
  runningMaxIR = -1e6f;
  runningMinIR = 1e6f;
  lastPeakVal = 200.0f;
  lastTroughVal = 0.0f;
  prevFilteredIR = 0.0f;
  lastPeakSample = 0;
  sampleCount = 0;

  dcIR = 0.0f;
  dcRed = 0.0f;
  cycleAcRedMax = -1e6f;
  cycleAcRedMin = 1e6f;
  cycleAcIRMax = -1e6f;
  cycleAcIRMin = 1e6f;

  estimatedSpo2 = 0;
  spo2Valid = false;
  spo2Spot = 0;
  spo2Count = 0;
  for (byte i = 0; i < SPO2_AVG_SIZE; i++)
    spo2Buffer[i] = 0;

  lpfSumIR = 0;
  lpfSumRed = 0;
  lpfIndex = 0;
  for (int i = 0; i < LPF_WINDOW; i++) {
    lpfBufferIR[i] = 0.0f;
    lpfBufferRed[i] = 0.0f;
  }
}

// ────────────────────────────────────────────────────────────────
//  Compute SpO2 from Peak-to-Peak AC and DC baselines
// ────────────────────────────────────────────────────────────────
void computeSpO2() {
  float redPTP = cycleAcRedMax - cycleAcRedMin;
  float irPTP = cycleAcIRMax - cycleAcIRMin;

  // Reset cycle extrema for the next pulse cycle
  cycleAcRedMax = -1e6f;
  cycleAcRedMin = 1e6f;
  cycleAcIRMax = -1e6f;
  cycleAcIRMin = 1e6f;

  // Require measurable pulsatile AC amplitude and valid DC level
  if (redPTP < 10.0f || irPTP < 10.0f)
    return;
  if (dcIR < 5000.0f || dcRed < 5000.0f)
    return;

  float rRed = redPTP / dcRed;
  float rIR = irPTP / dcIR;

  if (rIR < 0.0001f)
    return;

  float R = rRed / rIR;

  // Standard Empirical SpO2 Calibration for MAX30102
  // R ~ 0.40 -> 100%, R ~ 0.52 -> 97%, R ~ 0.80 -> 90%
  float rawSpo2 = 104.0f - 17.0f * R;

  if (rawSpo2 > 100.0f)
    rawSpo2 = 100.0f;
  if (rawSpo2 < 70.0f)
    rawSpo2 = 70.0f;

  int spo2Val = (int)round(rawSpo2);

  if (spo2Val >= 75 && spo2Val <= 100) {
    spo2Buffer[spo2Spot] = spo2Val;
    spo2Spot = (spo2Spot + 1) % SPO2_AVG_SIZE;
    if (spo2Count < SPO2_AVG_SIZE)
      spo2Count++;

    int sum = 0;
    for (byte i = 0; i < spo2Count; i++) {
      sum += spo2Buffer[i];
    }
    estimatedSpo2 = sum / spo2Count;
    spo2Valid = true;
  }
}

// ────────────────────────────────────────────────────────────────
//  Update Signal Quality Indicator
// ────────────────────────────────────────────────────────────────
void updateSignalQuality() {
  if (latestIR > 80000L) {
    signalQuality = "excellent";
  } else if (latestIR > 45000L) {
    signalQuality = "good";
  } else if (latestIR > 25000L) {
    signalQuality = "fair";
  } else if (latestIR > FINGER_THRESHOLD) {
    signalQuality = "weak";
  } else {
    signalQuality = "none";
  }
}

// ────────────────────────────────────────────────────────────────
//  Process Each Genuine Sample from MAX30102 FIFO
// ────────────────────────────────────────────────────────────────
void processSample(uint32_t red, uint32_t ir) {
  latestIR = (long)ir;
  latestRed = (long)red;
  updateSignalQuality();

  if (ir < FINGER_THRESHOLD) {
    if (fingerDetected) {
      fingerDetected = false;
      resetVitals();
    }
    return;
  }

  fingerDetected = true;
  sampleCount++;

  // Step A: Signal Filtering
  float acIR = removeDC_IR(ir);
  float acRed = removeDC_Red(red);

  float filteredIR = lowPassIR(acIR);
  float filteredRed = lowPassRed(acRed);

  // Track Peak-to-Peak amplitudes within current cardiac cycle (for SpO2 calculation)
  if (filteredRed > cycleAcRedMax)
    cycleAcRedMax = filteredRed;
  if (filteredRed < cycleAcRedMin)
    cycleAcRedMin = filteredRed;
  if (filteredIR > cycleAcIRMax)
    cycleAcIRMax = filteredIR;
  if (filteredIR < cycleAcIRMin)
    cycleAcIRMin = filteredIR;

  // Track running max and min of the filtered signal during the current cardiac cycle
  if (filteredIR > runningMaxIR) {
    runningMaxIR = filteredIR;
  }
  if (filteredIR < runningMinIR) {
    runningMinIR = filteredIR;
  }

  // Calculate elapsed time since last beat
  unsigned long sampleDelta = sampleCount - lastPeakSample;
  float timeDeltaMs = sampleDelta * 2.5f; // 400Hz sample rate = 2.5ms interval per sample

  // Step B: If no beat is detected for 1.5 seconds, slowly decay threshold to prevent getting stuck
  if (timeDeltaMs > 1500.0f) {
    dynamicThreshold *= 0.998f;
    if (dynamicThreshold < 50.0f) {
      dynamicThreshold = 50.0f;
    }
  }

  // Step C: Peak Trigger Check (Positive zero/threshold crossing)
  if (filteredIR > dynamicThreshold && prevFilteredIR <= dynamicThreshold && filteredIR > 50.0f) {
    if (timeDeltaMs > (float)REFRACTORY_PERIOD_MS) {
      // Valid beat detected!
      if (lastPeakSample > 0) {
        float instantBPM = 60000.0f / timeDeltaMs;

        if (instantBPM >= 40.0f && instantBPM <= 200.0f) {
          if (currentBPM < 30.0f) {
            currentBPM = instantBPM; // Seed immediately — no warm-up delay
          } else {
            // Faster EMA (60/40) → responds quicker to real BPM changes
            currentBPM = (currentBPM * 0.60f) + (instantBPM * 0.40f);
          }
          beatAvg = (int)round(currentBPM);
          lastBeatMs = millis(); // Record time of this confirmed beat
        }
      }

      beatActive = true;
      beatTriggerMs = millis(); // Turn-off time scheduling is fine using CPU millisecond
      digitalWrite(LED_PIN, HIGH);
      if (ENABLE_BUZZER && BUZZER_PIN >= 0) {
        digitalWrite(BUZZER_PIN, HIGH);
      }

      lastPeakSample = sampleCount;

      // Update adaptive threshold parameters for the next cycle
      lastPeakVal = runningMaxIR;
      lastTroughVal = runningMinIR;

      float amplitude = lastPeakVal - lastTroughVal;
      if (amplitude > 50.0f && amplitude < 3000.0f) {
        dynamicThreshold = lastTroughVal + (amplitude * 0.6f);
      } else {
        dynamicThreshold = 100.0f; // Fallback threshold
      }

      // Reset running peak trackers for the new cycle
      runningMaxIR = filteredIR;
      runningMinIR = filteredIR;

      // Calculate SpO2 on each detected cardiac cycle peak
      computeSpO2();
    }
  }

  prevFilteredIR = filteredIR;
}

// ────────────────────────────────────────────────────────────────
//  WebSocket Event Handler
// ────────────────────────────────────────────────────────────────
void wsEventHandler(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    wsConnected = true;
    Serial.printf("[WS] Connected to ws://%s:%d%s\n", SERVER_HOST, SERVER_PORT,
                  SERVER_PATH);
    break;
  case WStype_DISCONNECTED:
    wsConnected = false;
    Serial.println(F("[WS] Disconnected."));
    break;
  case WStype_ERROR:
    wsConnected = false;
    Serial.println(F("[WS] Error."));
    break;
  default:
    break;
  }
}

// ────────────────────────────────────────────────────────────────
//  WiFi Event Handler
// ────────────────────────────────────────────────────────────────
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
  case ARDUINO_EVENT_WIFI_STA_START:
    Serial.println(
        F("[WiFi] Station Started. Scanning channels 1-13 for 'ElderCare'..."));
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    break;
  case ARDUINO_EVENT_WIFI_STA_CONNECTED:
    Serial.println(
        F("[WiFi] Associated with 'ElderCare' AP! Waiting for IP..."));
    break;
  case ARDUINO_EVENT_WIFI_STA_GOT_IP:
    wifiOk = true;
    Serial.printf("\n[WiFi] Connected! IP: %s | Gateway: %s\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.gatewayIP().toString().c_str());
    if (!wsInitialized) {
      ws.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
      ws.onEvent(wsEventHandler);
      ws.setReconnectInterval(3000);
      wsInitialized = true;
      Serial.printf("[WS] Initialized -> ws://%s:%d%s\n", SERVER_HOST,
                    SERVER_PORT, SERVER_PATH);
    }
    break;
  case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
    wifiOk = false;
    wsConnected = false;
    Serial.printf("[WiFi] Disconnected (Reason code: %d). Retrying...\n",
                  info.wifi_sta_disconnected.reason);
    break;
  default:
    break;
  }
}

// ────────────────────────────────────────────────────────────────
//  Try Initializing MAX30102 Sensor
// ────────────────────────────────────────────────────────────────
bool initSensor() {
  if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    byte powerLevel = 0x1F; // ~6.4mA LED current
    byte sampleAverage = 1; // No FIFO sample averaging
    byte ledMode = 2;       // Red + IR mode
    int sampleRate = 400;   // 400 Hz sampling rate
    int pulseWidth = 215;   // 17-bit resolution
    int adcRange = 4096;    // 4096nA dynamic range

    particleSensor.setup(powerLevel, sampleAverage, ledMode, sampleRate,
                         pulseWidth, adcRange);
    particleSensor.setPulseAmplitudeRed(powerLevel);
    particleSensor.setPulseAmplitudeIR(powerLevel);
    particleSensor.setPulseAmplitudeGreen(0);
    particleSensor.enableFIFORollover();
    sensorFound = true;
    Serial.println(
        F("[SENSOR] MAX30102 OK! (400Hz, Red+IR, Avg1, 17-bit, 400kHz I2C)"));
    return true;
  }
  sensorFound = false;
  return false;
}

// ────────────────────────────────────────────────────────────────
//  Update OLED Display
// ────────────────────────────────────────────────────────────────
void updateDisplay() {
  if (!oledFound)
    return;
  if (millis() - lastDisplayMs < 50)
    return;
  lastDisplayMs = millis();

  display.clearDisplay();

  if (fingerDetected) {
    if (beatActive) {
      display.drawBitmap(0, 0, logo3_bmp, 32, 32, SSD1306_WHITE);
    } else {
      display.drawBitmap(5, 5, logo2_bmp, 24, 21, SSD1306_WHITE);
    }

    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);

    display.setCursor(42, 2);
    if (beatAvg > 0) {
      display.print(beatAvg);
      display.print(" BPM");
    } else {
      display.print("Sensing...");
    }

    display.setCursor(42, 14);
    if (spo2Valid && estimatedSpo2 > 0) {
      display.print("SpO2: ");
      display.print(estimatedSpo2);
      display.print("%");
    } else {
      display.print("SpO2: ---");
    }

    display.setCursor(42, 25);
    display.setTextSize(1);
    display.print("Sig: ");
    display.print(signalQuality);

  } else {
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(16, 6);
    display.println(F("Elder-Care Bracelet"));
    display.setCursor(10, 18);
    display.println(F("Please place finger"));
  }

  display.display();
}

// ────────────────────────────────────────────────────────────────
//  Periodic Vitals Report
// ────────────────────────────────────────────────────────────────
void reportVitals() {
  long uptime = (long)((millis() - bootMs) / 1000UL);

  // ── Living tissue check ────────────────────────────────────────
  // Perfusion Index = AC amplitude / DC baseline × 100 %
  // Only living tissue has a pulsatile (heartbeat) AC component.
  if (fingerDetected && dcIR > 5000.0f) {
    float acAmplitude = runningMaxIR - runningMinIR; // filtered peak-to-peak
    perfusionPct = (acAmplitude / dcIR) * 100.0f;
  } else {
    perfusionPct = 0.0f;
  }

  // Beat timeout: if no beat for BEAT_TIMEOUT_MS, reset — non-living object
  bool beatRecent = (lastBeatMs > 0) && (millis() - lastBeatMs < BEAT_TIMEOUT_MS);
  if (fingerDetected && !beatRecent) {
    // No heartbeat peaks detected — clear BPM so dashboard shows "--"
    currentBPM = 0.0f;
    beatAvg    = 0;
  }

  // Living tissue = IR above threshold + meaningful PI% + recent heartbeat
  livingTissue = fingerDetected
                 && (perfusionPct >= MIN_PERFUSION_INDEX)
                 && beatRecent;

  Serial.println(F("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  if (fingerDetected) {
    Serial.printf("  Finger   : DETECTED (IR: %ld, Red: %ld)\n", latestIR, latestRed);
    Serial.printf("  PI%%      : %.2f%% (%s)\n", perfusionPct,
                  livingTissue ? "LIVING" : "non-living/warming up");
    Serial.printf("  Live BPM : %.1f | Avg BPM: %d\n", currentBPM, beatAvg);
    Serial.printf("  SpO2     : %d %% (%s)\n",
                  spo2Valid ? estimatedSpo2 : 0,
                  spo2Valid ? "valid" : "sensing");
    Serial.printf("  Signal   : %s\n", signalQuality);
  } else {
    Serial.println(F("  Finger   : NOT DETECTED"));
  }
  Serial.printf("  WiFi     : %s | WS: %s | Uptime: %ld s\n",
                wifiOk ? "OK" : "Offline",
                wsConnected ? "OK" : "No",
                uptime);

  if (wsConnected) {
    // Only report non-zero BPM/SpO2 for confirmed living tissue.
    // Dashboard shows '--' (No Signal) for non-living objects.
    bool validReading = livingTissue && beatAvg > 0;
    int  reportBpm   = validReading ? beatAvg : 0;
    int  reportSpo2  = (validReading && spo2Valid) ? estimatedSpo2 : 0;

    char json[320];
    snprintf(json, sizeof(json),
             "{"
             "\"type\":\"vitals\","
             "\"bpm\":%d,"
             "\"spo2\":%d,"
             "\"irValue\":%ld,"
             "\"redValue\":%ld,"
             "\"fingerDetected\":%s,"
             "\"signal\":\"%s\","
             "\"uptime\":%ld,"
             "\"perfusionPct\":%.2f"
             "}",
             reportBpm, reportSpo2, latestIR, latestRed,
             livingTissue ? "true" : "false",
             signalQuality, uptime, perfusionPct);
    ws.sendTXT(json);
    Serial.printf("  WS Sent  : BPM=%d SpO2=%d living=%s PI=%.2f%%\n",
                  reportBpm, reportSpo2,
                  livingTissue ? "YES" : "NO", perfusionPct);
  }
  Serial.println(F("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
}

// ────────────────────────────────────────────────────────────────
//  SETUP
// ────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);
  bootMs = millis();

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  if (ENABLE_BUZZER && BUZZER_PIN >= 0) {
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
  }

  Serial.println();
  Serial.println(F("╔══════════════════════════════════════════════╗"));
  Serial.println(F("║   Elder-Care — ESP32 BPM + SpO2 Monitor     ║"));
  Serial.println(F("║   MAX30102 DC-Filtered R-Ratio Algorithm     ║"));
  Serial.println(F("╚══════════════════════════════════════════════╝"));

  // 1. Initialize I2C Bus for ESP32 with 400kHz fast speed
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);

  // 2. Initialize OLED Display (Optional)
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledFound = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(18, 10);
    display.println(F("Elder-Care System"));
    display.display();
    Serial.println(F("[OLED]   SSD1306 initialized at 0x3C"));
  }

  // 3. Initialize MAX30102 Sensor
  Serial.print(F("[SENSOR] Initializing MAX30102..."));
  if (initSensor()) {
    Serial.println(F(" OK!"));
  } else {
    Serial.println(
        F("\n[WARN]   MAX30102 not detected on I2C. Will retry in loop."));
  }

  // 4. Initialize SpO2 state
  resetVitals();

  // 5. Connect WiFi to ElderCare Hotspot
  Serial.println(F("[WiFi] Scanning visible networks..."));
  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d networks:\n", n);
  for (int i = 0; i < n; ++i) {
    Serial.printf("  %2d: '%s' (RSSI: %d, Ch: %d, Auth: %d)\n", i + 1,
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i),
                  (int)WiFi.encryptionType(i));
  }

  Serial.printf("[WiFi] Connecting to '%s'...\n", WIFI_SSID);
  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  lastReportMs = millis();
}

// ────────────────────────────────────────────────────────────────
//  LOOP
// ────────────────────────────────────────────────────────────────
void loop() {
  // Maintain WebSocket
  if (wifiOk && wsInitialized) {
    ws.loop();
  }

  // Retry sensor initialization if not found initially
  if (!sensorFound && (millis() - lastSensorRetryMs > 3000)) {
    lastSensorRetryMs = millis();
    initSensor();
  }

  // If sensor is active, read data
  if (sensorFound) {
    particleSensor.check(); // Check sensor FIFO for new data

    while (particleSensor.available()) {
      uint32_t rawRed = particleSensor.getFIFORed();
      uint32_t rawIR = particleSensor.getFIFOIR();
      particleSensor.nextSample(); // Advance FIFO tail pointer

      processSample(rawRed, rawIR);
    }
  }

  // Handle pulse LED turn off
  if (beatActive && (millis() - beatTriggerMs >= BEAT_BEEP_MS)) {
    beatActive = false;
    digitalWrite(LED_PIN, LOW);
    if (ENABLE_BUZZER && BUZZER_PIN >= 0) {
      digitalWrite(BUZZER_PIN, LOW);
    }
  }

  // Update OLED Animation & Text
  updateDisplay();

  // Periodic Vitals Output
  if (millis() - lastReportMs >= REPORT_INTERVAL) {
    reportVitals();
    lastReportMs = millis();
  }
}