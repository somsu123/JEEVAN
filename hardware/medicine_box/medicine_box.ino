/*
 * ============================================================
 *  ElderCare Smart Medicine Box — ESP32 Firmware
 *  Board  : ESP32 Dev Module (38-pin)
 *  Version: 1.1.0  (strapping-pin-safe edition)
 * ============================================================
 *
 *  YOUR HARDWARE:
 *   1. ESP32 Dev Module (38 pins)
 *   2. 1.44" TFT Display (ST7735, 128×128)
 *   3. HC-SR04 Ultrasonic Sensor
 *   4. TTP223 Touch Sensor
 *   5. 3× SG90 Servo Motors
 *
 *  SAFE PIN MAP (no strapping-pin conflicts):
 *  ┌──────────────────────────────────────────────┐
 *  │  GPIO 26  — HC-SR04 TRIG (output)            │
 *  │  GPIO 25  — HC-SR04 ECHO (input)             │
 *  │  GPIO 34  — TTP223 Touch OUT (INPUT ONLY)    │
 *  │  GPIO 16  — Servo 1 Signal (Box 1, PWM)      │
 *  │  GPIO 17  — Servo 2 Signal (Box 2, PWM)      │
 *  │  GPIO 33  — Servo 3 Signal (Box 3, PWM)      │
 *  │  GPIO 27  — Active Buzzer (optional)          │
 *  │  GPIO 18  — TFT SCK (SPI)                    │
 *  │  GPIO 23  — TFT MOSI / SDA (SPI)             │
 *  │  GPIO 22  — TFT CS                            │
 *  │  GPIO 21  — TFT DC (A0/RS)                   │
 *  │  GPIO 32  — TFT RST                           │
 *  │  3.3V     — TFT VCC, TFT LED/BL, TTP223 VCC  │
 *  │  5V       — HC-SR04 VCC, Servo VCC (×3)      │
 *  │  GND      — All GND rails                     │
 *  └──────────────────────────────────────────────┘
 *
 *  STRAPPING PINS TO AVOID ON ESP32:
 *   GPIO  0 — Boot mode selector       → NEVER use
 *   GPIO  2 — Must be LOW for download → avoid
 *   GPIO  5 — VSPI CS0 strapping      → avoid for inputs
 *   GPIO 12 — Flash voltage selector  → CRITICAL: HIGH at boot bricks ESP32
 *   GPIO 15 — Suppresses boot log     → minor, but avoid
 *
 *  IMPORTANT — TFT LED pin:
 *   Connect the TFT module's "LED" or "BL" pin to 3.3V.
 *   Without this, the screen stays completely dark!
 *
 *  Libraries (install via Arduino Library Manager):
 *    - Adafruit ST7735 and ST7789 Library  (by Adafruit)
 *    - Adafruit GFX Library                (by Adafruit)
 *    - ESP32Servo                          (by Kevin Harrington)
 *    - ArduinoJson                         (by Benoit Blanchon, v6.x)
 *
 *  SERVER: This firmware talks to dashboard-v2 (Node/Express) on port 5050.
 *  Edit WIFI_SSID, WIFI_PASSWORD, and SERVER_IP below before flashing.
 * ============================================================
 */

#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <WiFi.h>
#include <time.h>

// ─── User Configuration
// ───────────────────────────────────────────────────────
#define WIFI_SSID "Elder Care"
#define WIFI_PASSWORD "ami bolbona "
#define SERVER_IP " 10.206.196.135" // IP of the PC running dashboard-v2
#define SERVER_PORT 5050
#define DEVICE_ID "medbox-01"

// ─── Component Flags ─────────────────────────────────────────────────────────
// Set to 0 if you don't have a buzzer
#define HAS_BUZZER 0 // ← change to 1 if you add a buzzer later

// ─── Pin Definitions (SAFE — no strapping pins used) ─────────────────────────
#define TRIG_PIN 26 // HC-SR04 TRIG — OUTPUT
#define ECHO_PIN 25 // HC-SR04 ECHO — INPUT
#define TOUCH_PIN                                                              \
  34 // TTP223 OUT   — INPUT ONLY (GPIO 34 is input-only on ESP32)
#define SERVO1_PIN 16 // Box 1 Servo  — PWM
#define SERVO2_PIN 17 // Box 2 Servo  — PWM
#define SERVO3_PIN 33 // Box 3 Servo  — PWM (restored to 33 to match your existing wiring)
#define LED_PIN 4     // LED indicator (moved to safe unused Pin 4 to avoid conflict)
#define BUZZER_PIN 27 // Buzzer       — optional
#define TFT_SCK 18    // TFT SCK
#define TFT_MOSI 23   // TFT MOSI/SDA
#define TFT_CS 22     // TFT CS
#define TFT_DC 21     // TFT DC/A0
#define TFT_RST 32    // TFT RST

// ─── Tuneable Constants
// ───────────────────────────────────────────────────────
#define PRESENCE_DIST_CM 40                  // patient detected if < 40 cm
#define MISSED_TIMEOUT_MS (15UL * 60 * 1000) // 15-minute window
#define HEARTBEAT_INTERVAL_MS 10000          // heartbeat every 10 s
#define SCHEDULE_POLL_MS 60000               // re-fetch schedule every 60 s
#define SERVO_OPEN_ANGLE 90
#define SERVO_CLOSE_ANGLE 0
#define MAX_DOSES 5
#define NTP_OFFSET_SEC 19800 // IST = UTC+5:30

// ─── State Machine
// ────────────────────────────────────────────────────────────
enum BoxState {
  STATE_IDLE,
  STATE_REMINDER,
  STATE_DISPENSING,
  STATE_CONFIRMED,
  STATE_MISSED
};
const char *stateNames[] = {"IDLE", "REMINDER", "DISPENSING", "CONFIRMED",
                            "MISSED"};

// ─── Dose Struct
// ──────────────────────────────────────────────────────────────
struct Dose {
  char medicine[32];
  char dosage[16];
  uint8_t boxNumber;
  uint8_t hour;
  uint8_t minute;
  bool taken;
  bool missed;
  bool triggered; // prevents re-firing within the 2-min window
};

// ─── Globals
// ────────────────────────────────────────────────────────────────── Software
// SPI constructor — works with any GPIO, args: (CS, DC, MOSI, SCLK, RST)
Adafruit_ST7735 tft =
    Adafruit_ST7735(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCK, TFT_RST);
Servo servos[3];

Dose schedule[MAX_DOSES];
int doseCount = 0;
int currentDoseIdx = -1;
BoxState currentState = STATE_IDLE;
unsigned long reminderStart = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastSchedulePoll = 0;
unsigned long bootTime = 0;
bool touchHandled = false;

// ─── Color Palette (RGB565)
// ───────────────────────────────────────────────────
#define COL_BG 0x0000
#define COL_GREEN 0x07E0
#define COL_AMBER 0xFD20
#define COL_RED 0xF800
#define COL_BLUE 0x001F
#define COL_WHITE 0xFFFF
#define COL_GRAY 0x8410
#define COL_EMERALD 0x0400
#define COL_DKRED 0x1800
#define COL_DKGREEN 0x0120

// ─── Buzzer (compiled out when HAS_BUZZER = 0) ───────────────────────────────
void buzzOnce(int ms = 100) {
#if HAS_BUZZER
  digitalWrite(BUZZER_PIN, HIGH);
  delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
#else
  (void)ms;
#endif
}
void buzzReminder() {
  for (int i = 0; i < 3; i++) {
    buzzOnce(150);
    delay(100);
  }
}
void buzzConfirmed() {
  buzzOnce(80);
  delay(60);
  buzzOnce(200);
}

// ─── Ultrasonic
// ───────────────────────────────────────────────────────────────
float measureDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long d = pulseIn(ECHO_PIN, HIGH, 30000);
  if (d == 0)
    return 999.0f;
  return d * 0.0343f / 2.0f;
}
bool isPresent() {
  float d = measureDistanceCm();
  return (d > 0.5f && d < PRESENCE_DIST_CM);
}

// ─── Servo Control
// ────────────────────────────────────────────────────────────
void openBox(int box) {
  if (box < 1 || box > 3)
    return;
  servos[box - 1].write(SERVO_OPEN_ANGLE);
  delay(600);
  Serial.printf("[SERVO] Box %d OPEN\n", box);
}
void closeBox(int box) {
  if (box < 1 || box > 3)
    return;
  servos[box - 1].write(SERVO_CLOSE_ANGLE);
  delay(600);
  Serial.printf("[SERVO] Box %d CLOSE\n", box);
}

// ─── Network Helpers
// ──────────────────────────────────────────────────────────
String serverBase() {
  return String("http://") + SERVER_IP + ":" + SERVER_PORT;
}

void ensureWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.print("[WIFI] Reconnecting...");
    WiFi.reconnect();
    for (int i = 0; i < 10 && WiFi.status() != WL_CONNECTED; i++) {
      delay(500);
      Serial.print(".");
    }
    Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " FAILED");
  }
}

// ─── TFT Display Screens
// ──────────────────────────────────────────────────────
void tftClear() { tft.fillScreen(COL_BG); }

void tftHeader(const char *title, uint16_t color = COL_EMERALD) {
  tft.fillRect(0, 0, 128, 18, color);
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(1);
  tft.setCursor(4, 5);
  tft.print(title);
}

void drawIdleScreen(const char *nextMed, const char *nextTime, bool wifiOk) {
  tftClear();
  tftHeader("ELDERCARE BOX");
  tft.setCursor(106, 5);
  tft.setTextColor(wifiOk ? COL_GREEN : COL_RED);
  tft.print(wifiOk ? "W" : "X");
  tft.setTextColor(COL_GRAY);
  tft.setTextSize(1);
  tft.setCursor(4, 24);
  tft.print("NEXT DOSE:");
  tft.setTextColor(COL_WHITE);
  tft.setCursor(4, 35);
  tft.print(nextMed);
  tft.setTextColor(COL_AMBER);
  tft.setTextSize(2);
  tft.setCursor(4, 50);
  tft.print(nextTime);
  tft.setTextColor(COL_GRAY);
  tft.setTextSize(1);
  tft.setCursor(4, 118);
  tft.print(DEVICE_ID);
}

void drawReminderScreen(const char *med, const char *time, bool present) {
  tft.fillScreen(COL_DKRED);
  tftHeader("! TAKE MEDICINE !", COL_RED);
  tft.setTextColor(COL_GRAY);
  tft.setTextSize(1);
  tft.setCursor(4, 24);
  tft.print("Medicine:");
  tft.setTextColor(COL_AMBER);
  tft.setCursor(4, 34);
  tft.print(med);
  tft.setTextColor(COL_GRAY);
  tft.setCursor(4, 50);
  tft.print("Time:");
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(2);
  tft.setCursor(4, 60);
  tft.print(time);
  tft.setTextSize(1);
  tft.setCursor(4, 86);
  tft.setTextColor(present ? COL_GREEN : COL_GRAY);
  tft.print(present ? "YOU ARE DETECTED" : "Please come closer");
}

void drawDispensingScreen(int boxNum, const char *med) {
  tftClear();
  tftHeader("DISPENSING...", COL_BLUE);
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 28);
  tft.print("BOX ");
  tft.print(boxNum);
  tft.setTextColor(COL_AMBER);
  tft.setTextSize(1);
  tft.setCursor(4, 56);
  tft.print(med);
  tft.setTextColor(COL_GRAY);
  tft.setCursor(4, 80);
  tft.print("Touch sensor");
  tft.setCursor(4, 90);
  tft.print("to confirm...");
  tft.drawCircle(64, 112, 8, COL_AMBER);
  tft.fillCircle(64, 112, 5, COL_AMBER);
}

void drawConfirmedScreen(const char *med) {
  tft.fillScreen(COL_DKGREEN);
  tftHeader("DOSE RECORDED!", COL_GREEN);
  tft.setTextColor(COL_GREEN);
  tft.setTextSize(4);
  tft.setCursor(36, 34);
  tft.print("OK");
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(1);
  tft.setCursor(4, 80);
  tft.print(med);
  tft.setTextColor(COL_GRAY);
  tft.setCursor(4, 95);
  tft.print("Take with water");
}

void drawMissedScreen(const char *med) {
  tftClear();
  tftHeader("DOSE MISSED", COL_RED);
  tft.setTextColor(COL_RED);
  tft.setTextSize(2);
  tft.setCursor(28, 34);
  tft.print(":(");
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(1);
  tft.setCursor(4, 64);
  tft.print(med);
  tft.setTextColor(COL_GRAY);
  tft.setCursor(4, 78);
  tft.print("Caregiver alert");
  tft.setCursor(4, 88);
  tft.print("has been sent.");
}

// ─── Network: Fetch Schedule
// ──────────────────────────────────────────────────
bool fetchSchedule() {
  if (WiFi.status() != WL_CONNECTED)
    return false;
  HTTPClient http;
  http.begin(serverBase() + "/api/medication/schedule?deviceId=" + DEVICE_ID);
  http.setTimeout(5000);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[NET] Schedule HTTP %d\n", code);
    http.end();
    return false;
  }
  String body = http.getString();
  http.end();
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, body)) {
    Serial.println("[NET] JSON parse error");
    return false;
  }
  JsonArray doses = doc["doses"].as<JsonArray>();
  doseCount = 0;
  for (JsonObject d : doses) {
    if (doseCount >= MAX_DOSES)
      break;
    Dose &dose = schedule[doseCount];
    strlcpy(dose.medicine, d["medicine"] | "Unknown", sizeof(dose.medicine));
    strlcpy(dose.dosage, d["dosage"] | "--", sizeof(dose.dosage));
    dose.boxNumber = (uint8_t)(d["boxNumber"] | 1);
    dose.taken = d["taken"] | false;
    dose.missed = d["missed"] | false;
    dose.triggered = false;
    const char *t = d["time"] | "00:00";
    sscanf(t, "%hhu:%hhu", &dose.hour, &dose.minute);
    doseCount++;
  }
  Serial.printf("[NET] Loaded %d doses\n", doseCount);
  return true;
}

// ─── Network: Post Event
// ──────────────────────────────────────────────────────
void postEvent(const char *eventType, int boxNum, const char *medicine,
               const char *dosage) {
  ensureWiFi();
  if (WiFi.status() != WL_CONNECTED)
    return;
  struct tm t;
  char timeStr[10] = "00:00:00";
  if (getLocalTime(&t))
    strftime(timeStr, sizeof(timeStr), "%H:%M:%S", &t);
  DynamicJsonDocument doc(256);
  doc["event"] = eventType;
  doc["box"] = boxNum;
  doc["medicine"] = medicine;
  doc["dosage"] = dosage;
  doc["timestamp"] = timeStr;
  doc["deviceId"] = DEVICE_ID;
  String body;
  serializeJson(doc, body);
  HTTPClient http;
  http.begin(serverBase() + "/api/hardware/medbox-event");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  int code = http.POST(body);
  Serial.printf("[NET] %s → HTTP %d\n", eventType, code);
  http.end();
}

// ─── Network: Heartbeat
// ───────────────────────────────────────────────────────
void postHeartbeat() {
  if (WiFi.status() != WL_CONNECTED)
    return;
  char nextTime[6] = "--:--";
  struct tm t;
  if (getLocalTime(&t)) {
    int nowMin = t.tm_hour * 60 + t.tm_min, best = 99999;
    for (int i = 0; i < doseCount; i++) {
      if (schedule[i].taken || schedule[i].missed)
        continue;
      int diff = (schedule[i].hour * 60 + schedule[i].minute) - nowMin;
      if (diff < 0)
        diff += 1440;
      if (diff < best) {
        best = diff;
        snprintf(nextTime, 6, "%02d:%02d", schedule[i].hour,
                 schedule[i].minute);
      }
    }
  }
  DynamicJsonDocument doc(256);
  doc["deviceId"] = DEVICE_ID;
  doc["state"] = stateNames[currentState];
  doc["presenceDetected"] = isPresent();
  doc["nextDoseTime"] = nextTime;
  doc["uptime"] = (millis() - bootTime) / 1000;
  String body;
  serializeJson(doc, body);
  HTTPClient http;
  http.begin(serverBase() + "/api/hardware/heartbeat");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  http.POST(body);
  http.end();
}

// ─── Schedule: Find Due Dose (2-minute window)
// ────────────────────────────────
int findDueDose() {
  struct tm t;
  if (!getLocalTime(&t))
    return -1;
  int nowMin = t.tm_hour * 60 + t.tm_min;
  for (int i = 0; i < doseCount; i++) {
    if (schedule[i].taken || schedule[i].missed || schedule[i].triggered)
      continue;
    int diff = nowMin - (schedule[i].hour * 60 + schedule[i].minute);
    if (diff >= 0 && diff <= 2)
      return i;
  }
  return -1;
}

// ─── Schedule: Next dose for idle display ────────────────────────────────────
void getNextDoseStr(char *medOut, size_t ml, char *timeOut, size_t tl) {
  strlcpy(medOut, "All done!", ml);
  strlcpy(timeOut, "--:--", tl);
  struct tm t;
  if (!getLocalTime(&t))
    return;
  int nowMin = t.tm_hour * 60 + t.tm_min, best = 99999;
  for (int i = 0; i < doseCount; i++) {
    if (schedule[i].taken || schedule[i].missed)
      continue;
    int diff = (schedule[i].hour * 60 + schedule[i].minute) - nowMin;
    if (diff < 0)
      diff += 1440;
    if (diff < best) {
      best = diff;
      strlcpy(medOut, schedule[i].medicine, ml);
      snprintf(timeOut, tl, "%02d:%02d", schedule[i].hour, schedule[i].minute);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  bootTime = millis();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(TOUCH_PIN, INPUT); // GPIO 34 is input-only; this is fine
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
#if HAS_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif

  // Servos — full SG90 pulse range 500–2400 µs
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  servos[0].setPeriodHertz(50);
  servos[0].attach(SERVO1_PIN, 500, 2400);
  servos[1].setPeriodHertz(50);
  servos[1].attach(SERVO2_PIN, 500, 2400);
  servos[2].setPeriodHertz(50);
  servos[2].attach(SERVO3_PIN, 500, 2400);
  for (int i = 0; i < 3; i++)
    servos[i].write(SERVO_CLOSE_ANGLE);
  delay(800);

  // TFT — INITR_144GREENTAB is correct for 1.44" 128×128 ST7735
  tft.initR(INITR_144GREENTAB);
  tft.setRotation(0);
  tft.fillScreen(COL_BG);
  tftHeader("ELDERCARE BOX");
  tft.setTextColor(COL_WHITE);
  tft.setTextSize(1);
  tft.setCursor(4, 28);
  tft.print("Connecting WiFi...");
  tft.setCursor(4, 40);
  tft.print(WIFI_SSID);

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 24 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected: " + WiFi.localIP().toString());
    tft.setCursor(4, 56);
    tft.setTextColor(COL_GREEN);
    tft.print("WiFi OK");
    // NTP sync (IST = UTC+5:30)
    configTime(NTP_OFFSET_SEC, 0, "pool.ntp.org", "time.google.com");
    Serial.print("[NTP] Syncing time");
    struct tm ti;
    bool ntpOk = false;
    for (int i = 0; i < 30; i++) { // wait up to 15 s
      if (getLocalTime(&ti)) {
        ntpOk = true;
        break;
      }
      delay(500);
      Serial.print(".");
    }
    if (ntpOk) {
      char buf[32];
      strftime(buf, sizeof(buf), "%H:%M:%S", &ti);
      Serial.printf("\n[NTP] Time set: %s IST\n", buf);
    } else {
      Serial.println("\n[NTP] WARNING — NTP sync failed! Reminders may not "
                     "fire correctly.");
    }
    fetchSchedule();
  } else {
    Serial.println("\n[WIFI] Failed — offline mode");
    tft.setCursor(4, 56);
    tft.setTextColor(COL_RED);
    tft.print("WiFi FAILED");
    delay(2000);
  }

  tftClear();
  buzzOnce(300);
  Serial.println("[BOOT] Ready");
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    postHeartbeat();
  }
  if (now - lastSchedulePoll >= SCHEDULE_POLL_MS) {
    lastSchedulePoll = now;
    fetchSchedule();
  }

  switch (currentState) {

  // ── IDLE ─────────────────────────────────────────────────────────────────
  case STATE_IDLE: {
    static unsigned long lastDraw = 0;
    if (now - lastDraw > 1000) {
      lastDraw = now;
      char med[32], t[6];
      getNextDoseStr(med, sizeof(med), t, sizeof(t));
      drawIdleScreen(med, t, WiFi.status() == WL_CONNECTED);
    }
    int due = findDueDose();
    if (due >= 0) {
      schedule[due].triggered = true;
      currentDoseIdx = due;
      reminderStart = now;
      touchHandled = false;
      currentState = STATE_REMINDER;
      buzzReminder();
      Serial.printf("[SM] IDLE → REMINDER (Box %d — %s)\n",
                    schedule[due].boxNumber, schedule[due].medicine);
    }
    break;
  }

  // ── REMINDER ─────────────────────────────────────────────────────────────
  case STATE_REMINDER: {
    if (currentDoseIdx < 0) {
      currentState = STATE_IDLE;
      break;
    }
    Dose &d = schedule[currentDoseIdx];

    // Timeout check first (highest priority)
    if (now - reminderStart >= MISSED_TIMEOUT_MS) {
      currentState = STATE_MISSED;
      Serial.println("[SM] REMINDER timeout → MISSED");
      break;
    }

    static unsigned long lastRDraw = 0;
    if (now - lastRDraw > 2000) {
      lastRDraw = now;
      char ts[6];
      snprintf(ts, sizeof(ts), "%02d:%02d", d.hour, d.minute);
      bool present = isPresent();
      drawReminderScreen(d.medicine, ts, present);
      buzzReminder();
      if (present && currentState == STATE_REMINDER) {
        currentState = STATE_DISPENSING;
        openBox(d.boxNumber);
        Serial.println("[SM] REMINDER → DISPENSING");
      }
    }
    break;
  }

  // ── DISPENSING ────────────────────────────────────────────────────────────
  case STATE_DISPENSING: {
    if (currentDoseIdx < 0) {
      currentState = STATE_IDLE;
      break;
    }
    Dose &d = schedule[currentDoseIdx];

    static unsigned long lastDDraw = 0;
    if (now - lastDDraw > 1000) {
      lastDDraw = now;
      drawDispensingScreen(d.boxNumber, d.medicine);
    }

    // Blink LED and Buzzer at a 1-second interval (non-blocking)
    static unsigned long lastBlinkTime = 0;
    static bool blinkState = false;
    if (now - lastBlinkTime >= 1000) {
      lastBlinkTime = now;
      blinkState = !blinkState;
      digitalWrite(LED_PIN, blinkState ? HIGH : LOW);
#if HAS_BUZZER
      digitalWrite(BUZZER_PIN, blinkState ? HIGH : LOW);
#endif
    }

    // TTP223 — active HIGH when touched
    if (!touchHandled && digitalRead(TOUCH_PIN) == HIGH) {
      delay(50); // debounce
      if (digitalRead(TOUCH_PIN) == HIGH) {
        touchHandled = true;
        // Turn off LED and Buzzer upon confirmation
        digitalWrite(LED_PIN, LOW);
#if HAS_BUZZER
        digitalWrite(BUZZER_PIN, LOW);
#endif
        closeBox(d.boxNumber);
        d.taken = true;
        postEvent("DOSE_TAKEN", d.boxNumber, d.medicine, d.dosage);
        buzzConfirmed();
        drawConfirmedScreen(d.medicine);
        delay(5000);
        currentState = STATE_IDLE;
        Serial.println("[SM] DISPENSING → CONFIRMED → IDLE");
      }
    }

    if (now - reminderStart >= MISSED_TIMEOUT_MS) {
      currentState = STATE_MISSED;
      // Turn off LED and Buzzer on timeout/missed
      digitalWrite(LED_PIN, LOW);
#if HAS_BUZZER
      digitalWrite(BUZZER_PIN, LOW);
#endif
      closeBox(d.boxNumber);
      Serial.println("[SM] DISPENSING timeout → MISSED");
    }
    break;
  }

  // ── CONFIRMED ─────────────────────────────────────────────────────────────
  case STATE_CONFIRMED: {
    currentState = STATE_IDLE;
    break;
  }

  // ── MISSED ────────────────────────────────────────────────────────────────
  case STATE_MISSED: {
    if (currentDoseIdx < 0) {
      currentState = STATE_IDLE;
      break;
    }
    Dose &d = schedule[currentDoseIdx];
    if (!d.missed) {
      d.missed = true;
#if HAS_BUZZER
      digitalWrite(BUZZER_PIN, LOW);
#endif
      digitalWrite(LED_PIN, LOW); // Turn off LED on missed
      closeBox(d.boxNumber);
      postEvent("DOSE_MISSED", d.boxNumber, d.medicine, d.dosage);
      drawMissedScreen(d.medicine);
      delay(4000);
    }
    currentState = STATE_IDLE;
    Serial.println("[SM] MISSED → IDLE");
    break;
  }
  }

  delay(100);
}
