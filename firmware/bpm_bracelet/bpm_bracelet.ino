/*
 * ============================================================
 *  bpm_bracelet.ino — Main Firmware for BPM Smart Bracelet
 * ============================================================
 *  Hardware:  ESP32 + MAX30102 + TP4056 + 3.7V Li-ion
 *  Pins:      SDA → GPIO21, SCL → GPIO22
 * ============================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <MAX30105.h>
#include <heartRate.h>

// ─── CONFIGURATION ──────────────────────────────────────────
#define WIFI_SSID "ElderCare"
#define WIFI_PASSWORD "ami bolbona"
#define SERVER_URL "http://10.206.196.135:5050/api/bracelet/vitals"

#define WIFI_CHECK_INTERVAL_MS 10000

#define SENSOR_LED_BRIGHTNESS 0x3F // Increased brightness for better signal
#define SENSOR_SAMPLE_AVERAGE 4
#define SENSOR_LED_MODE 2          // 2 = Red+IR
#define SENSOR_SAMPLE_RATE 400     // Hz
#define SENSOR_PULSE_WIDTH 411     // µs
#define SENSOR_ADC_RANGE 16384

#define IR_FINGER_THRESHOLD 15000
#define BPM_MIN 40
#define BPM_MAX 220
#define BPM_FILTER_WINDOW 8
#define SEND_INTERVAL_MS 1000
#define SERIAL_BAUD 115200
#define DEBUG_PRINT 1
// ────────────────────────────────────────────────────────────

// ─── GLOBALS ────────────────────────────────────────────────
MAX30105 sensor;

unsigned long lastBeatTime = 0;
bool sensorReady = false;

float bpmBuffer[BPM_FILTER_WINDOW];
int bpmIndex = 0;
int bpmCount = 0;
bool bufferFull = false;

unsigned long lastWiFiCheck = 0;
unsigned long lastSendTime = 0;
float currentBpm = 0.0f;
bool fingerOn = false;
long latestIR = 0;

// ─── FILTER & HELPER FUNCTIONS ──────────────────────────────
void filtersInit() {
  for (int i = 0; i < BPM_FILTER_WINDOW; i++) bpmBuffer[i] = 0.0f;
  bpmIndex = 0;
  bpmCount = 0;
  bufferFull = false;
}

bool filtersAddBpm(float rawBpm) {
  if (rawBpm < BPM_MIN || rawBpm > BPM_MAX) return false;
  bpmBuffer[bpmIndex] = rawBpm;
  bpmIndex = (bpmIndex + 1) % BPM_FILTER_WINDOW;
  if (!bufferFull) {
    bpmCount++;
    if (bpmCount >= BPM_FILTER_WINDOW) bufferFull = true;
  }
  return true;
}

float filtersGetSmoothedBpm() {
  int n = bufferFull ? BPM_FILTER_WINDOW : bpmCount;
  
  if (n < 4) return 0.0f; 

  float sum = 0.0f;
  for (int i = 0; i < n; i++) sum += bpmBuffer[i];
  return sum / (float)n;
}

// ─── SENSOR FUNCTIONS ───────────────────────────────────────
bool initSensor() {
  Wire.begin(); 
  if (!sensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println(F("[SENSOR] MAX30102 not found! Check wiring."));
    return false;
  }
  sensor.setup(SENSOR_LED_BRIGHTNESS, SENSOR_SAMPLE_AVERAGE, SENSOR_LED_MODE,
               SENSOR_SAMPLE_RATE, SENSOR_PULSE_WIDTH, SENSOR_ADC_RANGE);
  sensor.enableDIETEMPRDY();
  lastBeatTime = 0;
  sensorReady = true;
  return true;
}

void readSensorAndProcess() {
  if (!sensorReady) return;
  latestIR = sensor.getIR();
  fingerOn = (latestIR > IR_FINGER_THRESHOLD);

  if (!fingerOn) {
    lastBeatTime = 0; 
    currentBpm = 0;   
    filtersInit();    
    return;
  }

  if (checkForBeat(latestIR)) {
    unsigned long now = millis();
    if (lastBeatTime > 0) {
      unsigned long delta = now - lastBeatTime;
      if (delta > 270 && delta < 1500) { 
        float rawBpm = 60000.0f / (float)delta;
        if (filtersAddBpm(rawBpm)) {
          currentBpm = filtersGetSmoothedBpm();
          #if DEBUG_PRINT
          Serial.printf("[BEAT] raw=%.0f smooth=%.0f IR=%ld\n", rawBpm, currentBpm, latestIR);
          #endif
        }
      }
    }
    lastBeatTime = now;
  }
}

// ─── NETWORK FUNCTIONS ──────────────────────────────────────
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
}

void checkWiFi() {
  if (millis() - lastWiFiCheck > WIFI_CHECK_INTERVAL_MS) {
    lastWiFiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] Reconnecting...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }
}

// ─── SETUP ──────────────────────────────────────────────────
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(500);
  
  filtersInit();
  
  if (!initSensor()) {
    while (true) delay(1000);
  }
  
  initWiFi();
  
  Serial.println(F("[MAIN] System ready — streaming BPM data via HTTP POST."));
}

// ─── LOOP ───────────────────────────────────────────────────
void loop() {
  readSensorAndProcess();
  
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = now;
    checkWiFi();
    
    String json = "{";
    json += "\"bpm\":" + String((int)currentBpm);
    json += ",\"fingerPresent\":" + String(fingerOn ? "true" : "false");
    json += "}";

    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(SERVER_URL);
      http.addHeader("Content-Type", "application/json");
      
      int httpResponseCode = http.POST(json);
      
      #if DEBUG_PRINT
      Serial.printf("[SEND] %s -> HTTP %d\n", json.c_str(), httpResponseCode);
      #endif
      
      http.end();
    }
  }
}
