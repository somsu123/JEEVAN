/*
 * =================================================================================
 *  medicine_box.ino — JEEVAN Smart Medicine Box Firmware (ESP32)
 *  PRODUCTION FIRMWARE with Bulletproof WiFi Connection & Auto-Recovery
 * =================================================================================
 *
 *  Hardware Specifications (from dashboard-v2/src/components/MedicineBox.tsx):
 *    • HC-SR04 Ultrasonic: "Detects patient presence < 40 cm before dispensing." (Line 607)
 *    • TTP223 Touch Sensor: "Physically verifies pill removal from the compartment." (Line 608)
 *    • 3× SG90 Servos: "Open/close compartments on schedule (0° closed, 90° open)." (Line 609)
 *
 *  Hardware Pinouts & Features:
 *    • ESP32 Dev Module (2.4 GHz WiFi)
 *    • 16x2 I2C LCD Display (SDA: GPIO 21, SCL: GPIO 22, Address 0x27)
 *    • 3× SG90 Servos (Compartment 0: GPIO 13, Comp 1: GPIO 12, Comp 2: GPIO 14)
 *    • 3× Compartment LEDs (Comp 0: GPIO 27, Comp 1: GPIO 26, Comp 2: GPIO 25)
 *    • HC-SR04 Ultrasonic Distance Sensor (Trig: GPIO 5, Echo: GPIO 18)
 *    • TTP223 Capacitive Touch Sensor (SIG: GPIO 4)
 *    • Buzzer: GPIO 32
 *    • Status LED: GPIO 2
 *
 *  API Contracts:
 *    • Local Web Server (Port 80):
 *        - GET  /api/schedule -> {"schedule":[{"hour":int,"minute":int,"compartment":int,"label":str,"givenToday":bool}]}
 *        - POST /api/schedule -> Overwrite RAM schedule
 *    • Dashboard Telemetry (Port 5050):
 *        - POST http://<DASHBOARD_HOST>:5050/api/hardware/heartbeat -> {"remoteOpen":bool}
 *        - POST http://<DASHBOARD_HOST>:5050/api/hardware/medbox-event -> {"success":true,"matched":bool}
 *
 *  Indexing Notice:
 *    • Compartment IDs in schedule API are 0-INDEXED: 0, 1, 2
 *    • Box IDs in medbox-event are 1-BASED: 1, 2, 3 (box = compartment + 1)
 * =================================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <time.h>

// ─────────────────────────────────────────────────────────────────────────────────
//  1. CONFIGURATION & PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────────
// Note: Some hotspots have a trailing space (e.g. "ElderCare ").
// The firmware auto-scans visible networks on boot to match the exact SSID.
#define DEFAULT_WIFI_SSID "ElderCare"
#define WIFI_PASS         "ami bolbona"
#define DASHBOARD_HOST    "10.122.37.135"  // PC IP running dashboard-v2
#define DASHBOARD_PORT    5050             // dashboard-v2 server port
#define DEVICE_ID         "medbox-01"

// I2C Pins (LCD 16x2)
#define I2C_SDA_PIN       21
#define I2C_SCL_PIN       22
#define LCD_I2C_ADDR      0x27

// Actuators & Indicators
#define STATUS_LED_PIN    2
#define BUZZER_PIN        32

// 3× SG90 Servos (0-indexed compartments: 0, 1, 2)
#define SERVO_PIN_0       13
#define SERVO_PIN_1       12
#define SERVO_PIN_2       14

// 3× Compartment LEDs (0-indexed: 0, 1, 2)
#define LED_PIN_0         27
#define LED_PIN_1         26
#define LED_PIN_2         25

// Sensors
#define HC_TRIG_PIN       5
#define HC_ECHO_PIN       18
#define TOUCH_SENSOR_PIN  4

#define PRESENCE_DISTANCE_CM 40.0f

// NTP Configuration (IST: UTC +5:30 -> 19800 seconds offset, 0 daylight offset)
#define NTP_SERVER_1      "pool.ntp.org"
#define NTP_SERVER_2      "time.nist.gov"
#define GMT_OFFSET_SEC    19800
#define DAYLIGHT_OFFSET   0

#define HEARTBEAT_INTERVAL_MS 5000
#define SCHEDULER_INTERVAL_MS 1000
#define SENSOR_POLL_INTERVAL_MS 200
#define WIFI_RETRY_INTERVAL_MS 10000

// ─────────────────────────────────────────────────────────────────────────────────
//  2. GLOBAL OBJECTS & STATE VARIABLES
// ─────────────────────────────────────────────────────────────────────────────────
WebServer server(80);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);
bool lcdAvailable = false;

Servo servos[3];
const int servoPins[3] = { SERVO_PIN_0, SERVO_PIN_1, SERVO_PIN_2 };
const int ledPins[3]   = { LED_PIN_0,   LED_PIN_1,   LED_PIN_2 };

enum DeviceState {
  STATE_IDLE,
  STATE_REMINDER,
  STATE_DISPENSING,
  STATE_TAKEN,
  STATE_MISSED
};

DeviceState currentState = STATE_IDLE;
bool presenceDetected = false;
bool lidOpen = false;

struct ScheduleEntry {
  int hour;
  int minute;
  int compartment; // 0, 1, or 2
  String label;
  bool givenToday;
};

#define MAX_SCHEDULE_ENTRIES 10
ScheduleEntry scheduleList[MAX_SCHEDULE_ENTRIES];
int scheduleCount = 0;

int activeDoseIndex = -1;
int activeCompartment = -1;
int lastResetDay = -1;

// Non-blocking event reporting queue
struct PendingMedboxEvent {
  bool pending;
  String event;
  int box; // 1-based: 1, 2, 3
  String medicine;
  String dosage;
  String timestamp;
  int retriesLeft;
  unsigned long nextRetryMs;
};

PendingMedboxEvent queuedEvent = { false, "", 1, "", "", "", 0, 0 };

String activeSSID = DEFAULT_WIFI_SSID;
bool wifiConnected = false;
unsigned long lastHeartbeatMs = 0;
unsigned long lastSchedulerMs = 0;
unsigned long lastSensorPollMs = 0;
unsigned long lastBuzzerToggleMs = 0;
unsigned long lastWiFiRetryMs = 0;
unsigned long takenStateEnteredMs = 0;
bool buzzerState = false;

// ─────────────────────────────────────────────────────────────────────────────────
//  3. HELPER FUNCTIONS & ACTUATION
// ─────────────────────────────────────────────────────────────────────────────────
const char* getStateString(DeviceState s) {
  switch (s) {
    case STATE_IDLE:       return "IDLE";
    case STATE_REMINDER:   return "REMINDER";
    case STATE_DISPENSING: return "DISPENSING";
    case STATE_TAKEN:      return "TAKEN";
    case STATE_MISSED:     return "MISSED";
    default:               return "IDLE";
  }
}

void initLCD() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.beginTransmission(LCD_I2C_ADDR);
  if (Wire.endTransmission() == 0) {
    lcdAvailable = true;
    lcd.init();
    lcd.backlight();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("JEEVAN MedBox");
    lcd.setCursor(0, 1);
    lcd.print("Booting...");
    Serial.println(F("[LCD] 16x2 I2C LCD initialized successfully at 0x27"));
  } else {
    lcdAvailable = false;
    Serial.println(F("[LCD] LCD not found at 0x27, continuing in headless mode."));
  }
}

void printLcdStatus(const String& line1, const String& line2) {
  if (!lcdAvailable) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void syncNTP() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET, NTP_SERVER_1, NTP_SERVER_2);
  Serial.print(F("[NTP] Synchronizing time with IST (UTC+5:30)"));
  struct tm timeinfo;
  int retries = 0;
  while (!getLocalTime(&timeinfo) && retries < 10) {
    Serial.print(".");
    delay(400);
    retries++;
  }
  if (retries < 10) {
    char timeStr[64];
    strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", &timeinfo);
    Serial.printf("\n[NTP] Time synchronized: %s\n", timeStr);
  } else {
    Serial.println(F("\n[NTP] Warning: Time sync timed out, will retry later."));
  }
}

String getFormattedCurrentTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return "08:00";
  }
  char buf[8];
  snprintf(buf, sizeof(buf), "%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min);
  return String(buf);
}

String getNextDoseTimeStr() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return (scheduleCount > 0) ? String(scheduleList[0].hour) + ":" + String(scheduleList[0].minute) : "";
  }
  int currentMin = timeinfo.tm_hour * 60 + timeinfo.tm_min;
  int bestMin = 9999;
  String bestTimeStr = "";

  for (int i = 0; i < scheduleCount; i++) {
    if (!scheduleList[i].givenToday) {
      int itemMin = scheduleList[i].hour * 60 + scheduleList[i].minute;
      if (itemMin >= currentMin && itemMin < bestMin) {
        bestMin = itemMin;
        char buf[8];
        snprintf(buf, sizeof(buf), "%02d:%02d", scheduleList[i].hour, scheduleList[i].minute);
        bestTimeStr = String(buf);
      }
    }
  }

  // If no upcoming doses today, wrap to the earliest tomorrow
  if (bestTimeStr == "" && scheduleCount > 0) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%02d:%02d", scheduleList[0].hour, scheduleList[0].minute);
    bestTimeStr = String(buf);
  }

  return bestTimeStr;
}

// Ultrasonic distance measurement (< 40cm detects presence)
float readDistanceCm() {
  digitalWrite(HC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(HC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(HC_TRIG_PIN, LOW);

  long duration = pulseIn(HC_ECHO_PIN, HIGH, 25000); // 25ms timeout
  if (duration == 0) return 999.0f;
  return (float)duration * 0.0343f / 2.0f;
}

// Servo Actuation (0° closed, 90° open)
void openCompartment(int comp) {
  if (comp < 0 || comp >= 3) return;
  Serial.printf("[ACTUATOR] 🔓 Opening compartment %d (90°)\n", comp);
  servos[comp].write(90);
  digitalWrite(ledPins[comp], HIGH);
  lidOpen = true;
}

void closeCompartment(int comp) {
  if (comp < 0 || comp >= 3) return;
  Serial.printf("[ACTUATOR] 🔒 Closing compartment %d (0°)\n", comp);
  servos[comp].write(0);
  digitalWrite(ledPins[comp], LOW);
  lidOpen = false;
}

void closeAllCompartments() {
  for (int i = 0; i < 3; i++) {
    servos[i].write(0);
    digitalWrite(ledPins[i], LOW);
  }
  lidOpen = false;
}

void triggerRemoteOpen() {
  Serial.println(F("\n[REMOTE] 🔓 Caregiver Remote Lid Open request received from Dashboard!"));
  printLcdStatus("Remote Open", "Caregiver Req");
  
  // Open all compartments for caregiver access
  for (int i = 0; i < 3; i++) {
    servos[i].write(90);
    digitalWrite(ledPins[i], HIGH);
  }
  lidOpen = true;
  delay(3000);
  closeAllCompartments();
  printLcdStatus("Remote Open Done", "Closed");
}

// ─────────────────────────────────────────────────────────────────────────────────
//  4. DOSE-TAKEN EVENT REPORTING (PORT 5050)
// ─────────────────────────────────────────────────────────────────────────────────
void queueDoseTakenEvent(int compIndex, const String& medicineName) {
  queuedEvent.pending = true;
  queuedEvent.event = "DOSE_TAKEN";
  queuedEvent.box = compIndex + 1; // 1-BASED BOX NUMBER (0 -> 1, 1 -> 2, 2 -> 3)
  queuedEvent.medicine = medicineName;
  queuedEvent.dosage = "";
  queuedEvent.timestamp = getFormattedCurrentTime();
  queuedEvent.retriesLeft = 3;
  queuedEvent.nextRetryMs = millis(); // Send immediately

  Serial.printf("[EVENT] Queued DOSE_TAKEN event for Box %d (%s) at %s\n",
                queuedEvent.box,
                queuedEvent.medicine.c_str(),
                queuedEvent.timestamp.c_str());
}

void processEventQueue() {
  if (!queuedEvent.pending) return;
  if (millis() < queuedEvent.nextRetryMs) return;
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    queuedEvent.nextRetryMs = millis() + 3000;
    return;
  }

  WiFiClient client;
  HTTPClient http;

  String url = "http://" + String(DASHBOARD_HOST) + ":" + String(DASHBOARD_PORT) + "/api/hardware/medbox-event";
  if (!http.begin(client, url)) {
    Serial.println(F("[EVENT] Failed to initialize HTTP client for medbox-event"));
    queuedEvent.retriesLeft--;
    queuedEvent.nextRetryMs = millis() + 2000;
    if (queuedEvent.retriesLeft <= 0) queuedEvent.pending = false;
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2500);

  StaticJsonDocument<512> doc;
  doc["event"] = queuedEvent.event;
  doc["box"] = queuedEvent.box;
  doc["medicine"] = queuedEvent.medicine;
  doc["dosage"] = queuedEvent.dosage;
  doc["timestamp"] = queuedEvent.timestamp;
  doc["deviceId"] = DEVICE_ID;

  String payload;
  serializeJson(doc, payload);

  Serial.printf("[EVENT] Posting DOSE_TAKEN to Dashboard (Attempt %d/3)...\n", 4 - queuedEvent.retriesLeft);
  int httpCode = http.POST(payload);

  if (httpCode == HTTP_CODE_OK || httpCode == 200) {
    Serial.println(F("[EVENT] ✅ DOSE_TAKEN successfully delivered and confirmed by Dashboard!"));
    queuedEvent.pending = false; // Successfully delivered
  } else {
    queuedEvent.retriesLeft--;
    Serial.printf("[EVENT] ⚠️ POST /api/hardware/medbox-event failed (HTTP %d). Retries remaining: %d\n",
                  httpCode, queuedEvent.retriesLeft);

    if (queuedEvent.retriesLeft > 0) {
      queuedEvent.nextRetryMs = millis() + 2000; // Retry in 2s
    } else {
      Serial.println(F("[EVENT] ❌ Max retries reached. Event dropped from queue."));
      queuedEvent.pending = false;
    }
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────────
//  5. SCHEDULE & HARDWARE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────────
void checkSchedule() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;

  // Midnight Auto-Reset
  if (lastResetDay != timeinfo.tm_mday) {
    lastResetDay = timeinfo.tm_mday;
    for (int i = 0; i < scheduleCount; i++) {
      scheduleList[i].givenToday = false;
    }
    activeDoseIndex = -1;
    activeCompartment = -1;
    closeAllCompartments();
    currentState = STATE_IDLE;
    Serial.println(F("[SCHEDULER] 🌙 Midnight reached: givenToday flags reset for all compartments."));
  }

  int currentMinutes = timeinfo.tm_hour * 60 + timeinfo.tm_min;

  // 30-minute window check for active reminder
  if (currentState == STATE_REMINDER && activeDoseIndex >= 0 && activeDoseIndex < scheduleCount) {
    int dueMinutes = scheduleList[activeDoseIndex].hour * 60 + scheduleList[activeDoseIndex].minute;
    if (currentMinutes - dueMinutes >= 30) {
      Serial.printf("[SCHEDULER] ⚠️ 30-min window expired for compartment %d (%s) — Marked MISSED\n",
                    scheduleList[activeDoseIndex].compartment,
                    scheduleList[activeDoseIndex].label.c_str());
      currentState = STATE_MISSED;
      digitalWrite(BUZZER_PIN, LOW);
      digitalWrite(STATUS_LED_PIN, LOW);
      closeAllCompartments();
      printLcdStatus("DOSE MISSED!", scheduleList[activeDoseIndex].label);
      activeDoseIndex = -1;
      activeCompartment = -1;
      return;
    }
  }

  // Scan schedule for any dose that is due
  if (currentState == STATE_IDLE) {
    for (int i = 0; i < scheduleCount; i++) {
      if (!scheduleList[i].givenToday) {
        int dueMinutes = scheduleList[i].hour * 60 + scheduleList[i].minute;
        int diff = currentMinutes - dueMinutes;

        if (diff >= 0 && diff < 30) {
          activeDoseIndex = i;
          activeCompartment = scheduleList[i].compartment;
          currentState = STATE_REMINDER;
          Serial.printf("[SCHEDULER] 🔔 Dose DUE for compartment %d: %s at %02d:%02d\n",
                        activeCompartment,
                        scheduleList[i].label.c_str(),
                        scheduleList[i].hour,
                        scheduleList[i].minute);
          printLcdStatus("Time for:", scheduleList[i].label);
          break;
        }
      }
    }
  }

  // Reminder buzzer/LED pattern
  if (currentState == STATE_REMINDER) {
    unsigned long now = millis();
    if (now - lastBuzzerToggleMs >= 500) {
      lastBuzzerToggleMs = now;
      buzzerState = !buzzerState;
      digitalWrite(BUZZER_PIN, buzzerState ? HIGH : LOW);
      digitalWrite(STATUS_LED_PIN, buzzerState ? HIGH : LOW);
      if (activeCompartment >= 0 && activeCompartment < 3) {
        digitalWrite(ledPins[activeCompartment], buzzerState ? HIGH : LOW);
      }
    }
  } else if (currentState == STATE_IDLE || currentState == STATE_DISPENSING) {
    digitalWrite(BUZZER_PIN, LOW);
  }
}

void pollHardware() {
  unsigned long now = millis();
  if (now - lastSensorPollMs < SENSOR_POLL_INTERVAL_MS) return;
  lastSensorPollMs = now;

  // 1. Ultrasonic Presence Sensing
  float dist = readDistanceCm();
  presenceDetected = (dist < PRESENCE_DISTANCE_CM);

  // 2. State Machine Transitions based on Sensors
  if (currentState == STATE_REMINDER && presenceDetected && activeDoseIndex >= 0) {
    // Patient approached the box (<40 cm)
    Serial.printf("[SENSORS] Patient detected at %.1f cm (< 40cm)! Moving to DISPENSING.\n", dist);
    currentState = STATE_DISPENSING;
    digitalWrite(BUZZER_PIN, LOW); // Silence buzzer

    openCompartment(activeCompartment);
    printLcdStatus("Please Take Pill", scheduleList[activeDoseIndex].label);
  }

  // 3. Capacitive Touch Verification during DISPENSING
  if (currentState == STATE_DISPENSING && activeDoseIndex >= 0) {
    bool touch = (digitalRead(TOUCH_SENSOR_PIN) == HIGH);
    if (touch) {
      Serial.printf("[TOUCH] ✅ TTP223 Touch verified! Pill removed from compartment %d.\n", activeCompartment);
      closeCompartment(activeCompartment);

      scheduleList[activeDoseIndex].givenToday = true;
      currentState = STATE_TAKEN;
      takenStateEnteredMs = millis();

      // Enqueue DOSE_TAKEN event for dashboard delivery (1-based box number!)
      queueDoseTakenEvent(activeCompartment, scheduleList[activeDoseIndex].label);

      // Confirmation beep
      digitalWrite(BUZZER_PIN, HIGH);
      delay(150);
      digitalWrite(BUZZER_PIN, LOW);

      printLcdStatus("Dose Taken! \x7E", scheduleList[activeDoseIndex].label);
    }
  }

  // 4. Return to IDLE from TAKEN or MISSED after cooldown
  if (currentState == STATE_TAKEN && (now - takenStateEnteredMs > 5000)) {
    currentState = STATE_IDLE;
    activeDoseIndex = -1;
    activeCompartment = -1;
    printLcdStatus("JEEVAN MedBox", "Ready");
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  6. HEARTBEAT TELEMETRY (PORT 5050)
// ─────────────────────────────────────────────────────────────────────────────────
void sendHeartbeat() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;

  String url = "http://" + String(DASHBOARD_HOST) + ":" + String(DASHBOARD_PORT) + "/api/hardware/heartbeat";
  if (!http.begin(client, url)) {
    Serial.println(F("[HEARTBEAT] Failed to begin HTTP client"));
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(3000);

  StaticJsonDocument<512> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["state"] = getStateString(currentState);
  doc["presenceDetected"] = presenceDetected;
  doc["nextDoseTime"] = getNextDoseTimeStr();
  doc["uptime"] = (unsigned long)(millis() / 1000);
  doc["lidOpen"] = lidOpen;

  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  if (httpCode == HTTP_CODE_OK || httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> respDoc;
    DeserializationError err = deserializeJson(respDoc, response);
    if (!err) {
      bool remoteOpen = respDoc["remoteOpen"] | false;
      if (remoteOpen) {
        triggerRemoteOpen();
      }
    }
  } else {
    Serial.printf("[HEARTBEAT] POST failed, HTTP Code: %d\n", httpCode);
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────────
//  7. HTTP SERVER ROUTE HANDLERS (PORT 80)
// ─────────────────────────────────────────────────────────────────────────────────
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

void handleGetSchedule() {
  StaticJsonDocument<2048> doc;
  JsonArray array = doc.createNestedArray("schedule");

  for (int i = 0; i < scheduleCount; i++) {
    JsonObject obj = array.createNestedObject();
    obj["hour"] = scheduleList[i].hour;
    obj["minute"] = scheduleList[i].minute;
    obj["compartment"] = scheduleList[i].compartment;
    obj["label"] = scheduleList[i].label;
    obj["givenToday"] = scheduleList[i].givenToday;
  }

  String response;
  serializeJson(doc, response);

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", response);
  Serial.printf("[HTTP] Served GET /api/schedule (%d entries)\n", scheduleCount);
}

void handlePostSchedule() {
  if (!server.hasArg("plain")) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server.arg("plain");
  StaticJsonDocument<2048> doc;
  DeserializationError error = deserializeJson(doc, body);

  if (error) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  JsonArray array;
  if (doc.is<JsonArray>()) {
    array = doc.as<JsonArray>();
  } else if (doc.containsKey("schedule") && doc["schedule"].is<JsonArray>()) {
    array = doc["schedule"].as<JsonArray>();
  } else {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Expected 'schedule' array\"}");
    return;
  }

  scheduleCount = 0;
  for (JsonObject v : array) {
    if (scheduleCount >= MAX_SCHEDULE_ENTRIES) break;
    scheduleList[scheduleCount].hour = v["hour"] | 0;
    scheduleList[scheduleCount].minute = v["minute"] | 0;
    scheduleList[scheduleCount].compartment = v["compartment"] | 0;
    scheduleList[scheduleCount].label = v["label"] | "Medicine";
    scheduleList[scheduleCount].givenToday = v["givenToday"] | false;
    scheduleCount++;
  }

  Serial.printf("[HTTP] Saved POST /api/schedule: %d entries loaded into RAM\n", scheduleCount);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"status\":\"ok\"}");
}

// ─────────────────────────────────────────────────────────────────────────────────
//  8. BULLETPROOF WIFI ENGINE
// ─────────────────────────────────────────────────────────────────────────────────
void initWiFiConnection() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // Disable modem sleep for maximum connection stability
  WiFi.setTxPower(WIFI_POWER_19_5dBm); // Maximum transmission power
  WiFi.setAutoReconnect(true);

  printLcdStatus("Scanning WiFi...", "Please wait");
  Serial.println(F("\n[WiFi] Scanning visible 2.4GHz WiFi networks..."));

  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d visible networks:\n", n);
  
  bool matched = false;
  for (int i = 0; i < n; ++i) {
    String found = WiFi.SSID(i);
    Serial.printf("  %2d: '%s' (RSSI: %d dBm, Ch: %d)\n", i + 1, found.c_str(), WiFi.RSSI(i), WiFi.channel(i));

    // Match exact "ElderCare", "ElderCare " (with trailing space), or names starting with ElderCare
    if (!matched && (found == "ElderCare" || found == "ElderCare " || found.startsWith("ElderCare"))) {
      activeSSID = found;
      matched = true;
      Serial.printf("[WiFi] >>> Matched Target Hotspot: '%s' <<<\n", activeSSID.c_str());
    }
  }

  Serial.printf("[WiFi] Connecting to SSID: '%s'...\n", activeSSID.c_str());
  printLcdStatus("Connecting to:", activeSSID);

  WiFi.begin(activeSSID.c_str(), WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 25) { // 12.5 seconds timeout
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("\n[WiFi] Connected! IP Address: %s\n", WiFi.localIP().toString().c_str());
    printLcdStatus("WiFi Connected", WiFi.localIP().toString());
    syncNTP();
  } else {
    wifiConnected = false;
    digitalWrite(STATUS_LED_PIN, LOW);
    Serial.println(F("\n[WiFi] Initial connection timed out. Background retry engine active."));
    printLcdStatus("WiFi Failed", "Retrying in bg");
  }
}

void maintainWiFi() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      digitalWrite(STATUS_LED_PIN, LOW);
      Serial.println(F("[WiFi] Connection lost. Will retry in background..."));
      printLcdStatus("WiFi Dropped", "Retrying...");
    }

    if (now - lastWiFiRetryMs >= WIFI_RETRY_INTERVAL_MS) {
      lastWiFiRetryMs = now;
      Serial.printf("[WiFi] Retrying connection to '%s'...\n", activeSSID.c_str());
      WiFi.disconnect();
      WiFi.begin(activeSSID.c_str(), WIFI_PASS);
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      digitalWrite(STATUS_LED_PIN, HIGH);
      Serial.printf("[WiFi] Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
      printLcdStatus("WiFi Connected", WiFi.localIP().toString());
      syncNTP();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  9. SETUP & LOOP
// ─────────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=================================================="));
  Serial.println(F(" JEEVAN Smart Medicine Box — Production Firmware"));
  Serial.println(F("=================================================="));

  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  // Sensor Pins
  pinMode(HC_TRIG_PIN, OUTPUT);
  pinMode(HC_ECHO_PIN, INPUT);
  pinMode(TOUCH_SENSOR_PIN, INPUT);

  // Setup 3× SG90 Servos and Compartment LEDs
  for (int i = 0; i < 3; i++) {
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW);

    servos[i].setPeriodHertz(50); // Standard 50Hz servo
    servos[i].attach(servoPins[i], 500, 2400);
    servos[i].write(0); // 0° = closed
  }

  initLCD();

  // Initialize WiFi connection (scans for "ElderCare" / "ElderCare ")
  initWiFiConnection();

  // Setup Web Server Routes
  server.on("/api/schedule", HTTP_OPTIONS, handleCORS);
  server.on("/api/schedule", HTTP_GET, handleGetSchedule);
  server.on("/api/schedule", HTTP_POST, handlePostSchedule);

  server.begin();
  Serial.println(F("[HTTP] ESP32 Web Server started on port 80"));
}

void loop() {
  // Maintain WiFi in background without stalling
  maintainWiFi();

  server.handleClient();

  // 1-second Schedule Loop
  unsigned long now = millis();
  if (now - lastSchedulerMs >= SCHEDULER_INTERVAL_MS) {
    lastSchedulerMs = now;
    checkSchedule();
  }

  // 200ms Hardware Sensor Polling & State Progression
  pollHardware();

  // Non-blocking Event Queue Processor (with up to 3 retries)
  processEventQueue();

  // 5-second Heartbeat
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    sendHeartbeat();
  }
}