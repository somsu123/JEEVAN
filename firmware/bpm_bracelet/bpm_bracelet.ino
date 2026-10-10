/*
 * ================================================================
 * *  bpm_bracelet.ino — ESP32 Wearable BPM + SpO2 Monitor
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
#include "esp_idf_version.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_wifi.h"
#include <Preferences.h>
#include <ESPmDNS.h>
#include "heartRate.h"
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

// ────────────────────────────────────────────────────────────────
//  WiFi / Server Configuration
// ────────────────────────────────────────────────────────────────
#define WIFI_SSID "ElderCare "
#define WIFI_PASS "ami bolbona"
#define SERVER_MDNS_HOST "bpm-server" // [FIX #1] ESPmDNS queryHost expects a bare host name.
#define SERVER_WINDOWS_HOST "LAPTOP-RSME6K8B" // Windows native mDNS hostname (A-record)
#define SERVER_FALLBACK_IP IPAddress(10, 122, 37, 135) // Direct IP fallback when mDNS is blocked/unavailable on Windows
#define SERVER_PORT 3001
#define SERVER_PATH "/ws/esp32"

#define SENSOR_SAMPLE_RATE_HZ 400U
#define SENSOR_I2C_ADDRESS 0x57
#define MAX30102_OVF_COUNTER_REG 0x05
#define FIFO_RING_SIZE 1024U
#define FIFO_RING_MASK (FIFO_RING_SIZE - 1U)
#define SENSOR_INIT_FAILURE_LIMIT 5U

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
WebSocketsClient ws;

#define FINGER_THRESHOLD 8000L  // IR value threshold for finger contact
#define BEAT_BEEP_MS 80         // Duration of pulse beep/flash in ms
#define REPORT_INTERVAL                                                        \
  250 // Send report every 250 ms (4 Hz) for instant dashboard

// ── Living Tissue Detection ───────────────────────────────────────
// A non-living object reflects IR but has zero pulsatile (AC) component.
// Perfusion Index = (AC amplitude / DC baseline) * 100
// Living tissue: PI typically 0.02%–20% | Dead/non-living: PI ≈ 0
#define MIN_PERFUSION_INDEX 0.05f // Below this % → not a living finger
#define BEAT_TIMEOUT_MS 5000      // No beat for 5 s → reset BPM (non-living)

// ── BPM Dynamic Peak Detection State ─────────────────────────────
float currentBPM = 0.0f;
int beatAvg = 0;
float dynamicThreshold = 100.0f;
float runningMaxIR = -1e6f;
float runningMinIR = 1e6f;
float lastPeakVal = 200.0f;
float lastTroughVal = 0.0f;
float prevFilteredIR = 0.0f;
uint64_t lastPeakSample = 0;
uint64_t sampleCount = 0; // [FIX #6] 64-bit monotonically increasing sample timebase.
const unsigned long REFRACTORY_PERIOD_MS = 300; // Limits max BPM to ~200 (matches 300ms window)

// ── LPF (Moving Average) Variables ──────────────────────────────
const int LPF_WINDOW = 4;
float lpfBufferIR[LPF_WINDOW];
float lpfBufferRed[LPF_WINDOW];
int lpfIndexIR = 0; // [FIX #7] Independent per-channel filter state
int lpfIndexRed = 0;
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
String activeSSID = WIFI_SSID;
long latestIR = 0;
long latestRed = 0;
bool fingerDetected = false;
bool beatActive = false;
unsigned long beatTriggerMs = 0;
unsigned long lastReportMs = 0;
unsigned long lastSensorRetryMs = 0;
unsigned long lastDisplayMs = 0;
unsigned long lastWsRetryMs = 0;
unsigned long lastSerialMs = 0;
unsigned long wsRetryDelayMs = 15000;
unsigned long bootMs = 0;
volatile bool wifiOk = false;
volatile bool wsConnected = false;
bool wsInitialized = false; // Loop task owns all WebSocket lifecycle calls
bool serverResolved = false;
bool mdnsStarted = false;
volatile bool wifiGotIpEvent = false;
volatile bool wifiDisconnectedEvent = false;
volatile uint8_t wifiDisconnectReason = 0;
volatile bool sensorFound = false;
volatile bool sensorError = false;
volatile uint32_t sensorInitFailures = 0;
volatile uint32_t fifoOverflowCount = 0;
volatile uint32_t ringOverflowCount = 0;
volatile uint32_t pipelineResyncCount = 0;
IPAddress serverAddress;
IPAddress cachedServerAddress;
Preferences preferences;
SemaphoreHandle_t i2cMutex = nullptr;
TaskHandle_t fifoTaskHandle = nullptr;
volatile bool sensorTaskReady = false;

// [FIX #4] Fixed-size lock-free SPSC ring. Core 0 produces; loop/Core 1 consumes.
struct SensorSample {
  uint32_t red;
  uint32_t ir;
  uint64_t sequence;
  bool gapBefore;
};
static SensorSample sampleRing[FIFO_RING_SIZE];
static volatile uint32_t ringHead = 0;
static volatile uint32_t ringTail = 0;
static uint64_t sensorSampleSequence = 0; // Producer-only, overflow-safe counter
static bool sensorTaskPendingGap = false; // Producer-only
static bool sensorErrorHandled = false;   // Loop-only

// Living tissue detection state
unsigned long lastBeatMs = 0; // millis() of last confirmed heartbeat peak
bool livingTissue =
    false; // true only when PI + beat cadence confirm living finger
float perfusionPct = 0.0f; // current perfusion index %

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
  lpfSumIR -= lpfBufferIR[lpfIndexIR];
  lpfBufferIR[lpfIndexIR] = input;
  lpfSumIR += input;
  float out = lpfSumIR / (float)LPF_WINDOW;
  lpfIndexIR = (lpfIndexIR + 1) % LPF_WINDOW;
  return out;
}

float lowPassRed(float input) {
  lpfSumRed -= lpfBufferRed[lpfIndexRed];
  lpfBufferRed[lpfIndexRed] = input;
  lpfSumRed += input;
  float out = lpfSumRed / (float)LPF_WINDOW;
  lpfIndexRed = (lpfIndexRed + 1) % LPF_WINDOW;
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
  // Keep sampleCount monotonic across finger transitions and pipeline resets.
  lastPeakSample = sampleCount; // [FIX #6] Restart beat intervals at this sample.
  lastBeatMs = 0;              // [FIX #8] Do not reuse a prior finger's beat.
  livingTissue = false;
  perfusionPct = 0.0f;

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
  lpfIndexIR = 0;
  lpfIndexRed = 0;
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
  if (latestIR >= 25000L) {
    signalQuality = "excellent";
  } else if (latestIR >= 16000L) {
    signalQuality = "good";
  } else if (latestIR >= 10000L) {
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
bool pushSensorSample(uint32_t red, uint32_t ir, uint64_t sequence,
                      bool gapBefore) {
  const uint32_t head = __atomic_load_n(&ringHead, __ATOMIC_RELAXED);
  const uint32_t tail = __atomic_load_n(&ringTail, __ATOMIC_ACQUIRE);
  if ((uint32_t)(head - tail) >= FIFO_RING_SIZE) {
    __atomic_add_fetch(&ringOverflowCount, 1, __ATOMIC_RELAXED);
    sensorTaskPendingGap = true;
    return false;
  }

  SensorSample &slot = sampleRing[head & FIFO_RING_MASK];
  slot.red = red;
  slot.ir = ir;
  slot.sequence = sequence;
  slot.gapBefore = gapBefore || sensorTaskPendingGap;
  sensorTaskPendingGap = false;
  __atomic_store_n(&ringHead, head + 1U, __ATOMIC_RELEASE);
  return true;
}

bool popSensorSample(SensorSample &sample) {
  const uint32_t tail = __atomic_load_n(&ringTail, __ATOMIC_RELAXED);
  const uint32_t head = __atomic_load_n(&ringHead, __ATOMIC_ACQUIRE);
  if (tail == head) return false;

  sample = sampleRing[tail & FIFO_RING_MASK];
  __atomic_store_n(&ringTail, tail + 1U, __ATOMIC_RELEASE);
  return true;
}

void processSample(uint32_t red, uint32_t ir, uint64_t sequence,
                   bool gapBefore) {
  static uint16_t fingerOffCount = 0;
  sampleCount = sequence;
  if (gapBefore) { // Preserve running BPM/SpO2 across temporary ring buffer resyncs
    lastPeakSample = sampleCount;
    __atomic_add_fetch(&pipelineResyncCount, 1, __ATOMIC_RELAXED);
  }
  latestIR = (long)ir;
  latestRed = (long)red;
  updateSignalQuality();

  if (ir < FINGER_THRESHOLD) {
    if (fingerDetected) {
      if (++fingerOffCount >= 100) {
        fingerOffCount = 0;
      fingerDetected = false;
      resetVitals();
      }
    }
    return;
  }

  fingerOffCount = 0;
  fingerDetected = true;

  // Step A: Signal Filtering
  float acIR = removeDC_IR(ir);
  float acRed = removeDC_Red(red);

  float filteredIR = lowPassIR(acIR);
  float filteredRed = lowPassRed(acRed);

  // Track Peak-to-Peak amplitudes within current cardiac cycle (for SpO2
  // calculation)
  if (filteredRed > cycleAcRedMax)
    cycleAcRedMax = filteredRed;
  if (filteredRed < cycleAcRedMin)
    cycleAcRedMin = filteredRed;
  if (filteredIR > cycleAcIRMax)
    cycleAcIRMax = filteredIR;
  if (filteredIR < cycleAcIRMin)
    cycleAcIRMin = filteredIR;

  // Track running max and min of the filtered signal during the current cardiac
  // cycle
  if (filteredIR > runningMaxIR) {
    runningMaxIR = filteredIR;
  }
  if (filteredIR < runningMinIR) {
    runningMinIR = filteredIR;
  }

  // Calculate elapsed time since last beat
  uint64_t sampleDelta = sampleCount - lastPeakSample;
  float timeDeltaMs = sampleDelta * (1000.0f / SENSOR_SAMPLE_RATE_HZ);

  // Step B: If no beat is detected for 1.5 seconds, slowly decay threshold to
  // prevent getting stuck
  if (timeDeltaMs > 1500.0f) {
    dynamicThreshold *= 0.998f;
    if (dynamicThreshold < 50.0f) {
      dynamicThreshold = 50.0f;
    }
  }

  // Step C: Peak Trigger Check (Positive zero/threshold crossing)
  if (filteredIR > dynamicThreshold && prevFilteredIR <= dynamicThreshold &&
      filteredIR > 50.0f) {
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
      beatTriggerMs =
          millis(); // Turn-off time scheduling is fine using CPU millisecond
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
    wsRetryDelayMs = 5000;
    Serial.printf("[WS] connected to bpm-server at %s:%u\n", serverAddress.toString().c_str(), (unsigned)SERVER_PORT);
    break;
  case WStype_DISCONNECTED:
    wsConnected = false;
    Serial.println(F("[WS] disconnected; reconnecting"));
    break;
  case WStype_ERROR:
    wsConnected = false;
    Serial.println(F("[WS] connection error"));
    break;
  case WStype_PONG:
    // Server acknowledged ping
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
    wifiOk = false;
    break;
  case ARDUINO_EVENT_WIFI_STA_CONNECTED:
    break;
  case ARDUINO_EVENT_WIFI_STA_GOT_IP:
    wifiGotIpEvent = true;
    wifiDisconnectedEvent = false;
    wifiOk = true;
    break;
  case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
    wifiOk = false;
    wsConnected = false;
    wifiDisconnectedEvent = true;
    wifiDisconnectReason = info.wifi_sta_disconnected.reason;
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
    byte powerLevel = 0x3C; // ~12mA LED current for strong PPG penetration & high SNR
    byte sampleAverage = 1; // No FIFO sample averaging
    byte ledMode = 2;       // Red + IR mode
    int sampleRate = 400;   // 400 Hz sampling rate
    int pulseWidth = 215;   // 17-bit resolution
    int adcRange = 16384;   // [FIX #11] 17-bit pulse width requires 16.384uA range.

    particleSensor.setup(powerLevel, sampleAverage, ledMode, sampleRate,
                         pulseWidth, adcRange);
    particleSensor.setPulseAmplitudeRed(powerLevel);
    particleSensor.setPulseAmplitudeIR(powerLevel);
    particleSensor.setPulseAmplitudeGreen(0);
    particleSensor.enableFIFORollover(); // Prevent FIFO lockup
    sensorFound = true;
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
  if (millis() - lastDisplayMs < 100)
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
    display.setCursor(8, 2);
    display.println(F("JEEVAN Bracelet"));
    display.setCursor(4, 13);
    display.println(F("Place finger on MAX"));
    display.setCursor(4, 23);
    if (wifiOk && wsConnected) {
      display.print(F("WiFi:OK  WS:ONLINE"));
    } else if (wifiOk) {
      display.print(F("WiFi:OK  WS:CONN..."));
    } else {
      display.print(F("WiFi:--  WS:OFFLINE"));
    }
  }

  if (i2cMutex && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    display.display(); // [FIX #4] Serialize OLED and MAX30102 access to Wire.
    xSemaphoreGive(i2cMutex);
  }
}

// ────────────────────────────────────────────────────────────────
//  Periodic Vitals Report
// ────────────────────────────────────────────────────────────────
void reportVitals() {
  long uptime = (long)((millis() - bootMs) / 1000UL);
  if (fingerDetected && dcIR > 5000.0f) {
    float acAmplitude = runningMaxIR - runningMinIR;
    perfusionPct = (acAmplitude / dcIR) * 100.0f;
  } else {
    perfusionPct = 0.0f;
  }

  bool beatRecent = (lastBeatMs > 0) && (millis() - lastBeatMs < 20000);
  if (fingerDetected && !beatRecent && (millis() - beatTriggerMs > 20000)) {
    currentBPM = 0.0f;
    beatAvg = 0;
  }
  livingTissue = fingerDetected && (perfusionPct >= MIN_PERFUSION_INDEX || beatRecent);
  // Continuous measurement: maintain calculated heart rate and SpO2 as long as finger is in contact
  int reportBpm = (fingerDetected && beatAvg > 0) ? beatAvg : 0;
  int reportSpo2 = (fingerDetected && estimatedSpo2 > 0) ? estimatedSpo2 : 0;

  if (wsConnected) {
    char json[352];
    snprintf(json, sizeof(json),
             "{\"type\":\"vitals\",\"bpm\":%d,\"spo2\":%d,\"irValue\":%ld,\"redValue\":%ld,\"fingerDetected\":%s,\"signal\":\"%s\",\"uptime\":%ld,\"perfusionPct\":%.2f,\"sensorError\":%s}",
             reportBpm, reportSpo2, latestIR, latestRed,
             fingerDetected ? "true" : "false", signalQuality, uptime, // [FIX #12] Raw contact is separate from valid-vitals gating.
             perfusionPct, sensorError ? "true" : "false");
    ws.sendTXT(json);
  }

  // [FIX #4] One compact diagnostic line at 1 Hz, outside the sample path.
  if (millis() - lastSerialMs >= 1000) {
    lastSerialMs = millis();
    Serial.printf("[V] bpm=%d spo2=%d finger=%u ir=%ld red=%ld pi=%.2f wifi=%u ws=%u sensorErr=%u fifoOvf=%lu ringOvf=%lu resync=%lu\n",
                  reportBpm, reportSpo2, fingerDetected ? 1 : 0, latestIR,
                  latestRed, perfusionPct, wifiOk ? 1 : 0,
                  wsConnected ? 1 : 0, sensorError ? 1 : 0,
                  (unsigned long)fifoOverflowCount,
                  (unsigned long)ringOverflowCount,
                  (unsigned long)pipelineResyncCount);
  }
}
// [FIX #5] MAX30102 register helpers; called only by the FIFO task under i2cMutex.
bool readMaxRegister(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(SENSOR_I2C_ADDRESS);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)SENSOR_I2C_ADDRESS, (uint8_t)1) != 1) return false;
  value = Wire.read();
  return true;
}

bool writeMaxRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(SENSOR_I2C_ADDRESS);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

void resetMaxFifo() {
  writeMaxRegister(0x04, 0); // FIFO write pointer
  writeMaxRegister(0x05, 0); // FIFO overflow counter
  writeMaxRegister(0x06, 0); // FIFO read pointer
  sensorTaskPendingGap = true;
}

void fifoDrainTask(void *parameter) {
  esp_task_wdt_add(NULL); // [FIX #9] Watchdog this dedicated sensor task.
  uint32_t failuresSinceSuccess = 0;
  for (;;) {
    if (!sensorFound) {
      if (i2cMutex && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        bool ok = initSensor();
        xSemaphoreGive(i2cMutex);
        if (ok) {
          sensorTaskReady = true;
          sensorError = false;
          failuresSinceSuccess = 0;
          sensorInitFailures = 0;
          sensorTaskPendingGap = true;
        } else {
          sensorTaskReady = false;
          ++failuresSinceSuccess;
          sensorInitFailures = failuresSinceSuccess;
          if (failuresSinceSuccess >= SENSOR_INIT_FAILURE_LIMIT) sensorError = true;
        }
      }
      lastSensorRetryMs = millis();
      esp_task_wdt_reset();
      vTaskDelay(pdMS_TO_TICKS(sensorError ? 5000 : 3000));
      continue;
    }

    if (i2cMutex && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
      particleSensor.check();
      while (particleSensor.available()) {
        uint32_t rawRed = particleSensor.getFIFORed();
        uint32_t rawIR = particleSensor.getFIFOIR();
        particleSensor.nextSample();
        const uint64_t sequence = ++sensorSampleSequence;
        pushSensorSample(rawRed, rawIR, sequence, false);
      }
      xSemaphoreGive(i2cMutex);
    }
    esp_task_wdt_reset();
    vTaskDelay(1);
  }
}

// [FIX #1/#3] Resolve mDNS first, then check Windows host mDNS, cached address, or fallback IP.
bool resolveServerAddress() {
  if (cachedServerAddress != IPAddress(0, 0, 0, 0)) {
    serverAddress = cachedServerAddress;
    serverResolved = true;
    Serial.printf("[NET] using verified server address %s\n", serverAddress.toString().c_str());
    return true;
  }
  IPAddress discovered = MDNS.queryHost(SERVER_MDNS_HOST, 1200);
  if (discovered == IPAddress(0, 0, 0, 0)) {
    // Windows native mDNS reliably resolves the machine hostname (e.g. LAPTOP-RSME6K8B.local)
    discovered = MDNS.queryHost(SERVER_WINDOWS_HOST, 1200);
  }
  if (discovered != IPAddress(0, 0, 0, 0)) {
    serverAddress = discovered;
    if (discovered != cachedServerAddress) {
      cachedServerAddress = discovered;
      preferences.putUInt("server_ip", (uint32_t)discovered);
    }
    serverResolved = true;
    Serial.printf("[mDNS] server resolved to %s\n", discovered.toString().c_str());
    return true;
  }
  if (cachedServerAddress != IPAddress(0, 0, 0, 0)) {
    serverAddress = cachedServerAddress;
    serverResolved = true;
    Serial.printf("[mDNS] mDNS lookup timed out; using cached server address %s\n",
                  cachedServerAddress.toString().c_str());
    return true;
  }
  // Fall back to configured server IP (laptop on ElderCare WiFi)
  serverAddress = SERVER_FALLBACK_IP;
  cachedServerAddress = serverAddress;
  preferences.putUInt("server_ip", (uint32_t)serverAddress);
  serverResolved = true;
  Serial.printf("[mDNS] mDNS unavailable; falling back to configured server IP %s\n",
                serverAddress.toString().c_str());
  return true;
}

void wsInit() {
  if (!wifiOk || !serverResolved || wsInitialized) return;
  ws.onEvent(wsEventHandler);
  ws.setReconnectInterval(5000);
  ws.disableHeartbeat();
  Serial.printf("[WS] connecting to %s:%u%s\n", serverAddress.toString().c_str(),
                (unsigned)SERVER_PORT, SERVER_PATH);
  ws.begin(serverAddress, SERVER_PORT, SERVER_PATH);
  wsInitialized = true;
  lastWsRetryMs = millis();
}

void wsReconnect() {
  if (!wifiOk) return;
  if (wsInitialized) {
    ws.disconnect(); // [FIX #3] Tear down old client state before re-begin.
    wsInitialized = false;
    wsConnected = false;
  }
  serverResolved = resolveServerAddress();
  if (serverResolved) wsInit();
  lastWsRetryMs = millis();
  wsRetryDelayMs = min(wsRetryDelayMs * 2UL, 60000UL);
}

void serviceConnectivity(unsigned long now) {
  if (wifiDisconnectedEvent) {
    wifiDisconnectedEvent = false;
    if (wsInitialized) {
      ws.disconnect();
      wsInitialized = false;
    }
    Serial.printf("[WiFi] disconnected reason=%u; SDK auto-reconnect active\n",
                  (unsigned)wifiDisconnectReason);
  }
  if (wifiGotIpEvent) {
    wifiGotIpEvent = false;
    Serial.printf("[WiFi] connected ip=%s\n", WiFi.localIP().toString().c_str());
    if (!mdnsStarted) mdnsStarted = MDNS.begin("jeevan-bracelet");
    serverResolved = resolveServerAddress();
    if (!serverResolved) Serial.println(F("[WS] server mDNS unavailable; cached address unavailable"));
    wsInit();
    wsRetryDelayMs = 15000;
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiOk = true;
    if (wsInitialized) ws.loop();
    if (!wsInitialized && (now - lastWsRetryMs >= wsRetryDelayMs)) wsReconnect();
    else if (wsInitialized && !wsConnected && (now - lastWsRetryMs >= wsRetryDelayMs)) wsReconnect();
  } else {
    wifiOk = false;
    wsConnected = false;
  }
}

// [FIX #9] Keep Arduino-ESP32 2.x (IDF 4) and 3.x (IDF 5) watchdog APIs usable.
void configureTaskWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t config = {};
  config.timeout_ms = 10000;
  config.idle_core_mask = 0;
  config.trigger_panic = true;
  esp_err_t err = esp_task_wdt_init(&config);
  if (err == ESP_ERR_INVALID_STATE) esp_task_wdt_reconfigure(&config);
#else
  esp_err_t err = esp_task_wdt_init(10, true);
  if (err == ESP_ERR_INVALID_STATE) esp_task_wdt_init(10, true);
#endif
  esp_task_wdt_add(NULL);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  bootMs = millis();
  Serial.printf("[BOOT] resetReason=%d (brownout reset indicates supply/rail issue)\n",
                (int)esp_reset_reason()); // [FIX #10] Surface power brownouts.

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  if (ENABLE_BUZZER && BUZZER_PIN >= 0) {
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
  }

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
  i2cMutex = xSemaphoreCreateMutex();
  if (!i2cMutex) sensorError = true;
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledFound = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(18, 10);
    display.println(F("Elder-Care System"));
    display.display();
    Serial.println(F("[OLED] SSD1306 initialized at 0x3C"));
  }
  resetVitals();

  preferences.begin("bpm-server", true);
  uint32_t savedIp = preferences.getUInt("server_ip", 0);
  preferences.end();
  if (savedIp != 0) {
    cachedServerAddress = IPAddress(savedIp);
  } else {
    cachedServerAddress = SERVER_FALLBACK_IP;
  }
  preferences.begin("bpm-server", false);

  // [FIX #4] Sensor sampling is isolated from networking, display, and DSP work.
  BaseType_t taskCreated = xTaskCreatePinnedToCore(
      fifoDrainTask, "max30102-fifo", 4096, nullptr, 2, &fifoTaskHandle, 0);
  if (taskCreated != pdPASS) {
    sensorError = true;
    Serial.println(F("[SENSOR] FIFO task creation failed"));
  }

  // WiFi has one owner: the STA event/SDK auto-reconnect state machine.
  WiFi.onEvent(onWiFiEvent); // [FIX #2]
  WiFi.mode(WIFI_STA);
  // Preserve configured hotspot-name matching (trailing spaces vary by AP).
  int networkCount = WiFi.scanNetworks();
  bool matchedNetwork = false;
  for (int i = 0; i < networkCount; ++i) {
    String found = WiFi.SSID(i);
    if (!matchedNetwork && found.startsWith("ElderCare")) {
      activeSSID = found;
      matchedNetwork = true;
    }
  }
  WiFi.scanDelete();
  configureTaskWatchdog();
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.setTxPower(WIFI_POWER_19_5dBm); // [FIX #10] Hardware rail must tolerate TX bursts.
  WiFi.begin(activeSSID.c_str(), WIFI_PASS);
  lastReportMs = millis();
  lastWsRetryMs = millis();
}

void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();
  serviceConnectivity(now);

  // [FIX #4] Consume samples on Core 1; all DSP state remains single-owner.
  SensorSample sample;
  while (popSensorSample(sample)) {
    processSample(sample.red, sample.ir, sample.sequence, sample.gapBefore);
  }

  if (sensorError != sensorErrorHandled) {
    sensorErrorHandled = sensorError;
    if (sensorError) {
      fingerDetected = false;
      resetVitals();
      Serial.println(F("[SENSOR] sensorError=true; WiFi telemetry remains active"));
    } else {
      Serial.println(F("[SENSOR] recovered; acquisition resumed"));
    }
  }
  if (!sensorFound) {
    latestIR = latestRed = 0;
    fingerDetected = false;
  }

  if (beatActive && (now - beatTriggerMs >= BEAT_BEEP_MS)) {
    beatActive = false;
    digitalWrite(LED_PIN, LOW);
    if (ENABLE_BUZZER && BUZZER_PIN >= 0) digitalWrite(BUZZER_PIN, LOW);
  }

  updateDisplay();
  if (now - lastReportMs >= REPORT_INTERVAL) {
    lastReportMs = now;
    reportVitals();
  }
  vTaskDelay(1);
}
