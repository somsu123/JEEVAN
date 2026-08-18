/*
  ============================================================================
  SMART MEDICINE BOX - ESP32
  ============================================================================
  Hardware (matches the wiring diagram):
    HC-SR04   : TRIG -> GPIO5   ECHO -> GPIO18 (via 1k/2k divider to 3.3V)
    Lid servo : signal -> GPIO13   (external 5V supply, common GND)
    LEDs      : LED1 -> GPIO27  LED2 -> GPIO26  LED3 -> GPIO25  LED4 -> GPIO33
    Switch    : GPIO4, INPUT_PULLUP, other leg to GND (shared confirm button)
    LCD       : I2C, SDA -> GPIO21  SCL -> GPIO22  (PCF8574 backpack, addr 0x27)

  Required libraries (install via Arduino Library Manager):
    - ESP32Servo          (by Kevin Harrington / madhephaestus)
    - LiquidCrystal_I2C   (by Frank de Brabander)
    - WebServer           (built into ESP32 board package)

  Behaviour:
    1. Connects to Wi-Fi ("ElderCare "), syncs real time over NTP.
    2. At each scheduled dose time, waits for the patient to approach
       (HC-SR04) before opening the lid - saves servo wear.
    3. Lights the LED for the correct compartment and shows dosage on LCD.
    4. Waits for confirm switch. On press: closes lid, turns off LED, logs.
    5. Web dashboard on http://<esp32-ip>/ shows status, history, and test button.
  ============================================================================
*/

#include "esp_wifi.h"
#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <WebServer.h>
#include <time.h>

// ---------------------------------------------------------------------------
// USER CONFIG - edit these
// ---------------------------------------------------------------------------
const char *WIFI_SSID     = "ElderCare ";       // Hotspot name (matches bpm_bracelet)
const char *WIFI_PASSWORD = "ami bolbona";      // Hotspot password

const long GMT_OFFSET_SEC     = 19800;          // IST = UTC+5:30
const int  DAYLIGHT_OFFSET_SEC = 0;
const char *NTP_SERVER        = "pool.ntp.org";

// ---------------------------------------------------------------------------
// PIN DEFINITIONS
// ---------------------------------------------------------------------------
#define TRIG_PIN     5
#define ECHO_PIN     18
#define SERVO_PIN    13
#define SWITCH_PIN   4

const int LED_PIN[4] = {27, 26, 25, 33};

// ---------------------------------------------------------------------------
// TUNABLE CONSTANTS
// ---------------------------------------------------------------------------
const int SERVO_CLOSED_ANGLE   = 0;
const int SERVO_OPEN_ANGLE     = 90;
const float PRESENCE_THRESHOLD_CM = 15.0;
const unsigned long PENDING_TIMEOUT_MS = 30UL * 60UL * 1000UL; // 30 min to approach
const unsigned long CONFIRM_TIMEOUT_MS = 10UL * 60UL * 1000UL; // 10 min to confirm
const unsigned long DEBOUNCE_MS        = 50;
const unsigned long SENSOR_POLL_MS     = 300;

// ---------------------------------------------------------------------------
// DOSE SCHEDULE - edit times / compartments / labels as needed
// ---------------------------------------------------------------------------
struct Dose {
  int hour;
  int minute;
  int compartment;   // index into LED_PIN[]
  const char *label; // shown on LCD
  bool givenToday;
};

Dose schedule[] = {
  {8,  0, 0, "Vitamin D - 1 tab", false},
  {13, 0, 1, "Amoxicillin - 2 tabs", false},
  {18, 0, 2, "BP tab - 1 tab", false},
  {21, 0, 3, "Night tab - 1 tab", false}
};
const int NUM_DOSES = sizeof(schedule) / sizeof(schedule[0]);

// ---------------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------------
enum BoxState { IDLE, PENDING_PRESENCE, ACTIVE_DOSE };
BoxState state = IDLE;

int activeDoseIndex = -1;
unsigned long stateEnteredAt = 0;
unsigned long lastSensorPoll = 0;

int lastSwitchReading = HIGH;
unsigned long lastDebounceTime = 0;
int lastDayChecked = -1;

// simple in-memory history log (most recent 10 events)
struct LogEntry {
  String text;
};
LogEntry history[10];
int historyCount = 0;

// ---------------------------------------------------------------------------
// OBJECTS
// ---------------------------------------------------------------------------
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo lidServo;
WebServer server(80);

// Forward declarations
void handleRoot();
void handleStatus();
void handleTest();
void checkSchedule(struct tm &timeinfo);
void startPendingDose(int index);
void handlePendingPresence();
void handleActiveDose();
void checkSwitchPress();
void confirmDose();
void openDose();
void closeAndReset();
void resetToIdle();
void resetDailyFlagsIfNewDay(int currentDay);
float readDistanceCM();
void addLog(String text);
void connectWiFi();
void syncTime();

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.println(F("╔══════════════════════════════════════════════╗"));
  Serial.println(F("║   Elder-Care — Smart Medicine Box (ESP32)    ║"));
  Serial.println(F("╚══════════════════════════════════════════════╝"));

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(SWITCH_PIN, INPUT_PULLUP);
  for (int i = 0; i < 4; i++) {
    pinMode(LED_PIN[i], OUTPUT);
    digitalWrite(LED_PIN[i], LOW);
  }

  lidServo.setPeriodHertz(50);
  lidServo.attach(SERVO_PIN, 500, 2400);
  lidServo.write(SERVO_CLOSED_ANGLE);

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Medicine Box");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi");

  connectWiFi();
  syncTime();

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/test", handleTest);
  server.begin();

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("System Ready");
  lcd.setCursor(0, 1);
  if (WiFi.status() == WL_CONNECTED) {
    lcd.print(WiFi.localIP().toString());
  } else {
    lcd.print("Offline Mode");
  }
  addLog("System started");
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
void loop() {
  server.handleClient();

  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return; // time not synced yet, skip this cycle
  }

  resetDailyFlagsIfNewDay(timeinfo.tm_mday);

  switch (state) {
    case IDLE:
      checkSchedule(timeinfo);
      break;

    case PENDING_PRESENCE:
      handlePendingPresence();
      break;

    case ACTIVE_DOSE:
      handleActiveDose();
      break;
  }
}

// ---------------------------------------------------------------------------
// SCHEDULE CHECK
// ---------------------------------------------------------------------------
void checkSchedule(struct tm &timeinfo) {
  for (int i = 0; i < NUM_DOSES; i++) {
    if (!schedule[i].givenToday &&
        schedule[i].hour == timeinfo.tm_hour &&
        schedule[i].minute == timeinfo.tm_min) {
      startPendingDose(i);
      return;
    }
  }
}

void startPendingDose(int index) {
  activeDoseIndex = index;
  state = PENDING_PRESENCE;
  stateEnteredAt = millis();

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Dose time!");
  lcd.setCursor(0, 1);
  lcd.print("Approach box...");

  addLog(String("Dose scheduled: ") + schedule[index].label);
}

// ---------------------------------------------------------------------------
// PENDING - waiting for patient presence
// ---------------------------------------------------------------------------
void handlePendingPresence() {
  if (millis() - lastSensorPoll >= SENSOR_POLL_MS) {
    lastSensorPoll = millis();
    float dist = readDistanceCM();

    if (dist > 0 && dist <= PRESENCE_THRESHOLD_CM) {
      openDose();
      return;
    }
  }

  if (millis() - stateEnteredAt >= PENDING_TIMEOUT_MS) {
    addLog(String("MISSED (no approach): ") + schedule[activeDoseIndex].label);
    schedule[activeDoseIndex].givenToday = true;
    resetToIdle();
  }
}

void openDose() {
  state = ACTIVE_DOSE;
  stateEnteredAt = millis();

  int comp = schedule[activeDoseIndex].compartment;
  digitalWrite(LED_PIN[comp], HIGH);
  lidServo.write(SERVO_OPEN_ANGLE);

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Take medicine:");
  lcd.setCursor(0, 1);
  lcd.print(schedule[activeDoseIndex].label);

  addLog(String("Lid opened: ") + schedule[activeDoseIndex].label);
}

// ---------------------------------------------------------------------------
// ACTIVE - waiting for button confirmation
// ---------------------------------------------------------------------------
void handleActiveDose() {
  checkSwitchPress();

  if (millis() - stateEnteredAt >= CONFIRM_TIMEOUT_MS) {
    addLog(String("MISSED (no confirm): ") + schedule[activeDoseIndex].label);
    closeAndReset();
  }
}

void checkSwitchPress() {
  int reading = digitalRead(SWITCH_PIN);

  if (reading != lastSwitchReading) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > DEBOUNCE_MS) {
    if (reading == LOW) { // pressed (active low with INPUT_PULLUP)
      confirmDose();
    }
  }
  lastSwitchReading = reading;
}

void confirmDose() {
  addLog(String("CONFIRMED: ") + schedule[activeDoseIndex].label);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Confirmed, thanks");
  closeAndReset();
}

void closeAndReset() {
  int comp = schedule[activeDoseIndex].compartment;
  digitalWrite(LED_PIN[comp], LOW);
  lidServo.write(SERVO_CLOSED_ANGLE);
  schedule[activeDoseIndex].givenToday = true;
  resetToIdle();
}

void resetToIdle() {
  activeDoseIndex = -1;
  state = IDLE;
  delay(1500);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Medicine Box");
  lcd.setCursor(0, 1);
  if (WiFi.status() == WL_CONNECTED) {
    lcd.print(WiFi.localIP().toString());
  } else {
    lcd.print("Waiting...");
  }
}

// ---------------------------------------------------------------------------
// DAILY RESET
// ---------------------------------------------------------------------------
void resetDailyFlagsIfNewDay(int currentDay) {
  if (lastDayChecked != currentDay) {
    lastDayChecked = currentDay;
    for (int i = 0; i < NUM_DOSES; i++) {
      schedule[i].givenToday = false;
    }
    addLog("Daily schedule reset");
  }
}

// ---------------------------------------------------------------------------
// HC-SR04
// ---------------------------------------------------------------------------
float readDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout ~5m range
  if (duration == 0)
    return -1;
  return duration * 0.0343 / 2.0;
}

// ---------------------------------------------------------------------------
// WI-FI + TIME (Exact bpm_bracelet.ino engine)
// ---------------------------------------------------------------------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.setAutoReconnect(true);

  Serial.println(F("[WiFi] Scanning visible 2.4 GHz networks..."));
  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d networks:\n", n);
  String targetSSID = WIFI_SSID;
  for (int i = 0; i < n; ++i) {
    String found = WiFi.SSID(i);
    Serial.printf("  %2d: '%s' (RSSI: %d, Ch: %d, Auth: %d)\n", i + 1,
                  found.c_str(), WiFi.RSSI(i), WiFi.channel(i),
                  (int)WiFi.encryptionType(i));
    if (found == "ElderCare" || found == "ElderCare " || found.startsWith("ElderCare")) {
      targetSSID = found;
      Serial.printf("      --> Match found for Hotspot: '%s'\n", targetSSID.c_str());
    }
  }

  Serial.printf("[WiFi] Connecting to '%s'...\n", targetSSID.c_str());
  WiFi.begin(targetSSID.c_str(), WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("[WiFi] Connection timed out. ESP32 will continue retrying in background."));
  }
}

void syncTime() { 
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER); 
}

// ---------------------------------------------------------------------------
// LOGGING (in-memory, last 10 events)
// ---------------------------------------------------------------------------
void addLog(String text) {
  struct tm timeinfo;
  String stamp = "";
  if (getLocalTime(&timeinfo)) {
    char buf[16];
    sprintf(buf, "%02d:%02d:%02d ", timeinfo.tm_hour, timeinfo.tm_min,
            timeinfo.tm_sec);
    stamp = String(buf);
  }
  for (int i = 9; i > 0; i--)
    history[i] = history[i - 1];
  history[0].text = stamp + text;
  if (historyCount < 10)
    historyCount++;
  Serial.println(stamp + text);
}

// ---------------------------------------------------------------------------
// WEB DASHBOARD
// ---------------------------------------------------------------------------
void handleRoot() {
  String html = "<html><head><meta http-equiv='refresh' content='10'>";
  html += "<style>body{font-family:sans-serif;max-width:480px;margin:30px auto;}";
  html += "h2{margin-bottom:4px}li{margin:4px 0}</style></head><body>";
  html += "<h2>Medicine Box</h2>";

  html += "<p><b>State:</b> ";
  if (state == IDLE)
    html += "Idle";
  else if (state == PENDING_PRESENCE)
    html += "Waiting for patient - " + String(schedule[activeDoseIndex].label);
  else
    html += "Lid open - " + String(schedule[activeDoseIndex].label);
  html += "</p>";

  html += "<h3>Today's schedule</h3><ul>";
  for (int i = 0; i < NUM_DOSES; i++) {
    html += "<li>" + String(schedule[i].hour) + ":" +
            (schedule[i].minute < 10 ? "0" : "") + String(schedule[i].minute) +
            " - " + schedule[i].label +
            (schedule[i].givenToday ? " (done)" : "") + "</li>";
  }
  html += "</ul>";

  html += "<h3>Recent activity</h3><ul>";
  for (int i = 0; i < historyCount; i++) {
    html += "<li>" + history[i].text + "</li>";
  }
  html += "</ul>";

  html += "<p><a href='/test'>Trigger a test dose now</a></p>";
  html += "</body></html>";

  server.send(200, "text/html", html);
}

void handleStatus() {
  String json = "{";
  json += "\"state\":\"" +
          String(state == IDLE               ? "idle"
                 : state == PENDING_PRESENCE ? "pending"
                                             : "active") +
          "\",";
  json += "\"activeDose\":\"" +
          String(activeDoseIndex >= 0 ? schedule[activeDoseIndex].label : "") +
          "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleTest() {
  if (state == IDLE) {
    startPendingDose(0);
  }
  server.sendHeader("Location", "/");
  server.send(303);
}
