/*
 * =================================================================================
 *  medicine_box.ino — JEEVAN Smart Medicine Box Firmware (ESP32)
 *  PRODUCTION FIRMWARE: 4-Compartment Architecture with 1x Shared Servo Lid
 * =================================================================================
 *
 *  Hardware Specifications:
 *    • Microcontroller: ESP32 Dev Module (2.4 GHz Wi-Fi)
 *    • 16x2 I2C LCD Display (SDA: GPIO 21, SCL: GPIO 22, Address: 0x27)
 *    • 1× SG90 Servo Motor: GPIO 13 for compartment lid control (0° = closed, 90° = open)
 *    • 4× Compartment LEDs:
 *        - Compartment 0: GPIO 27 (D27)
 *        - Compartment 1: GPIO 26 (D26)
 *        - Compartment 2: GPIO 25 (D25)
 *        - Compartment 3: GPIO 33 (D33)
 *    • 1× Alarm Buzzer: GPIO 32 (reserved)
 *    • 1× Status LED: GPIO 2
 *    • 1× HC-SR04 Ultrasonic Distance Sensor (Trig: GPIO 5, Echo: GPIO 18)
 *    • 1× Push Button / Touch Sensor: GPIO 4 (with INPUT_PULLUP)
 *
 *  Operational State Machine:
 *    • STATE_IDLE: Lid closed (0°), LEDs off, waiting for scheduled dose.
 *    • STATE_REMINDER: Dose due. Alarm buzzer & status LED pulse (500ms on/off),
 *      assigned compartment LED blinks, LCD shows medicine & dosage. No auto-expiry.
 *    • STATE_DISPENSING: HC-SR04 detects patient (< 300 cm). Buzzer silences,
 *      servo opens lid (90°), assigned compartment LED glows solid, LCD prompts intake.
 *    • STATE_TAKEN: Push button / touch on GPIO 4 confirms removal. Lid closes (0°),
 *      plays non-blocking confirmation chirp, LED turns off, DOSE_TAKEN event queued.
 *    • MIDNIGHT RESET: Clears all givenToday flags at 00:00.
 *
 *  API & Telemetry:
 *    • Local HTTP Server (Port 80):
 *        - GET  /api/schedule -> {"schedule":[{"hour":int,"minute":int,"compartment":int,"label":str,"dosage":str,"givenToday":bool}]}
 *        - POST /api/schedule -> Overwrite RAM schedule (0 to 3 compartment index)
 *        - POST /api/compartment/assign -> Open lid & glow LED for caregiver reload
 *    • Dashboard Telemetry (Port 5050):
 *        - POST http://<DASHBOARD_HOST>:5050/api/hardware/heartbeat -> {"remoteOpen":bool,"assignedSlot":{...}}
 *        - POST http://<DASHBOARD_HOST>:5050/api/hardware/medbox-event -> {"success":true,"matched":bool}
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
#include <sys/time.h>

// ─────────────────────────────────────────────────────────────────────────────────
//  1. CONFIGURATION & PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────────
#define DEFAULT_WIFI_SSID "ElderCare"
#define WIFI_PASS         "ami bolbona"

// Dashboard Telemetry Endpoint (PC running dashboard-v2 on Port 5050)
#define DASHBOARD_HOST    "10.122.37.135"
#define DASHBOARD_PORT    5050
#define DEVICE_ID         "medbox-01"

// I2C Pins (16x2 LCD)
#define I2C_SDA_PIN       21
#define I2C_SCL_PIN       22
#define LCD_I2C_ADDR      0x27

// Actuators & Indicators
#define SERVO_PIN         13   // 1x SG90 Servo for compartment lid
#define STATUS_LED_PIN    2    // Status / Network Indicator LED
#define BUZZER_PIN        32   // Alarm Buzzer GPIO (reserved)
#define ENABLE_BUZZER     false // Set to true once hardware buzzer is physically installed

// 4× Compartment LEDs (0-indexed: Compartment 0, 1, 2, 3)
#define LED_PIN_0         27   // D27
#define LED_PIN_1         26   // D26
#define LED_PIN_2         25   // D25
#define LED_PIN_3         33   // D33

#define NUM_COMPARTMENTS  4

// Sensors
#define HC_TRIG_PIN       5    // D5 (Ultrasonic Trig)
#define HC_ECHO_PIN       18   // D18 (Echo input, or set to 5 if Trig/Echo share D5)
#define BUTTON_PIN        4    // Push button / Touch sensor (with INPUT_PULLUP)

// Ultrasonic Presence Distance Threshold (in cm: 15–20 cm detection)
#define PRESENCE_DISTANCE_CM 20.0f

// NTP Configuration (IST: UTC +5:30 -> 19800 seconds offset, 0 daylight offset)
#define NTP_SERVER_1      "pool.ntp.org"
#define NTP_SERVER_2      "time.nist.gov"
#define GMT_OFFSET_SEC    19800
#define DAYLIGHT_OFFSET   0

// Interval Constants (ms)
#define HEARTBEAT_INTERVAL_MS   5000
#define SCHEDULER_INTERVAL_MS   1000
#define SENSOR_POLL_INTERVAL_MS 200
#define WIFI_RETRY_INTERVAL_MS  10000

// ─────────────────────────────────────────────────────────────────────────────────
//  2. GLOBAL OBJECTS & STATE VARIABLES
// ─────────────────────────────────────────────────────────────────────────────────
WebServer server(80);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);
bool lcdAvailable = false;

Servo lidServo;
const int ledPins[NUM_COMPARTMENTS] = { LED_PIN_0, LED_PIN_1, LED_PIN_2, LED_PIN_3 };

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
  int compartment; // 0, 1, 2, or 3
  char label[32];  // Medicine name (e.g. "Metformin")
  char dosage[16]; // Dosage (e.g. "500mg")
  bool givenToday;
};

#define MAX_SCHEDULE_ENTRIES 10
ScheduleEntry scheduleList[MAX_SCHEDULE_ENTRIES];
int scheduleCount = 0;

int activeDoseIndex = -1;
int activeCompartment = -1;
int lastResetDay = -1;

// Non-blocking Event Queue Struct (fixed char arrays to eliminate heap fragmentation)
struct PendingMedboxEvent {
  bool pending;
  char event[16];
  int box; // 1-based box number: 1, 2, 3, 4
  char medicine[32];
  char dosage[16];
  char timestamp[16];
  int retriesLeft;
  unsigned long nextRetryMs;
};

PendingMedboxEvent queuedEvent = { false, "", 1, "", "", "", 0, 0 };

String activeSSID = DEFAULT_WIFI_SSID;
bool wifiConnected = false;
unsigned long lastHeartbeatMs = 0;
unsigned long lastSchedulerMs = 0;
unsigned long lastSensorPollMs = 0;
unsigned long lastWiFiRetryMs = 0;
unsigned long takenStateEnteredMs = 0;

// Non-blocking LCD Banner Display Timing
unsigned long lcdBannerUntilMs = 0;

// Non-blocking Caregiver Remote Open Timing
bool remoteOpenActive = false;
unsigned long remoteOpenCloseMs = 0;

// Non-blocking Slot Assignment Timing
int assignedCompartment = -1;
unsigned long assignedSlotCloseMs = 0;
bool assignedSlotActive = false;

// Button debounce tracking
bool lastButtonReading = HIGH;
unsigned long lastDebounceMs = 0;
#define DEBOUNCE_DELAY_MS 50

// ─────────────────────────────────────────────────────────────────────────────────
//  3. FULLY NON-BLOCKING AUDIO ENGINE (BUZZER)
// ─────────────────────────────────────────────────────────────────────────────────
enum BuzzerMode {
  BZZ_IDLE,
  BZZ_SHORT_BEEP,      // 150ms confirmation chirp
  BZZ_DOUBLE_CHIME,    // 90ms on -> 60ms off -> 90ms on (slot assigned)
  BZZ_REMINDER_PULSE   // 500ms on / 500ms off repeating during STATE_REMINDER
};

BuzzerMode buzzerMode = BZZ_IDLE;
unsigned long buzzerStateMs = 0;
uint8_t buzzerStep = 0;
bool buzzerPhysicalState = false;

void setBuzzerHardware(bool on) {
  buzzerPhysicalState = on;
#if ENABLE_BUZZER
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
#endif
}

void triggerShortBeep() {
  buzzerMode = BZZ_SHORT_BEEP;
  buzzerStep = 0;
  buzzerStateMs = millis();
  setBuzzerHardware(true);
}

void triggerDoubleChime() {
  buzzerMode = BZZ_DOUBLE_CHIME;
  buzzerStep = 0;
  buzzerStateMs = millis();
  setBuzzerHardware(true);
}

void updateBuzzer() {
  unsigned long now = millis();

  if (currentState == STATE_REMINDER && buzzerMode != BZZ_DOUBLE_CHIME && buzzerMode != BZZ_SHORT_BEEP) {
    buzzerMode = BZZ_REMINDER_PULSE;
  } else if (currentState != STATE_REMINDER && buzzerMode == BZZ_REMINDER_PULSE) {
    buzzerMode = BZZ_IDLE;
    setBuzzerHardware(false);
  }

  switch (buzzerMode) {
    case BZZ_SHORT_BEEP:
      if (now - buzzerStateMs >= 150) {
        setBuzzerHardware(false);
        buzzerMode = (currentState == STATE_REMINDER) ? BZZ_REMINDER_PULSE : BZZ_IDLE;
      }
      break;

    case BZZ_DOUBLE_CHIME:
      if (buzzerStep == 0 && (now - buzzerStateMs >= 90)) {
        setBuzzerHardware(false);
        buzzerStep = 1;
        buzzerStateMs = now;
      } else if (buzzerStep == 1 && (now - buzzerStateMs >= 60)) {
        setBuzzerHardware(true);
        buzzerStep = 2;
        buzzerStateMs = now;
      } else if (buzzerStep == 2 && (now - buzzerStateMs >= 90)) {
        setBuzzerHardware(false);
        buzzerStep = 0;
        buzzerMode = (currentState == STATE_REMINDER) ? BZZ_REMINDER_PULSE : BZZ_IDLE;
      }
      break;

    case BZZ_REMINDER_PULSE:
      if (now - buzzerStateMs >= 500) {
        buzzerStateMs = now;
        bool newState = !buzzerPhysicalState;
        setBuzzerHardware(newState);
        digitalWrite(STATUS_LED_PIN, newState ? HIGH : LOW);
        if (activeCompartment >= 0 && activeCompartment < NUM_COMPARTMENTS) {
          digitalWrite(ledPins[activeCompartment], newState ? HIGH : LOW);
        }
      }
      break;

    case BZZ_IDLE:
    default:
      setBuzzerHardware(false);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  4. HARDWARE ACTUATION & DISPLAY HELPERS
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
  Wire.setTimeOut(50); // 50ms bus timeout prevents I2C freezes

  Wire.beginTransmission(LCD_I2C_ADDR);
  if (Wire.endTransmission() == 0) {
    lcdAvailable = true;
    lcd.init();
    lcd.backlight();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("JEEVAN MedBox");
    lcd.setCursor(0, 1);
    lcd.print("4-Slot Booting");
    Serial.println(F("[LCD] 16x2 I2C LCD initialized successfully at 0x27"));
  } else {
    lcdAvailable = false;
    Serial.println(F("[LCD] ⚠️ LCD not found at 0x27 — running in headless mode."));
  }
}

void printLcdStatus(const String& line1, const String& line2, unsigned long holdDurationMs = 0) {
  static String lastLine1 = "";
  static String lastLine2 = "";

  if (holdDurationMs > 0) {
    lcdBannerUntilMs = millis() + holdDurationMs;
  }

  if (line1 != lastLine1 || line2 != lastLine2) {
    Serial.printf("[LCD] Line 1: \"%s\" | Line 2: \"%s\"\n", line1.c_str(), line2.c_str());
    lastLine1 = line1;
    lastLine2 = line2;
  }

  if (!lcdAvailable) return;

  char l1[17];
  char l2[17];
  snprintf(l1, sizeof(l1), "%-16.16s", line1.c_str());
  snprintf(l2, sizeof(l2), "%-16.16s", line2.c_str());

  lcd.setCursor(0, 0);
  lcd.print(l1);
  lcd.setCursor(0, 1);
  lcd.print(l2);
}

// Synchronize device RTC directly from Dashboard server (Port 5050)
void syncTimeFromDashboard() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  HTTPClient http;
  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d/api/hardware/time", DASHBOARD_HOST, DASHBOARD_PORT);
  if (!http.begin(client, url)) return;
  http.setTimeout(2000);
  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    StaticJsonDocument<256> doc;
    if (!deserializeJson(doc, payload)) {
      time_t epoch = doc["epoch"] | 0;
      if (epoch > 1700000000) {
        struct timeval tv = { .tv_sec = epoch, .tv_usec = 0 };
        settimeofday(&tv, NULL);
        setenv("TZ", "IST-5:30", 1);
        tzset();
        Serial.printf("[TIME] ✅ Synchronized device RTC from Dashboard: %s (epoch %lu)\n",
                      doc["time"] | "", (unsigned long)epoch);
        http.end();
        return;
      }
    }
  }
  http.end();
}

void syncTime() {
  setenv("TZ", "IST-5:30", 1);
  tzset();

  // 1. Direct instant time sync from Dashboard PC server
  syncTimeFromDashboard();

  // 2. Backup NTP synchronization with IST / pool servers
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET, NTP_SERVER_1, NTP_SERVER_2);
  Serial.print(F("[TIME] Synchronizing clock with IST (UTC+5:30)"));
  struct tm timeinfo;
  int retries = 0;
  while (!getLocalTime(&timeinfo) && retries < 8) {
    Serial.print(".");
    delay(150);
    retries++;
  }
  if (getLocalTime(&timeinfo)) {
    char timeStr[64];
    strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", &timeinfo);
    Serial.printf("\n[TIME] ✅ Device Clock set to: %s (IST/Local)\n", timeStr);
  } else {
    Serial.println(F("\n[TIME] ⚠️ Waiting for next heartbeat to set exact device clock."));
  }
}

String getNormalTimeStr() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return "Time: Syncing...";
  }
  char buf[17];
  snprintf(buf, sizeof(buf), "Time: %02d:%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  return String(buf);
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

  // Wrap around to earliest dose if no remaining doses today
  if (bestTimeStr == "" && scheduleCount > 0) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%02d:%02d", scheduleList[0].hour, scheduleList[0].minute);
    bestTimeStr = String(buf);
  }

  return bestTimeStr;
}

// Ultrasonic distance measurement (< 300 cm detects patient presence)
float readDistanceCm() {
#if (HC_TRIG_PIN == HC_ECHO_PIN)
  pinMode(HC_TRIG_PIN, OUTPUT);
  digitalWrite(HC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(HC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(HC_TRIG_PIN, LOW);
  pinMode(HC_ECHO_PIN, INPUT);
  long duration = pulseIn(HC_ECHO_PIN, HIGH, 18500); // 18.5ms timeout (~317 cm max flight time)
#else
  digitalWrite(HC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(HC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(HC_TRIG_PIN, LOW);
  long duration = pulseIn(HC_ECHO_PIN, HIGH, 18500); // 18.5ms timeout (~317 cm max flight time)
#endif
  if (duration == 0) return 999.0f;
  float dist = (float)duration * 0.0343f / 2.0f;
  if (dist <= 0.0f) return 999.0f;
  return dist;
}

// Single SG90 Servo Lid Actuation (0° closed, 90° open)
void openLid() {
  Serial.println(F("[ACTUATOR] 🔓 Opening compartment lid (90°)"));
  lidServo.write(90);
  lidOpen = true;
}

void closeLid() {
  Serial.println(F("[ACTUATOR] 🔒 Closing compartment lid (0°)"));
  lidServo.write(0);
  lidOpen = false;
}

void setCompartmentLed(int comp, bool on) {
  if (comp >= 0 && comp < NUM_COMPARTMENTS) {
    digitalWrite(ledPins[comp], on ? HIGH : LOW);
  }
}

void turnOffAllLeds() {
  for (int i = 0; i < NUM_COMPARTMENTS; i++) {
    digitalWrite(ledPins[i], LOW);
  }
}

// Non-blocking Caregiver Remote Open Lid
void triggerRemoteOpen() {
  Serial.println(F("\n[REMOTE] 🔓 Caregiver Remote Lid Open request received from Dashboard!"));
  printLcdStatus("Remote Open", "Caregiver Req", 3000);
  openLid();
  for (int i = 0; i < NUM_COMPARTMENTS; i++) digitalWrite(ledPins[i], HIGH);

  remoteOpenActive = true;
  remoteOpenCloseMs = millis() + 3000;
}

void checkRemoteOpenTimeout() {
  if (!remoteOpenActive) return;
  if (millis() >= remoteOpenCloseMs) {
    remoteOpenActive = false;
    closeLid();
    turnOffAllLeds();
    Serial.println(F("[REMOTE] 🔒 Remote open complete. Lid closed."));
    printLcdStatus("Remote Open Done", "Closed", 1500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  5. CAREGIVER SLOT ASSIGNMENT (DISPLAY ONLY — LID REMAINS CLOSED)
// ─────────────────────────────────────────────────────────────────────────────────
void triggerSlotAssigned(int comp, const char* label, const char* dosage, const char* timeStr) {
  if (comp < 0 || comp >= NUM_COMPARTMENTS) {
    Serial.printf("[ASSIGN] ⚠️ Compartment %d out of range (0..3).\n", comp);
    return;
  }

  Serial.printf("\n[ASSIGN] 📋 Medicine Assigned to Slot %d! (Lid remains CLOSED)\n", comp + 1);
  if (label && strlen(label) > 0) {
    Serial.printf("[ASSIGN] Medicine: '%s' | Dosage: '%s' | Scheduled: '%s'\n",
                  label, dosage ? dosage : "", timeStr ? timeStr : "");
  }

  // 1. Lid remains strictly CLOSED (0°) — do NOT open on assignment
  closeLid();

  // 2. Briefly light up the assigned compartment LED
  turnOffAllLeds();
  setCompartmentLed(comp, true);

  assignedCompartment = comp;
  assignedSlotActive = true;
  assignedSlotCloseMs = millis() + 3500; // 3.5 seconds display window

  // 3. Display assignment details on LCD for a few seconds
  char line1[17];
  char line2[17];
  snprintf(line1, sizeof(line1), "Slot %d Assigned", comp + 1);
  if (label && strlen(label) > 0) {
    snprintf(line2, sizeof(line2), "%.16s", label);
  } else {
    snprintf(line2, sizeof(line2), "Time: %.10s", (timeStr && strlen(timeStr) > 0) ? timeStr : "");
  }
  printLcdStatus(line1, line2, 3500);

  // 4. Non-blocking chime
  triggerDoubleChime();
}

void checkAssignedSlotTimeout() {
  if (!assignedSlotActive) return;

  if (millis() >= assignedSlotCloseMs) {
    turnOffAllLeds();
    assignedSlotActive = false;
    assignedCompartment = -1;
    Serial.println(F("[ASSIGN] ✅ Slot assignment display complete."));
    if (currentState == STATE_IDLE) {
      printLcdStatus("JEEVAN MedBox", getNormalTimeStr());
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  6. DOSE-TAKEN EVENT REPORTING (PORT 5050)
// ─────────────────────────────────────────────────────────────────────────────────
void queueDoseTakenEvent(int compIndex, const char* medicineName, const char* doseStr) {
  queuedEvent.pending = true;
  strncpy(queuedEvent.event, "DOSE_TAKEN", sizeof(queuedEvent.event) - 1);
  queuedEvent.box = compIndex + 1; // 1-BASED BOX NUMBER (0 -> 1, 1 -> 2, 2 -> 3, 3 -> 4)
  strncpy(queuedEvent.medicine, medicineName, sizeof(queuedEvent.medicine) - 1);
  if (doseStr) {
    strncpy(queuedEvent.dosage, doseStr, sizeof(queuedEvent.dosage) - 1);
  } else {
    queuedEvent.dosage[0] = '\0';
  }

  String curTime = getFormattedCurrentTime();
  strncpy(queuedEvent.timestamp, curTime.c_str(), sizeof(queuedEvent.timestamp) - 1);

  queuedEvent.retriesLeft = 3;
  queuedEvent.nextRetryMs = millis();

  Serial.printf("[EVENT] Queued DOSE_TAKEN event: Box %d | %s (%s) at %s\n",
                queuedEvent.box,
                queuedEvent.medicine,
                queuedEvent.dosage,
                queuedEvent.timestamp);
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

  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d/api/hardware/medbox-event", DASHBOARD_HOST, DASHBOARD_PORT);

  if (!http.begin(client, url)) {
    Serial.println(F("[EVENT] Failed to begin HTTP client for medbox-event"));
    queuedEvent.retriesLeft--;
    queuedEvent.nextRetryMs = millis() + 2000;
    if (queuedEvent.retriesLeft <= 0) queuedEvent.pending = false;
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(1500);

  StaticJsonDocument<384> doc;
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
    Serial.println(F("[EVENT] ✅ DOSE_TAKEN successfully confirmed by Dashboard!"));
    queuedEvent.pending = false;
  } else {
    queuedEvent.retriesLeft--;
    Serial.printf("[EVENT] ⚠️ POST failed (HTTP %d). Retries remaining: %d\n", httpCode, queuedEvent.retriesLeft);

    if (queuedEvent.retriesLeft > 0) {
      queuedEvent.nextRetryMs = millis() + 2000;
    } else {
      Serial.println(F("[EVENT] ❌ Max retries reached. Dropping event."));
      queuedEvent.pending = false;
    }
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────────
//  7. SCHEDULE & STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────────
void checkSchedule() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;

  // Midnight Auto-Reset (00:00)
  if (lastResetDay != timeinfo.tm_mday) {
    lastResetDay = timeinfo.tm_mday;
    for (int i = 0; i < scheduleCount; i++) {
      scheduleList[i].givenToday = false;
    }
    activeDoseIndex = -1;
    activeCompartment = -1;
    closeLid();
    turnOffAllLeds();
    currentState = STATE_IDLE;
    Serial.println(F("[SCHEDULER] 🌙 Midnight reached: givenToday reset for all compartments."));
  }

  int currentMinutes = timeinfo.tm_hour * 60 + timeinfo.tm_min;

  // Scan schedule for due dose (Strictly No Auto-Expiry)
  if (currentState == STATE_IDLE) {
    for (int i = 0; i < scheduleCount; i++) {
      if (!scheduleList[i].givenToday) {
        int dueMinutes = scheduleList[i].hour * 60 + scheduleList[i].minute;
        int diff = currentMinutes - dueMinutes;

        if (diff >= 0) {
          activeDoseIndex = i;
          activeCompartment = scheduleList[i].compartment;
          currentState = STATE_REMINDER;
          closeLid(); // Enforce lid is strictly closed (0°) until ultrasonic signal

          Serial.printf("[SCHEDULER] 🔔 Dose DUE for Slot %d: %s (%s) at %02d:%02d\n",
                        activeCompartment + 1,
                        scheduleList[i].label,
                        scheduleList[i].dosage,
                        scheduleList[i].hour,
                        scheduleList[i].minute);
          Serial.println(F("[SCHEDULER] ⏳ Lid is CLOSED. Displaying alert. Waiting for patient to approach within 15-20cm on D5..."));

          // First alert on display to take medicine
          char line1[17];
          char line2[17];
          snprintf(line1, sizeof(line1), "Take: %.10s", scheduleList[i].label);
          snprintf(line2, sizeof(line2), "Dose: %.10s", scheduleList[i].dosage);
          printLcdStatus(line1, line2);
          break;
        }
      }
    }
  }
}

void pollHardware() {
  unsigned long now = millis();
  if (now - lastSensorPollMs < SENSOR_POLL_INTERVAL_MS) return;
  lastSensorPollMs = now;

  // 1. Ultrasonic Presence Sensing (15-20 cm threshold on D5)
  float dist = readDistanceCm();
  presenceDetected = (dist <= PRESENCE_DISTANCE_CM);

  // 2. State Transition: REMINDER -> DISPENSING strictly upon Ultrasonic Presence (15-20 cm)
  if (currentState == STATE_REMINDER && presenceDetected && activeDoseIndex >= 0) {
    Serial.printf("[ULTRASONIC] 🎯 Patient approached at %.1f cm (<= 20cm on D5)! Opening lid to DISPENSE.\n", dist);
    currentState = STATE_DISPENSING;
    setBuzzerHardware(false); // Silence buzzer immediately

    openLid(); // Lid opens ONLY after ultrasonic sensor receives signal!

    // Solid LED on assigned compartment
    turnOffAllLeds();
    setCompartmentLed(activeCompartment, true);

    char line1[17];
    char line2[17];
    snprintf(line1, sizeof(line1), "Take: %.10s", scheduleList[activeDoseIndex].label);
    snprintf(line2, sizeof(line2), "Slot %d | PressBtn", activeCompartment + 1);
    printLcdStatus(line1, line2);
  }

  // 3. State Transition: DISPENSING -> TAKEN upon Push Button Confirmation
  if (currentState == STATE_DISPENSING && activeDoseIndex >= 0) {
    int buttonVal = digitalRead(BUTTON_PIN);
    bool buttonPressed = (buttonVal == LOW); // LOW = pressed with INPUT_PULLUP

    if (buttonPressed) {
      Serial.printf("[BUTTON] ✅ Push button pressed! Pill intake confirmed for Slot %d (%s).\n",
                    activeCompartment + 1, scheduleList[activeDoseIndex].label);

      closeLid(); // Close lid immediately upon button press
      turnOffAllLeds();

      scheduleList[activeDoseIndex].givenToday = true;
      currentState = STATE_TAKEN;
      takenStateEnteredMs = millis();

      // Enqueue DOSE_TAKEN event for dashboard
      queueDoseTakenEvent(activeCompartment,
                          scheduleList[activeDoseIndex].label,
                          scheduleList[activeDoseIndex].dosage);

      // Confirmation chirp
      triggerShortBeep();

      char line1[17];
      char line2[17];
      snprintf(line1, sizeof(line1), "Dose Confirmed!");
      snprintf(line2, sizeof(line2), "%.16s", scheduleList[activeDoseIndex].label);
      printLcdStatus(line1, line2, 3000);
    }
  }

  // 4. Return to IDLE from TAKEN after 3-second cooldown
  if (currentState == STATE_TAKEN && (now - takenStateEnteredMs > 3000)) {
    currentState = STATE_IDLE;
    activeDoseIndex = -1;
    activeCompartment = -1;
    printLcdStatus("JEEVAN MedBox", getNormalTimeStr());
  }

  // 5. Idle Display: Show "JEEVAN MedBox" and live normal time (updates every second)
  if (currentState == STATE_IDLE && now >= lcdBannerUntilMs) {
    static unsigned long lastIdleLcdMs = 0;
    if (now - lastIdleLcdMs >= 1000) {
      lastIdleLcdMs = now;
      printLcdStatus("JEEVAN MedBox", getNormalTimeStr());
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  8. HEARTBEAT TELEMETRY (PORT 5050)
// ─────────────────────────────────────────────────────────────────────────────────
void sendHeartbeat() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;

  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d/api/hardware/heartbeat", DASHBOARD_HOST, DASHBOARD_PORT);

  if (!http.begin(client, url)) {
    Serial.println(F("[HEARTBEAT] Failed to begin HTTP client"));
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(1500);

  StaticJsonDocument<384> doc;
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
    StaticJsonDocument<512> respDoc;
    DeserializationError err = deserializeJson(respDoc, response);
    if (!err) {
      if (respDoc.containsKey("epoch")) {
        time_t srvEpoch = respDoc["epoch"].as<time_t>();
        if (srvEpoch > 1700000000) {
          struct timeval tv = { .tv_sec = srvEpoch, .tv_usec = 0 };
          settimeofday(&tv, NULL);
          setenv("TZ", "IST-5:30", 1);
          tzset();
        }
      }

      if (respDoc.containsKey("assignedSlot")) {
        JsonObject slotObj = respDoc["assignedSlot"];
        int comp = slotObj["compartment"] | 0;
        const char* label = slotObj["label"] | "";
        const char* dosage = slotObj["dosage"] | "";
        const char* timeStr = slotObj["time"] | "";
        triggerSlotAssigned(comp, label, dosage, timeStr);
      } else {
        bool remoteOpen = respDoc["remoteOpen"] | false;
        if (remoteOpen) {
          int comp = respDoc["compartment"] | -1;
          if (comp >= 0 && comp < NUM_COMPARTMENTS) {
            triggerSlotAssigned(comp, "", "", "");
          } else {
            triggerRemoteOpen();
          }
        }
      }
    }
  } else {
    Serial.printf("[HEARTBEAT] POST failed, HTTP Code: %d\n", httpCode);
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────────
//  9. HTTP SERVER ROUTE HANDLERS (PORT 80)
// ─────────────────────────────────────────────────────────────────────────────────
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

void handleGetSchedule() {
  static StaticJsonDocument<1536> doc;
  doc.clear();
  JsonArray array = doc.createNestedArray("schedule");

  for (int i = 0; i < scheduleCount; i++) {
    JsonObject obj = array.createNestedObject();
    obj["hour"] = scheduleList[i].hour;
    obj["minute"] = scheduleList[i].minute;
    obj["compartment"] = scheduleList[i].compartment;
    obj["label"] = scheduleList[i].label;
    obj["dosage"] = scheduleList[i].dosage;
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
  static StaticJsonDocument<1536> doc;
  doc.clear();
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

    int comp = v["compartment"] | 0;
    if (comp < 0 || comp >= NUM_COMPARTMENTS) {
      Serial.printf("[HTTP] ⚠️ Skipping entry with invalid compartment %d\n", comp);
      continue;
    }

    int hr = v["hour"] | 0;
    int mn = v["minute"] | 0;
    if (hr < 0 || hr > 23 || mn < 0 || mn > 59) {
      Serial.printf("[HTTP] ⚠️ Skipping entry with invalid time %02d:%02d\n", hr, mn);
      continue;
    }

    scheduleList[scheduleCount].hour = hr;
    scheduleList[scheduleCount].minute = mn;
    scheduleList[scheduleCount].compartment = comp;

    const char* lbl = v["label"] | "Medicine";
    strncpy(scheduleList[scheduleCount].label, lbl, sizeof(scheduleList[scheduleCount].label) - 1);
    scheduleList[scheduleCount].label[sizeof(scheduleList[scheduleCount].label) - 1] = '\0';

    const char* dsg = v["dosage"] | "1 dose";
    strncpy(scheduleList[scheduleCount].dosage, dsg, sizeof(scheduleList[scheduleCount].dosage) - 1);
    scheduleList[scheduleCount].dosage[sizeof(scheduleList[scheduleCount].dosage) - 1] = '\0';

    scheduleList[scheduleCount].givenToday = v["givenToday"] | false;
    scheduleCount++;
  }

  Serial.printf("[HTTP] Saved POST /api/schedule: %d entries loaded into RAM\n", scheduleCount);
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{\"status\":\"ok\"}");
}

void handleAssignCompartment() {
  if (!server.hasArg("plain")) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server.arg("plain");
  StaticJsonDocument<384> doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  int comp = doc["compartment"] | 0;
  if (comp < 0 || comp >= NUM_COMPARTMENTS) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "application/json", "{\"error\":\"Invalid compartment. Must be 0, 1, 2, or 3.\"}");
    return;
  }

  const char* label = doc["label"] | "";
  const char* dosage = doc["dosage"] | "";
  const char* timeStr = doc["time"] | "";

  triggerSlotAssigned(comp, label, dosage, timeStr);

  server.sendHeader("Access-Control-Allow-Origin", "*");
  char resp[96];
  snprintf(resp, sizeof(resp), "{\"status\":\"ok\",\"assignedCompartment\":%d,\"lidOpen\":false}", comp);
  server.send(200, "application/json", resp);
}

// ─────────────────────────────────────────────────────────────────────────────────
//  10. BULLETPROOF WIFI ENGINE
// ─────────────────────────────────────────────────────────────────────────────────
void initWiFiConnection() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.setAutoReconnect(true);

  printLcdStatus("Scanning WiFi...", "Please wait", 3000);
  Serial.println(F("\n[WiFi] Scanning visible 2.4GHz WiFi networks..."));

  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d visible networks:\n", n);

  bool matched = false;
  for (int i = 0; i < n; ++i) {
    String found = WiFi.SSID(i);
    Serial.printf("  %2d: '%s' (RSSI: %d dBm, Ch: %d)\n", i + 1, found.c_str(), WiFi.RSSI(i), WiFi.channel(i));

    if (!matched && (found == "ElderCare" || found == "ElderCare " || found.startsWith("ElderCare"))) {
      activeSSID = found;
      matched = true;
      Serial.printf("[WiFi] >>> Matched Target Hotspot: '%s' <<<\n", activeSSID.c_str());
    }
  }

  Serial.printf("[WiFi] Connecting to SSID: '%s'...\n", activeSSID.c_str());
  printLcdStatus("Connecting to:", activeSSID, 4000);

  WiFi.begin(activeSSID.c_str(), WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 25) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("\n[WiFi] Connected! IP Address: %s\n", WiFi.localIP().toString().c_str());
    printLcdStatus("WiFi Connected", WiFi.localIP().toString(), 3000);
    syncTime();
  } else {
    wifiConnected = false;
    digitalWrite(STATUS_LED_PIN, LOW);
    Serial.println(F("\n[WiFi] Initial connection timed out. Background retry engine active."));
    printLcdStatus("WiFi Failed", "Retrying in bg", 3000);
  }
}

void maintainWiFi() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      digitalWrite(STATUS_LED_PIN, LOW);
      Serial.println(F("[WiFi] ⚠️ Connection dropped! Attempting background recovery..."));
      printLcdStatus("WiFi Dropped", "Retrying...", 3000);
    }

    if (now - lastWiFiRetryMs >= WIFI_RETRY_INTERVAL_MS) {
      lastWiFiRetryMs = now;
      Serial.printf("[WiFi] Retrying connection to '%s'...\n", activeSSID.c_str());
      WiFi.reconnect();
    }
  } else {
    if (!wifiConnected) {
      wifiConnected = true;
      digitalWrite(STATUS_LED_PIN, HIGH);
      Serial.printf("[WiFi] ✅ Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
      printLcdStatus("WiFi Connected", WiFi.localIP().toString(), 3000);
      syncTime();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  11. SETUP & LOOP
// ─────────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=================================================="));
  Serial.println(F(" JEEVAN Smart Medicine Box — 4-Slot Production"));
  Serial.println(F(" 1x Shared Servo Lid | 4x Compartment LEDs"));
  Serial.println(F("=================================================="));

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

#if ENABLE_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif

  // Sensor Pins
  pinMode(HC_TRIG_PIN, OUTPUT);
  pinMode(HC_ECHO_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP); // Push button / touch with internal pull-up

  // Setup 4× Compartment LEDs
  for (int i = 0; i < NUM_COMPARTMENTS; i++) {
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW);
  }

  // Setup 1× SG90 Servo on GPIO 13
  lidServo.setPeriodHertz(50);
  lidServo.attach(SERVO_PIN, 500, 2400);
  lidServo.write(0); // 0° = closed

  // Initialize LCD with bus error protection
  initLCD();

  // Initialize WiFi connection
  initWiFiConnection();

  // Setup Web Server Routes
  server.on("/api/schedule", HTTP_OPTIONS, handleCORS);
  server.on("/api/schedule", HTTP_GET, handleGetSchedule);
  server.on("/api/schedule", HTTP_POST, handlePostSchedule);

  server.on("/api/compartment/assign", HTTP_OPTIONS, handleCORS);
  server.on("/api/compartment/assign", HTTP_POST, handleAssignCompartment);

  server.begin();
  Serial.println(F("[HTTP] ESP32 Web Server started on port 80"));
}

void loop() {
  unsigned long now = millis();

  // 1. Maintain WiFi in background
  maintainWiFi();

  // 2. Handle incoming HTTP requests on port 80
  server.handleClient();

  // 3. Non-blocking Audio Sequencer
  updateBuzzer();

  // 4. Check Non-blocking Remote Open duration (closes after 3s)
  checkRemoteOpenTimeout();

  // 5. Check assigned slot reload window (closes after 10s or upon button press)
  checkAssignedSlotTimeout();

  // 6. 1-second Schedule Loop (No auto-missed expiry)
  if (now - lastSchedulerMs >= SCHEDULER_INTERVAL_MS) {
    lastSchedulerMs = now;
    checkSchedule();
  }

  // 7. 200ms Hardware Sensor Polling & State Progression
  pollHardware();

  // 8. Non-blocking Event Queue Processor (with up to 3 retries)
  processEventQueue();

  // 9. 5-second Heartbeat Telemetry to Dashboard (Port 5050)
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    sendHeartbeat();
  }
}