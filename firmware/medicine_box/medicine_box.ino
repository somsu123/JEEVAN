/*
  ============================================================================
  SMART MEDICINE BOX — ESP32  (v3 — Dashboard-Connected)
  ============================================================================
  PIN MAP (matches the diagnostic sketch exactly):
    HC-SR04   : TRIG -> GPIO5    ECHO -> GPIO18  (use 1kΩ/2kΩ voltage divider on
  ECHO) Lid servo : signal -> GPIO13  (external 5V supply, shared GND) LEDs :
  Slot1 -> GPIO27  Slot2 -> GPIO26  Slot3 -> GPIO25  Slot4 -> GPIO33 Switch    :
  GPIO4  INPUT_PULLUP  (one leg to GPIO4, other to GND) LCD       : I2C   SDA ->
  GPIO21  SCL -> GPIO22  (addr 0x27)

  Required libraries (Arduino Library Manager):
    - ESP32Servo          (by Kevin Harrington / madhephaestus)
    - LiquidCrystal_I2C   (by Frank de Brabander)
    - ArduinoJson         (by Benoit Blanchon)  ← NEW
    - WebServer           (built into ESP32 board package)

  Behaviour:
    1. Connects to Wi-Fi, syncs time via NTP (IST UTC+5:30).
    2. Fetches live schedule from your dashboard server every 60 s
       via GET http://<DASHBOARD_IP>:5050/api/esp32/schedule
    3. At each scheduled dose time, waits for patient to approach
       (HC-SR04 within PRESENCE_THRESHOLD_CM) before opening lid.
    4. Lights the compartment LED, shows medicine name on LCD.
    5. Patient presses the confirm switch → lid closes, LED off,
       givenToday = true is reported back to the dashboard.
    6. Built-in web page at http://<esp32-ip>/ and /api/schedule
       for live monitoring & dashboard polling.
    7. Prints its own IP address on the LCD at startup so you can
       set ESP32_BASE_URL in dashboard-v2/.env.
  ============================================================================
*/

#include "esp_wifi.h"
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <LiquidCrystal_I2C.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Wire.h>
#include <time.h>

// ---------------------------------------------------------------------------
// USER CONFIG — edit these two values
// ---------------------------------------------------------------------------
const char *WIFI_SSID = "ElderCare";       // your Wi-Fi / hotspot SSID
const char *WIFI_PASSWORD = "ami bolbona"; // your Wi-Fi password

// Dashboard server address — set to your PC's local IP and port 5050.
// Leave empty ("") to run in standalone mode (schedule from flash memory).
const char *DASHBOARD_URL = "http://10.249.53.135:5050";
// ← change to your PC IP

// ---------------------------------------------------------------------------
// PIN DEFINITIONS  (matches diagnostic sketch exactly)
// ---------------------------------------------------------------------------
#define TRIG_PIN 5
#define ECHO_PIN 18
#define SERVO_PIN 13
#define SWITCH_PIN 4

const int LED_PIN[4] = {27, 26, 25, 33}; // Slot 1..4

// ---------------------------------------------------------------------------
// NTP / TIME
// ---------------------------------------------------------------------------
const long GMT_OFFSET_SEC = 19800; // IST = UTC+5:30
const int DAYLIGHT_OFFSET_SEC = 0;
const char *NTP_SERVER = "pool.ntp.org";

// ---------------------------------------------------------------------------
// TUNABLE CONSTANTS
// ---------------------------------------------------------------------------
const int SERVO_CLOSED = 0;
const int SERVO_OPEN = 90;
const float PRESENCE_THRESHOLD_CM = 15.0; // distance that triggers open
const unsigned long PENDING_TIMEOUT_MS = 30UL * 60UL * 1000UL; // 30 min
const unsigned long CONFIRM_TIMEOUT_MS = 10UL * 60UL * 1000UL; // 10 min
const unsigned long DEBOUNCE_MS = 50;
const unsigned long SENSOR_POLL_MS = 300;
const unsigned long SCHEDULE_FETCH_MS = 60000UL; // fetch schedule every 60 s

// ---------------------------------------------------------------------------
// SCHEDULE — populated from dashboard (or defaults if offline)
// ---------------------------------------------------------------------------
#define MAX_DOSES 10
struct Dose {
  int hour;
  int minute;
  int compartment; // 0-indexed → LED_PIN[compartment]
  char label[32];
  bool givenToday;
};

Dose schedule[MAX_DOSES] = {{8, 0, 0, "Vitamin D - 1 tab", false},
                            {13, 0, 1, "Amoxicillin - 2 tabs", false},
                            {18, 0, 2, "BP tab - 1 tab", false},
                            {21, 0, 3, "Night tab - 1 tab", false}};
int numDoses = 4;

// ---------------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------------
enum BoxState { IDLE, PENDING_PRESENCE, ACTIVE_DOSE };
BoxState state = IDLE;
int activeDoseIndex = -1;
unsigned long stateEnteredAt = 0;
unsigned long lastSensorPoll = 0;
unsigned long lastScheduleFetch = 0;

int lastSwitchReading = HIGH;
unsigned long lastDebounceTime = 0;
int lastDayChecked = -1;

// History log (last 10)
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

// ---------------------------------------------------------------------------
// FORWARD DECLARATIONS
// ---------------------------------------------------------------------------
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
void connectWiFi();
void syncTime();
void fetchScheduleFromDashboard();
void postGivenToday(int doseIndex);
void checkSchedule(struct tm &t);
void startPendingDose(int index);
void handlePendingPresence();
void openDose();
void handleActiveDose();
void checkSwitchPress();
void confirmDose();
void closeAndReset();
void resetToIdle();
void resetDailyFlagsIfNewDay(int day);
float readDistanceCM();
void addLog(String text);
void handleRoot();
void handleApiSchedule();
void handleApiGivenToday();
void handleTest();
void lcdPrint(const char *line0, const char *line1 = "");

// ===========================================================================
// SETUP
// ===========================================================================
void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.println(F("╔══════════════════════════════════════════════╗"));
  Serial.println(F("║   JEEVAN — Smart Medicine Box  (ESP32 v3)    ║"));
  Serial.println(F("╚══════════════════════════════════════════════╝"));

  // ── GPIO init ──────────────────────────────────────────────────
  pinMode(TRIG_PIN, OUTPUT);
  digitalWrite(TRIG_PIN, LOW);
  pinMode(ECHO_PIN, INPUT);
  pinMode(SWITCH_PIN, INPUT_PULLUP);
  for (int i = 0; i < 4; i++) {
    pinMode(LED_PIN[i], OUTPUT);
    digitalWrite(LED_PIN[i], LOW);
  }

  // ── Servo ──────────────────────────────────────────────────────
  lidServo.setPeriodHertz(50);
  lidServo.attach(SERVO_PIN, 500, 2400);
  lidServo.write(SERVO_CLOSED);

  // ── LCD ────────────────────────────────────────────────────────
  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcdPrint("JEEVAN MedBox", "Connecting...");

  // ── Wi-Fi (event-driven, same engine as bpm_bracelet) ─────────
  // IP will appear on LCD and Serial once connection succeeds.
  // NTP sync + schedule fetch happen automatically inside onWiFiEvent.
  connectWiFi();

  // Brief wait so the first WiFi events can fire before starting loop
  delay(1000);

  // ── Web server routes ──────────────────────────────────────────
  server.on("/", handleRoot);
  server.on("/api/schedule", HTTP_GET, handleApiSchedule);
  server.on("/api/schedule", HTTP_POST,
            handleApiSchedule); // dashboard writes here
  server.on("/api/giventoday", handleApiGivenToday);
  server.on("/test", handleTest);
  server.begin();

  lcdPrint("System Ready", WiFi.status() == WL_CONNECTED
                               ? WiFi.localIP().toString().c_str()
                               : "Offline Mode");
  addLog("System started");
}

// ===========================================================================
// MAIN LOOP
// ===========================================================================
void loop() {
  server.handleClient();

  struct tm timeinfo;
  if (!getLocalTime(&timeinfo))
    return; // NTP not ready yet

  resetDailyFlagsIfNewDay(timeinfo.tm_mday);

  // Refresh schedule from dashboard every 60 s (non-blocking)
  if (millis() - lastScheduleFetch >= SCHEDULE_FETCH_MS) {
    fetchScheduleFromDashboard();
    lastScheduleFetch = millis();
  }

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

// ===========================================================================
// SCHEDULE CHECK  (Window-based trigger: never misses a dose if clock rolls over)
// ===========================================================================
void checkSchedule(struct tm &t) {
  int currentMinOfDay = t.tm_hour * 60 + t.tm_min;

  for (int i = 0; i < numDoses; i++) {
    int doseMinOfDay = schedule[i].hour * 60 + schedule[i].minute;

    // Trigger if not given today, and current time has reached/passed dose time (within 30 min)
    if (!schedule[i].givenToday &&
        currentMinOfDay >= doseMinOfDay &&
        currentMinOfDay < (doseMinOfDay + 30)) {
      Serial.printf("[TRIGGER] Dose due! Slot %d (%s) scheduled %02d:%02d, current %02d:%02d\n",
                    schedule[i].compartment + 1, schedule[i].label,
                    schedule[i].hour, schedule[i].minute,
                    t.tm_hour, t.tm_min);
      startPendingDose(i);
      return;
    }
  }
}

void startPendingDose(int index) {
  activeDoseIndex = index;
  state = PENDING_PRESENCE;
  stateEnteredAt = millis();

  lcdPrint("Dose time!", "Approach box...");
  addLog(String("Dose scheduled: ") + schedule[index].label);
}

// ===========================================================================
// PENDING PRESENCE
// ===========================================================================
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
  lidServo.write(SERVO_OPEN);

  lcdPrint("Take medicine:", schedule[activeDoseIndex].label);
  addLog(String("Lid opened: ") + schedule[activeDoseIndex].label);
}

// ===========================================================================
// ACTIVE DOSE — waiting for switch press
// ===========================================================================
void handleActiveDose() {
  checkSwitchPress();

  if (millis() - stateEnteredAt >= CONFIRM_TIMEOUT_MS) {
    addLog(String("MISSED (no confirm): ") + schedule[activeDoseIndex].label);
    closeAndReset();
  }
}

void checkSwitchPress() {
  int reading = digitalRead(SWITCH_PIN);
  if (reading != lastSwitchReading)
    lastDebounceTime = millis();
  if ((millis() - lastDebounceTime) > DEBOUNCE_MS && reading == LOW) {
    confirmDose();
  }
  lastSwitchReading = reading;
}

void confirmDose() {
  addLog(String("CONFIRMED: ") + schedule[activeDoseIndex].label);
  lcdPrint("Confirmed!", "Thank you :)");
  postGivenToday(activeDoseIndex); // tell dashboard
  closeAndReset();
}

void closeAndReset() {
  int comp = schedule[activeDoseIndex].compartment;
  digitalWrite(LED_PIN[comp], LOW);
  lidServo.write(SERVO_CLOSED);
  schedule[activeDoseIndex].givenToday = true;
  resetToIdle();
}

void resetToIdle() {
  activeDoseIndex = -1;
  state = IDLE;
  delay(1500);
  if (WiFi.status() == WL_CONNECTED)
    lcdPrint("JEEVAN Ready", WiFi.localIP().toString().c_str());
  else
    lcdPrint("JEEVAN Ready", "Offline Mode");
}

// ===========================================================================
// DAILY RESET
// ===========================================================================
void resetDailyFlagsIfNewDay(int today) {
  if (lastDayChecked != today) {
    lastDayChecked = today;
    for (int i = 0; i < numDoses; i++)
      schedule[i].givenToday = false;
    addLog("Daily schedule reset");
  }
}

// ===========================================================================
// HC-SR04
// ===========================================================================
float readDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long dur = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (dur == 0)
    return -1;
  return dur * 0.0343f / 2.0f;
}

// ===========================================================================
// DASHBOARD API CALLS
// ===========================================================================

// GET /api/esp32/schedule  — fetch new schedule from Node.js server
void fetchScheduleFromDashboard() {
  if (WiFi.status() != WL_CONNECTED || strlen(DASHBOARD_URL) == 0)
    return;

  HTTPClient http;
  String url = String(DASHBOARD_URL) + "/api/esp32/schedule";
  http.begin(url);
  http.setTimeout(5000);
  int code = http.GET();

  if (code == 200) {
    String payload = http.getString();
    StaticJsonDocument<2048> doc;
    if (deserializeJson(doc, payload) == DeserializationError::Ok) {
      JsonArray arr = doc["schedule"].as<JsonArray>();
      if (arr && arr.size() > 0) {
        int n = 0;
        for (JsonObject entry : arr) {
          if (n >= MAX_DOSES) break;
          schedule[n].hour        = entry["hour"] | 8;
          schedule[n].minute      = entry["minute"] | 0;
          schedule[n].compartment = entry["compartment"] | n;
          const char *lbl         = entry["label"] | "Medicine";
          strncpy(schedule[n].label, lbl, 31);
          schedule[n].label[31] = '\0';
          schedule[n].givenToday  = entry["givenToday"] | false;
          n++;
        }
        numDoses = n;
        Serial.printf("[SCHEDULE] Loaded %d dose(s) from dashboard server.\n", numDoses);
      }
    }
  } else {
    Serial.printf("[SCHEDULE] Fetch failed (HTTP %d). Using last known schedule.\n", code);
  }
  http.end();
}

// POST /api/dose-taken — tell dashboard the patient confirmed a dose
void postGivenToday(int doseIndex) {
  if (WiFi.status() != WL_CONNECTED || strlen(DASHBOARD_URL) == 0)
    return;
  HTTPClient http;
  String url = String(DASHBOARD_URL) + "/api/dose-taken";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["compartment"] = schedule[doseIndex].compartment;
  doc["label"] = schedule[doseIndex].label;
  doc["hour"] = schedule[doseIndex].hour;
  doc["minute"] = schedule[doseIndex].minute;
  doc["takenAt"] = ""; // server will timestamp

  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  Serial.printf("[DOSE-TAKEN] POST -> %d\n", code);
  http.end();
}

// ===========================================================================
// WEB SERVER — routes that the dashboard polls
// ===========================================================================

// GET  /api/schedule  → returns current schedule as JSON (dashboard reads this)
// POST /api/schedule  → receives new schedule from dashboard (dashboard writes)
void handleApiSchedule() {
  if (server.method() == HTTP_POST) {
    // Dashboard pushing a new schedule
    String body = server.arg("plain");
    StaticJsonDocument<2048> doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      JsonArray arr = doc["schedule"].as<JsonArray>();
      if (arr) {
        int n = 0;
        for (JsonObject entry : arr) {
          if (n >= MAX_DOSES)
            break;
          schedule[n].hour = entry["hour"] | 8;
          schedule[n].minute = entry["minute"] | 0;
          schedule[n].compartment = entry["compartment"] | n;
          const char *lbl = entry["label"] | "Medicine";
          strncpy(schedule[n].label, lbl, 31);
          schedule[n].label[31] = '\0';
          schedule[n].givenToday = false; // reset on new prescription
          n++;
        }
        numDoses = n;
        Serial.printf("[API] Schedule updated via POST: %d entries.\n",
                      numDoses);
        server.send(200, "application/json", "{\"ok\":true}");
        return;
      }
    }
    server.send(400, "application/json", "{\"error\":\"Bad JSON\"}");
    return;
  }

  // GET — return current schedule
  String json = "{\"schedule\":[";
  for (int i = 0; i < numDoses; i++) {
    if (i > 0)
      json += ",";
    json += "{\"compartment\":" + String(schedule[i].compartment);
    json += ",\"hour\":" + String(schedule[i].hour);
    json += ",\"minute\":" + String(schedule[i].minute);
    json += ",\"label\":\"" + String(schedule[i].label) + "\"";
    json +=
        ",\"givenToday\":" + String(schedule[i].givenToday ? "true" : "false");
    json += "}";
  }
  json += "]}";
  server.send(200, "application/json", json);
}

// GET /api/giventoday — quick summary of what's been taken today
void handleApiGivenToday() {
  String json = "{\"today\":[";
  bool first = true;
  for (int i = 0; i < numDoses; i++) {
    if (schedule[i].givenToday) {
      if (!first)
        json += ",";
      json += "\"" + String(schedule[i].label) + "\"";
      first = false;
    }
  }
  json += "]}";
  server.send(200, "application/json", json);
}

// GET /test — trigger a test dose from a browser
void handleTest() {
  if (state == IDLE)
    startPendingDose(0);
  server.sendHeader("Location", "/");
  server.send(303);
}

// GET / — human-readable dashboard page
void handleRoot() {
  String h = "<html><head><meta http-equiv='refresh' content='10'>";
  h += "<style>body{font-family:sans-serif;max-width:500px;margin:30px auto;}";
  h += "h2{color:#2e7d32;}table{border-collapse:collapse;width:100%;}";
  h += "td,th{border:1px solid #ccc;padding:6px "
       "10px;}th{background:#e8f5e9;}</style></head><body>";
  h += "<h2>&#128138; JEEVAN Medicine Box</h2>";

  h += "<p><b>State:</b> ";
  if (state == IDLE)
    h += "Idle &#x2705;";
  else if (state == PENDING_PRESENCE)
    h += "Waiting for patient — <i>" + String(schedule[activeDoseIndex].label) +
         "</i>";
  else
    h += "Lid OPEN — <i>" + String(schedule[activeDoseIndex].label) + "</i>";
  h += "</p>";

  if (WiFi.status() == WL_CONNECTED)
    h += "<p><b>IP:</b> " + WiFi.localIP().toString() +
         " &nbsp;|&nbsp; <b>Dashboard:</b> " + String(DASHBOARD_URL) + "</p>";

  h += "<h3>Today's "
       "schedule</h3><table><tr><th>Slot</th><th>Time</th><th>Medicine</"
       "th><th>Status</th></tr>";
  for (int i = 0; i < numDoses; i++) {
    h += "<tr><td>" + String(schedule[i].compartment + 1) + "</td>";
    h += "<td>" + String(schedule[i].hour) + ":" +
         (schedule[i].minute < 10 ? "0" : "") + String(schedule[i].minute) +
         "</td>";
    h += "<td>" + String(schedule[i].label) + "</td>";
    h +=
        "<td>" +
        String(schedule[i].givenToday ? "&#x2705; Taken" : "&#x23F3; Pending") +
        "</td></tr>";
  }
  h += "</table>";

  h += "<h3>Recent activity</h3><ul>";
  for (int i = 0; i < historyCount; i++)
    h += "<li>" + history[i].text + "</li>";
  h += "</ul>";

  h += "<p><a href='/test'>&#9654; Trigger test dose now</a></p>";
  h += "<p><a href='/api/schedule'>&#128203; View schedule JSON</a></p>";
  h += "</body></html>";

  server.send(200, "text/html", h);
}

// ===========================================================================
// Wi-Fi Event Handler  (same engine as bpm_bracelet.ino)
// ===========================================================================
bool wifiOk = false;

void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
  case ARDUINO_EVENT_WIFI_STA_START:
    Serial.println(F("[WiFi] Station started. Scanning for network..."));
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    break;

  case ARDUINO_EVENT_WIFI_STA_CONNECTED:
    Serial.println(F("[WiFi] Associated with AP! Waiting for IP..."));
    lcdPrint("WiFi Associated", "Getting IP...");
    break;

  case ARDUINO_EVENT_WIFI_STA_GOT_IP: {
    wifiOk = true;
    String ip = WiFi.localIP().toString();
    Serial.printf("[WiFi] Connected! IP: %s | GW: %s\n",
                  ip.c_str(), WiFi.gatewayIP().toString().c_str());
    // Show IP on LCD (non-blocking)
    lcdPrint("IP address:", ip.c_str());
    // Sync NTP now that we have internet
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
    Serial.println("[NTP] Time sync started.");
    break;
  }

  case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
    wifiOk = false;
    Serial.printf("[WiFi] Disconnected (reason %d). Retrying...\n",
                  info.wifi_sta_disconnected.reason);
    lcdPrint("WiFi Lost", "Reconnecting...");
    break;

  default:
    break;
  }
}

// ===========================================================================
// Wi-Fi Init  (non-blocking — event-driven, smart SSID scan like bpm_bracelet)
// ===========================================================================
void connectWiFi() {
  // ── Step 1: scan all visible networks ──────────────────────────────────
  Serial.println(F("[WiFi] Scanning visible 2.4 GHz networks..."));
  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d network(s):\n", n);

  // ── Step 2: find the best-matching SSID (handles trailing spaces) ───────
  // Reason 201 = AP not found, Reason 36 = beacon timeout — both caused by
  // subtle SSID mismatches (e.g. "ElderCare " vs "ElderCare").
  String targetSSID = String(WIFI_SSID);   // default fallback
  int    bestRSSI   = -999;

  for (int i = 0; i < n; i++) {
    String found = WiFi.SSID(i);
    int    rssi  = WiFi.RSSI(i);

    Serial.printf("  %2d: '%s'  RSSI: %d  Ch: %d  Auth: %d\n",
                  i + 1, found.c_str(), rssi,
                  WiFi.channel(i), (int)WiFi.encryptionType(i));

    // Match: exact, with trailing space, or starts-with
    bool match = (found == WIFI_SSID) ||
                 (found == String(WIFI_SSID) + " ") ||
                 (found.startsWith(WIFI_SSID));

    if (match && rssi > bestRSSI) {
      bestRSSI   = rssi;
      targetSSID = found;   // use the exact on-air SSID string
      Serial.printf("      --> Best match so far: '%s' (RSSI %d)\n",
                    targetSSID.c_str(), rssi);
    }
  }

  // ── Step 3: connect using the exact scanned SSID ───────────────────────
  Serial.printf("[WiFi] Connecting to '%s' (password: '%s')...\n",
                targetSSID.c_str(), WIFI_PASSWORD);

  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(targetSSID.c_str(), WIFI_PASSWORD);
  // Result arrives via onWiFiEvent — no blocking loop needed
}

void syncTime() {
  // Called from onWiFiEvent when IP is assigned; also safe to call manually
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  Serial.println("[NTP] Time sync requested.");
}

// ===========================================================================
// LOGGING
// ===========================================================================
void addLog(String text) {
  struct tm t;
  String stamp = "";
  if (getLocalTime(&t)) {
    char buf[12];
    sprintf(buf, "%02d:%02d:%02d ", t.tm_hour, t.tm_min, t.tm_sec);
    stamp = buf;
  }
  for (int i = 9; i > 0; i--)
    history[i] = history[i - 1];
  history[0].text = stamp + text;
  if (historyCount < 10)
    historyCount++;
  Serial.println(stamp + text);
}

// ===========================================================================
// LCD HELPER
// ===========================================================================
void lcdPrint(const char *line0, const char *line1) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line0);
  if (line1 && strlen(line1) > 0) {
    lcd.setCursor(0, 1);
    lcd.print(line1);
  }
}
