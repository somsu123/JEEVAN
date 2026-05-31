#include <WiFi.h>
#include <time.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// --- WiFi Credentials ---
const char* ssid     = "ElderCare";
const char* password = "ami bolbona";

// --- Web Dashboard Settings ---
const char* serverIP  = "10.206.196.135"; // Change this to your PC's local IP address
const int serverPort  = 5050;            // Dashboard runs on port 5050

// --- NTP Time Settings ---
const char* ntpServer       = "pool.ntp.org";
const long  gmtOffset_sec   = 19800;  // IST: UTC+5:30
const int   daylightOffset_sec = 0;

// --- I2C Pins (ESP32-S3 explicit) ---
#define SDA_PIN 8
#define SCL_PIN 9

// --- OLED Setup ---
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool oledFound = false;

// --- Pin Declarations ---
const int TRIG_PIN   = 11;
const int ECHO_PIN   = 12;
const int SERVO_PIN  = 13;
const int TOUCH_PIN  = 4;
const int BUZZER_PIN = 15;
const int LED_PIN    = 16;

// --- Variables ---
int  nextHour          = 0;
int  nextMin           = 0;
int  activeHour        = -1;
int  activeMin         = -1;
int  medicineCount     = 0;
bool medicineTaken     = false;
bool isReminderActive  = false;
bool isBoxOpen         = false;
bool waitingToClose    = false;
bool ntpSynced         = false;
unsigned long doseConfirmedTime = 0;
String statusMsg = "BOOTING";

// --- Dashboard Schedule Variables ---
String nextMedicineName = "None";
String nextDosage       = "—";
int nextBoxNumber       = 1;

// --- Non-blocking Timers ---
unsigned long lastHeartbeatTime     = 0;
unsigned long lastScheduleFetchTime = 0;

Servo myServo;

// -------------------------------------------------
// Fetch dynamic schedule from the Web Dashboard (GET request)
void fetchDashboardSchedule() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Disconnected. Skipping schedule fetch.");
    return;
  }
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/medication/schedule?deviceId=medbox-01";
  Serial.print("[HTTP] Fetching schedule: ");
  Serial.println(url);
  
  http.begin(url);
  http.setTimeout(4000); 
  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    
    DynamicJsonDocument doc(2048);
    DeserializationError error = deserializeJson(doc, payload);
    
    if (!error) {
      JsonArray doses = doc["doses"].as<JsonArray>();
      
      bool foundNextDose = false;
      struct tm timeinfo;
      bool hasTime = getLocalTime(&timeinfo);
      int currentTotalMinutes = hasTime ? (timeinfo.tm_hour * 60 + timeinfo.tm_min) : 0;
      
      int bestDiff = 99999;
      JsonObject selectedDose;
      for (JsonObject dose : doses) {
        bool taken = dose["taken"] | false;
        bool missed = dose["missed"] | false;
        
        if (!taken && !missed) {
          const char* timeStr = dose["time"] | "08:00";
          int h = 0, m = 0;
          if (sscanf(timeStr, "%d:%d", &h, &m) == 2) {
            int doseTotalMinutes = h * 60 + m;
            int diff = doseTotalMinutes - currentTotalMinutes;
            if (diff < 0) {
              diff += 1440; 
            }
            if (diff < bestDiff) {
              bestDiff = diff;
              selectedDose = dose;
              foundNextDose = true;
            }
          }
        }
      }
      if (foundNextDose) {
        nextMedicineName = selectedDose["medicine"].as<String>();
        nextDosage       = selectedDose["dosage"].as<String>();
        nextBoxNumber    = selectedDose["boxNumber"] | 1;
        const char* tStr = selectedDose["time"] | "08:00";
        sscanf(tStr, "%d:%d", &nextHour, &nextMin);
        
        if (nextHour != activeHour || nextMin != activeMin) {
          activeHour = nextHour;
          activeMin = nextMin;
          medicineTaken = false;
          Serial.println("[SCHEDULE] New upcoming dose registered.");
        }
        
        Serial.printf("[SCHEDULE] Next Dose: %s (%s) at %02d:%02d in Box Compartment %d\n",
                      nextMedicineName.c_str(), nextDosage.c_str(), nextHour, nextMin, nextBoxNumber);
      } else {
        nextMedicineName = "All Done!";
        nextDosage       = "—";
        nextHour         = 0;
        nextMin          = 0;
        Serial.println("[SCHEDULE] No upcoming doses found.");
      }
    } else {
      Serial.printf("[JSON] Deserialization failed: %s\n", error.c_str());
    }
  } else {
    Serial.printf("[HTTP] GET failed, status code: %d\n", httpCode);
  }
  http.end();
}

// -------------------------------------------------
// Post dose Intake Events to the Web Dashboard (POST request)
void postDoseEvent(String eventType) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/hardware/medbox-event";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  struct tm timeinfo;
  char timeStr[9] = "00:00:00";
  if (getLocalTime(&timeinfo)) {
    snprintf(timeStr, sizeof(timeStr), "%02d:%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  }
  DynamicJsonDocument doc(512);
  doc["event"]     = eventType;
  doc["box"]       = nextBoxNumber;
  doc["medicine"]  = nextMedicineName;
  doc["dosage"]    = nextDosage;
  doc["timestamp"] = timeStr;
  doc["deviceId"]  = "medbox-01";
  String requestBody;
  serializeJson(doc, requestBody);
  int httpCode = http.POST(requestBody);
  Serial.printf("[EVENT] Posted event %s. Response: %d\n", eventType.c_str(), httpCode);
  http.end();
}

// -------------------------------------------------
// Send live status heartbeats to the Web Dashboard + listen for commands
void sendHeartbeat(int distance) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = "http://" + String(serverIP) + ":" + String(serverPort) + "/api/hardware/heartbeat";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  char nextDoseStr[6];
  snprintf(nextDoseStr, sizeof(nextDoseStr), "%02d:%02d", nextHour, nextMin);
  DynamicJsonDocument doc(256);
  doc["deviceId"]         = "medbox-01";
  doc["state"]            = statusMsg;
  doc["presenceDetected"] = (distance > 0 && distance < 30);
  doc["nextDoseTime"]     = nextDoseStr;
  doc["uptime"]           = millis() / 1000;
  doc["lidOpen"]          = isBoxOpen;
  String requestBody;
  serializeJson(doc, requestBody);
  int httpCode = http.POST(requestBody);
  if (httpCode == 200) {
    String response = http.getString();
    DynamicJsonDocument respDoc(256);
    if (!deserializeJson(respDoc, response)) {
      bool remoteOpen = respDoc["remoteOpen"] | false;
      if (remoteOpen && !isBoxOpen) {
        Serial.println("[COMMAND] Remote open triggered from Web Dashboard!");
        myServo.write(135);
        isBoxOpen = true;
        isReminderActive = true; 
        statusMsg = "REMOTE OPEN";
        
        // Sound a unique beep to alert user
        digitalWrite(BUZZER_PIN, HIGH);
        delay(300);
        digitalWrite(BUZZER_PIN, LOW);
      }
    }
  }
  http.end();
}

// -------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- Booting Smart MedBox ---");
  pinMode(TRIG_PIN,   OUTPUT);
  pinMode(ECHO_PIN,   INPUT);
  pinMode(TOUCH_PIN,  INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN,    OUTPUT);
  
  myServo.setPeriodHertz(50);           
  myServo.attach(SERVO_PIN, 500, 2400); 
  myServo.write(45);                    
  
  Wire.begin(SDA_PIN, SCL_PIN);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("[ERROR] SSD1306 OLED init failed! Continuing in Headless mode...");
    oledFound = false;
  } else {
    Serial.println("[OLED] Initialized SSD1306 Screen.");
    oledFound = true;
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("Connecting WiFi...");
    display.display();
  }
  
  WiFi.begin(ssid, password);
  Serial.print("Connecting WiFi");
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 15) {
    delay(500);
    Serial.print(".");
    retries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nWiFi Connected! IP: ");
    Serial.println(WiFi.localIP());
    configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
    statusMsg = "CONNECTING...";
  } else {
    Serial.println("\nWiFi connection failed! Running in offline mode.");
    statusMsg = "NO WIFI";
  }
}

// -------------------------------------------------
void loop() {
  // --- 1. Ultrasonic Distance Measurement ---
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 25000); 
  int distance  = (duration > 0) ? (duration * 0.034 / 2) : 999;
  
  // --- 2. Check local time (Non-blocking fallback) ---
  struct tm timeinfo;
  bool timeValid = getLocalTime(&timeinfo);
  if (timeValid && !ntpSynced) {
    Serial.println("[NTP] Time synchronized successfully!");
    ntpSynced = true;
    statusMsg = "IDLE";
    fetchDashboardSchedule();
  }
  
  // --- 3. Trigger Reminder at Scheduled Time (Only if Time Valid) ---
  if (timeValid &&
      timeinfo.tm_hour == nextHour &&
      timeinfo.tm_min  == nextMin  &&
      !medicineTaken               &&
      !isReminderActive) {
    isReminderActive = true;
    statusMsg = "PENDING";
    Serial.println("[REMINDER] It's time for your medication!");
  }
  
  // --- 4. Reminder Active Mode ---
  if (isReminderActive && !waitingToClose) {
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(LED_PIN,    HIGH);
    delay(100);
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN,    LOW);
    if (distance > 0 && distance < 30 && !isBoxOpen) {
      myServo.write(135);
      isBoxOpen = true;
      Serial.println("[SERVO] Hand detected. Opening Lid.");
    }
  }
  
  // --- 5. Touch Sensor Confirmation ---
  if (digitalRead(TOUCH_PIN) == HIGH &&
      isReminderActive               &&
      !waitingToClose) {
    isReminderActive = false;
    medicineTaken    = true;
    medicineCount++;
    statusMsg = "TAKEN";
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN,    LOW);
    postDoseEvent("DOSE_TAKEN");
    doseConfirmedTime = millis();
    waitingToClose    = true;
    Serial.printf("[SYSTEM] Dose #%d confirmed. Closing in 10s...\n", medicineCount);
  }
  
  // --- 6. Non-blocking Close Box Delay ---
  if (waitingToClose) {
    statusMsg = "CLOSING...";
    if (millis() - doseConfirmedTime >= 10000) {
      myServo.write(45); 
      isBoxOpen      = false;
      waitingToClose = false;
      statusMsg      = "IDLE";
      
      fetchDashboardSchedule();
      Serial.println("[SERVO] Box closed automatically.");
    }
  }
  
  // --- 7. Reset for Next Minute Cycle ---
  if (timeValid && !isReminderActive && !waitingToClose &&
      timeinfo.tm_min != nextMin) {
    medicineTaken = false;
  }
  
  // --- 8. Non-blocking Tasks ---
  unsigned long currentMillis = millis();
  // Poll schedule every 60 seconds
  if (currentMillis - lastScheduleFetchTime >= 60000) {
    lastScheduleFetchTime = currentMillis;
    fetchDashboardSchedule();
  }
  // Send status heartbeat every 10 seconds
  if (currentMillis - lastHeartbeatTime >= 10000) {
    lastHeartbeatTime = currentMillis;
    sendHeartbeat(distance);
  }
  
  // --- 9. OLED Render (Headless safe) ---
  if (oledFound) {
    display.clearDisplay();
    // Top row
    display.setTextSize(1);
    display.setCursor(0, 0);
    if (timeValid) {
      display.printf("%02d:%02d  Doses: %d", timeinfo.tm_hour, timeinfo.tm_min, medicineCount);
    } else {
      display.printf("OFFLINE   Doses: %d", medicineCount);
    }
    display.drawLine(0, 10, 128, 10, SSD1306_WHITE);
    
    // Status
    display.setTextSize(2);
    display.setCursor(0, 18);
    display.println(statusMsg);
    
    // Next dose info
    display.setTextSize(1);
    display.setCursor(0, 42);
    display.printf("Next: %s", nextMedicineName.c_str());
    display.setCursor(0, 52);
    display.printf("Time: %02d:%02d (%dcm)", nextHour, nextMin, distance == 999 ? 0 : distance);
    display.display();
  }
  delay(200);
}
