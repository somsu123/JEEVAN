/*
 * =================================================================================
 *  medicine_box.ino — 4-Compartment Smart Medicine Box Firmware (ESP32)
 * =================================================================================
 *  Hardware Connections (matching circuit diagram):
 *    • ESP32 DevKit V1
 *    • LCD 16x2 I2C Backpack: SDA -> GPIO 21, SCL -> GPIO 22, VCC -> 5V, GND -> GND
 *    • Lid Servo Motor: Signal -> GPIO 13, VCC -> 5V, GND -> GND
 *    • HC-SR04 Ultrasonic Distance Sensor: Trig -> GPIO 5, Echo -> GPIO 18 (via 1k/2k divider)
 *    • Compartment LEDs (4x): 
 *        - Compartment 0 (LED 1): GPIO 27 (+ 220Ω resistor)
 *        - Compartment 1 (LED 2): GPIO 26 (+ 220Ω resistor)
 *        - Compartment 2 (LED 3): GPIO 25 (+ 220Ω resistor)
 *        - Compartment 3 (LED 4): GPIO 33 (+ 220Ω resistor)
 *    • Confirm Push Switch: GPIO 4 (Active LOW with internal PULLUP, other leg to GND)
 * 
 *  API Endpoints (Port 80, CORS Enabled):
 *    • GET  /api/schedule   -> Returns 4 schedule entries with givenToday status
 *    • POST /api/schedule   -> Overwrites schedule in RAM & persists to NVS flash
 *    • GET  /status         -> Device telemetry (state, lid, distance, uptime, IP)
 *    • POST /api/test       -> Test servo open/close & LED flashing
 * =================================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include <time.h>

// ─────────────────────────────────────────────────────────────────────────────────
//  Hardware Configuration & Pin Definitions
// ─────────────────────────────────────────────────────────────────────────────────
#define HC_TRIG_PIN       5     // HC-SR04 Trigger Output
#define HC_ECHO_PIN       18    // HC-SR04 Echo Input (via 1k/2k resistor divider)
#define SERVO_PIN         13    // Lid Servo Control Signal Pin
#define CONFIRM_SW_PIN    4     // Confirm Push Switch (Pullup, LOW when pressed)

#define LED_COMP_0        27    // Compartment 1 LED Pin
#define LED_COMP_1        26    // Compartment 2 LED Pin
#define LED_COMP_2        25    // Compartment 3 LED Pin
#define LED_COMP_3        33    // Compartment 4 LED Pin

#define I2C_SDA_PIN       21    // LCD I2C SDA
#define I2C_SCL_PIN       22    // LCD I2C SCL

#define SERVO_CLOSED_ANGLE 0    // Servo angle for closed lid
#define SERVO_OPEN_ANGLE   90   // Servo angle for open lid
#define PRESENCE_DIST_CM   15   // Distance threshold (cm) for hand detection

// ─────────────────────────────────────────────────────────────────────────────────
//  WiFi & Network Configuration
// ─────────────────────────────────────────────────────────────────────────────────
const char* WIFI_SSID = "ElderCare";
const char* WIFI_PASS = "ami bolbona";

// NTP Server setup for real-time schedule checks
const char* NTP_SERVER = "pool.ntp.org";
const long  GMT_OFFSET_SEC = 19800; // GMT+5:30 (India Standard Time)
const int   DAYLIGHT_OFFSET_SEC = 0;

// ─────────────────────────────────────────────────────────────────────────────────
//  Data Structures & Objects
// ─────────────────────────────────────────────────────────────────────────────────
struct DoseEntry {
  int hour;          // 0 - 23
  int minute;        // 0 - 59
  int compartment;   // 0 - 3
  char label[24];    // Medicine name + dosage string
  bool givenToday;   // Dose completion flag
};

#define NUM_SLOTS 4
DoseEntry schedule[NUM_SLOTS] = {
  { 8,  0, 0, "Lisinopril 10mg", false },
  { 13, 0, 1, "Metformin 500mg", false },
  { 18, 0, 2, "Aspirin 81mg",    false },
  { 21, 0, 3, "Atorvastatin 20mg", false }
};

const int ledPins[NUM_SLOTS] = { LED_COMP_0, LED_COMP_1, LED_COMP_2, LED_COMP_3 };

enum SystemState {
  STATE_IDLE,
  STATE_DUE_REMINDER,
  STATE_LID_OPEN,
  STATE_CONFIRMED
};

SystemState currentState = STATE_IDLE;
int activeDoseIndex = -1;

WebServer server(80);
Preferences preferences;
LiquidCrystal_I2C lcd(0x27, 16, 2); // Default address 0x27 (or 0x3F)
Servo lidServo;

bool lidOpenState = false;
int currentDistanceCm = 999;
unsigned long stateTimerMs = 0;
unsigned long lastDisplayRefreshMs = 0;
int lastResetDay = -1;

// ─────────────────────────────────────────────────────────────────────────────────
//  Helper Functions
// ─────────────────────────────────────────────────────────────────────────────────

void setLidPosition(bool open) {
  if (open) {
    lidServo.write(SERVO_OPEN_ANGLE);
    lidOpenState = true;
  } else {
    lidServo.write(SERVO_CLOSED_ANGLE);
    lidOpenState = false;
  }
}

void setCompartmentLED(int compIndex, bool state) {
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (i == compIndex && state) {
      digitalWrite(ledPins[i], HIGH);
    } else if (compIndex < 0 && state) {
      digitalWrite(ledPins[i], HIGH); // All ON
    } else if (compIndex < 0 && !state) {
      digitalWrite(ledPins[i], LOW);  // All OFF
    } else if (i == compIndex && !state) {
      digitalWrite(ledPins[i], LOW);
    }
  }
}

int measureDistanceCm() {
  digitalWrite(HC_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(HC_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(HC_TRIG_PIN, LOW);

  long duration = pulseIn(HC_ECHO_PIN, HIGH, 25000); // 25ms timeout (~4m max)
  if (duration == 0) return 999;
  return (int)(duration * 0.0343 / 2.0);
}

void saveScheduleToNVS() {
  preferences.begin("med_schedule", false);
  for (int i = 0; i < NUM_SLOTS; i++) {
    char keyH[12], keyM[12], keyC[12], keyL[12], keyG[12];
    sprintf(keyH, "h_%d", i);
    sprintf(keyM, "m_%d", i);
    sprintf(keyC, "c_%d", i);
    sprintf(keyL, "l_%d", i);
    sprintf(keyG, "g_%d", i);

    preferences.putInt(keyH, schedule[i].hour);
    preferences.putInt(keyM, schedule[i].minute);
    preferences.putInt(keyC, schedule[i].compartment);
    preferences.putString(keyL, String(schedule[i].label));
    preferences.putBool(keyG, schedule[i].givenToday);
  }
  preferences.end();
  Serial.println("[NVS] Schedule saved to Flash memory.");
}

void loadScheduleFromNVS() {
  preferences.begin("med_schedule", true);
  for (int i = 0; i < NUM_SLOTS; i++) {
    char keyH[12], keyM[12], keyC[12], keyL[12], keyG[12];
    sprintf(keyH, "h_%d", i);
    sprintf(keyM, "m_%d", i);
    sprintf(keyC, "c_%d", i);
    sprintf(keyL, "l_%d", i);
    sprintf(keyG, "g_%d", i);

    if (preferences.isKey(keyH)) {
      schedule[i].hour = preferences.getInt(keyH, schedule[i].hour);
      schedule[i].minute = preferences.getInt(keyM, schedule[i].minute);
      schedule[i].compartment = preferences.getInt(keyC, schedule[i].compartment);
      String lbl = preferences.getString(keyL, String(schedule[i].label));
      lbl.toCharArray(schedule[i].label, sizeof(schedule[i].label));
      schedule[i].givenToday = preferences.getBool(keyG, false);
    }
  }
  preferences.end();
  Serial.println("[NVS] Schedule loaded from Flash memory.");
}

// Enable CORS headers on all HTTP responses
void sendCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─────────────────────────────────────────────────────────────────────────────────
//  HTTP REST Handlers
// ─────────────────────────────────────────────────────────────────────────────────

void handleOptions() {
  sendCORSHeaders();
  server.send(204);
}

void handleGetSchedule() {
  sendCORSHeaders();
  
  DynamicJsonDocument doc(1536);
  JsonArray arr = doc.createNestedArray("schedule");

  for (int i = 0; i < NUM_SLOTS; i++) {
    JsonObject obj = arr.createNestedObject();
    obj["hour"] = schedule[i].hour;
    obj["minute"] = schedule[i].minute;
    obj["compartment"] = schedule[i].compartment;
    obj["label"] = schedule[i].label;
    obj["givenToday"] = schedule[i].givenToday;
  }

  String jsonOut;
  serializeJson(doc, jsonOut);
  server.send(200, "application/json", jsonOut);
}

void handlePostSchedule() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server.arg("plain");
  DynamicJsonDocument doc(2048);
  DeserializationError err = deserializeJson(doc, body);

  if (err) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  JsonArray arr;
  if (doc.is<JsonArray>()) {
    arr = doc.as<JsonArray>();
  } else if (doc.containsKey("schedule")) {
    arr = doc["schedule"].as<JsonArray>();
  } else {
    server.send(400, "application/json", "{\"error\":\"No schedule array provided\"}");
    return;
  }

  int idx = 0;
  for (JsonObject obj : arr) {
    if (idx >= NUM_SLOTS) break;
    if (obj.containsKey("hour")) schedule[idx].hour = obj["hour"];
    if (obj.containsKey("minute")) schedule[idx].minute = obj["minute"];
    if (obj.containsKey("compartment")) schedule[idx].compartment = obj["compartment"];
    if (obj.containsKey("label")) {
      const char* lbl = obj["label"];
      strncpy(schedule[idx].label, lbl, sizeof(schedule[idx].label) - 1);
      schedule[idx].label[sizeof(schedule[idx].label) - 1] = '\0';
    }
    if (obj.containsKey("givenToday")) schedule[idx].givenToday = obj["givenToday"];
    idx++;
  }

  saveScheduleToNVS();
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Schedule updated & persisted\"}");
}

void handleStatus() {
  sendCORSHeaders();
  DynamicJsonDocument doc(512);

  doc["online"] = true;
  doc["deviceId"] = "medbox-01";
  doc["state"] = (currentState == STATE_IDLE) ? "IDLE" :
                 (currentState == STATE_DUE_REMINDER) ? "REMINDER" :
                 (currentState == STATE_LID_OPEN) ? "DISPENSING" : "CONFIRMED";
  doc["lidOpen"] = lidOpenState;
  doc["presenceDetected"] = (currentDistanceCm <= PRESENCE_DIST_CM);
  doc["distanceCm"] = currentDistanceCm;
  doc["uptime"] = millis() / 1000;
  doc["ip"] = WiFi.localIP().toString();

  String jsonOut;
  serializeJson(doc, jsonOut);
  server.send(200, "application/json", jsonOut);
}

void handleTest() {
  sendCORSHeaders();
  setLidPosition(true);
  setCompartmentLED(-1, true);
  delay(1500);
  setLidPosition(false);
  setCompartmentLED(-1, false);
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Test triggered\"}");
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Setup & Initialization
// ─────────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n==============================================");
  Serial.println("  Smart Medicine Box ESP32 Firmware Starting  ");
  Serial.println("==============================================");

  // Initialize Pin Modes
  pinMode(HC_TRIG_PIN, OUTPUT);
  pinMode(HC_ECHO_PIN, INPUT);
  pinMode(CONFIRM_SW_PIN, INPUT_PULLUP);

  for (int i = 0; i < NUM_SLOTS; i++) {
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW);
  }

  // Initialize Servo
  lidServo.setPeriodHertz(50);
  lidServo.attach(SERVO_PIN, 500, 2400);
  setLidPosition(false);

  // Initialize I2C & LCD
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("ElderCare MedBox");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi...");

  // Load schedule from flash NVS
  loadScheduleFromNVS();

  // Connect to WiFi with scan-based SSID matching
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  Serial.println(F("\n[WiFi] Scanning visible 2.4 GHz networks..."));
  int numNetworks = WiFi.scanNetworks();
  String targetSSID = WIFI_SSID;

  for (int i = 0; i < numNetworks; i++) {
    String foundStr = WiFi.SSID(i);
    Serial.printf("   %2d: '%s' (RSSI: %d dBm, Ch: %d)\n",
                  i + 1, foundStr.c_str(), WiFi.RSSI(i), WiFi.channel(i));
    if (foundStr == "ElderCare" || foundStr == "ElderCare " || foundStr.startsWith("ElderCare")) {
      targetSSID = foundStr;
      Serial.printf("      --> Match selected: '%s'\n", targetSSID.c_str());
      break;
    }
  }

  Serial.printf("[WiFi] Connecting to '%s'...\n", targetSSID.c_str());
  WiFi.begin(targetSSID.c_str(), WIFI_PASS);

  int timeout = 0;
  while (WiFi.status() != WL_CONNECTED && timeout < 30) {
    delay(500);
    Serial.print(".");
    timeout++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("\n[WiFi] Connected! IP: "));
    Serial.println(WiFi.localIP().toString());
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Connected!");
    lcd.setCursor(0, 1);
    lcd.print(WiFi.localIP().toString());

    // Configure NTP time sync
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  } else {
    Serial.println(F("\n[WiFi] Connection failed. Operating in local mode."));
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Offline");
    lcd.setCursor(0, 1);
    lcd.print("Local Mode");
  }

  delay(2000);

  // Setup HTTP API Endpoints
  server.on("/api/schedule", HTTP_GET, handleGetSchedule);
  server.on("/api/schedule", HTTP_POST, handlePostSchedule);
  server.on("/api/schedule", HTTP_OPTIONS, handleOptions);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/api/test", HTTP_POST, handleTest);
  server.on("/api/test", HTTP_OPTIONS, handleOptions);

  server.begin();
  Serial.println("[HTTP] WebServer started on port 80");
}

// ─────────────────────────────────────────────────────────────────────────────────
//  Main Loop & State Machine
// ─────────────────────────────────────────────────────────────────────────────────
void loop() {
  server.handleClient();
  currentDistanceCm = measureDistanceCm();
  bool confirmPressed = (digitalRead(CONFIRM_SW_PIN) == LOW);

  // Obtain local time
  struct tm timeinfo;
  bool timeValid = getLocalTime(&timeinfo);

  // Midnight reset check (reset givenToday flags every new day)
  if (timeValid && timeinfo.tm_mday != lastResetDay) {
    if (lastResetDay != -1) {
      Serial.println("[SYSTEM] New day detected! Resetting givenToday flags.");
      for (int i = 0; i < NUM_SLOTS; i++) {
        schedule[i].givenToday = false;
      }
      saveScheduleToNVS();
    }
    lastResetDay = timeinfo.tm_mday;
  }

  // State Machine logic
  switch (currentState) {

    case STATE_IDLE: {
      setLidPosition(false);
      setCompartmentLED(-1, false);

      // Check if any scheduled dose is due
      if (timeValid) {
        for (int i = 0; i < NUM_SLOTS; i++) {
          if (!schedule[i].givenToday &&
              timeinfo.tm_hour == schedule[i].hour &&
              timeinfo.tm_min >= schedule[i].minute) {
            
            activeDoseIndex = i;
            currentState = STATE_DUE_REMINDER;
            stateTimerMs = millis();
            Serial.printf("[STATE] Dose due for slot %d (%s)\n", i, schedule[i].label);
            break;
          }
        }
      }

      // LCD Display Update for IDLE
      if (millis() - lastDisplayRefreshMs > 2000) {
        lastDisplayRefreshMs = millis();
        lcd.clear();
        lcd.setCursor(0, 0);
        if (timeValid) {
          char timeStr[16];
          sprintf(timeStr, "Time: %02d:%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
          lcd.print(timeStr);
        } else {
          lcd.print("ElderCare MedBox");
        }

        lcd.setCursor(0, 1);
        if (WiFi.status() == WL_CONNECTED) {
          lcd.print(WiFi.localIP().toString());
        } else {
          lcd.print("Ready / Standby");
        }
      }
      break;
    }

    case STATE_DUE_REMINDER: {
      // Flash the compartment LED for active dose
      if (activeDoseIndex >= 0) {
        bool flash = (millis() / 500) % 2;
        setCompartmentLED(activeDoseIndex, flash);
      }

      // LCD Display for Reminder
      if (millis() - lastDisplayRefreshMs > 500) {
        lastDisplayRefreshMs = millis();
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("TIME FOR MEDS!");
        lcd.setCursor(0, 1);
        if (activeDoseIndex >= 0) {
          lcd.print(schedule[activeDoseIndex].label);
        }
      }

      // Hand presence detection opens the lid
      if (currentDistanceCm <= PRESENCE_DIST_CM) {
        setLidPosition(true);
        currentState = STATE_LID_OPEN;
        stateTimerMs = millis();
        Serial.println("[STATE] Hand detected! Opening lid.");
      }
      break;
    }

    case STATE_LID_OPEN: {
      // Solid LED for active compartment
      if (activeDoseIndex >= 0) {
        setCompartmentLED(activeDoseIndex, true);
      }

      // LCD Display while lid is open
      if (millis() - lastDisplayRefreshMs > 1000) {
        lastDisplayRefreshMs = millis();
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("TAKE DOSE & PRESS");
        lcd.setCursor(0, 1);
        lcd.print("CONFIRM BUTTON");
      }

      // Patient presses confirm button
      if (confirmPressed) {
        if (activeDoseIndex >= 0) {
          schedule[activeDoseIndex].givenToday = true;
          saveScheduleToNVS();
        }
        setLidPosition(false);
        setCompartmentLED(-1, false);
        currentState = STATE_CONFIRMED;
        stateTimerMs = millis();
        Serial.println("[STATE] Dose confirmed taken!");
      }
      break;
    }

    case STATE_CONFIRMED: {
      if (millis() - lastDisplayRefreshMs > 1000) {
        lastDisplayRefreshMs = millis();
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("DOSE RECORDED!");
        lcd.setCursor(0, 1);
        lcd.print("THANK YOU");
      }

      // Hold message for 3 seconds then return to IDLE
      if (millis() - stateTimerMs > 3000) {
        activeDoseIndex = -1;
        currentState = STATE_IDLE;
      }
      break;
    }
  }

  delay(50);
}