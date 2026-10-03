/*
  JEEVAN Wearable Fall Detector - ESP32 Firmware
  Corrected Logic & Edge-Case Guardrails
*/

#include <Wire.h>
#include <math.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>

#define USE_BACKEND   1
#define USE_TELEGRAM  0

#define WIFI_SSID    "ElderCare"
#define WIFI_PASS    "ami bolbona"
#define BACKEND_URL  "http://192.168.1.50:5000/api/fall"

#define SDA_PIN      21
#define SCL_PIN      22
#define MPU_ADDR     0x68
#define BUZZER_PIN   25
#define BUTTON_PIN   27

// Reassigned to GPIO4/GPIO2 for safety across all ESP32 variants
#define GPS_RX_PIN   4   
#define GPS_TX_PIN   2   

HardwareSerial GPSSerial(2);
TinyGPSPlus gps;

#define FREEFALL_G         0.75
#define IMPACT_G           3.00
#define TILT_ANGLE         35.0
#define STILL_MOTION_DPS   25.0  // Relaxed slightly to handle minor body tremors
#define STILL_TIME_MS      5000
#define SAMPLE_INTERVAL    20
#define IMPACT_TIMEOUT_MS  15000
#define CANCEL_WINDOW_MS   10000
#define SOS_COOLDOWN_MS    5000

#define ACCEL_LSB_PER_G    4096.0
#define GYRO_LSB_PER_DPS   131.0

enum State { NORMAL, FREE_FALL, IMPACT, FALL_CONFIRMED };
State state = NORMAL;

unsigned long freeFallStart = 0, impactStart = 0, stillStart = 0, lastSample = 0;
unsigned long confirmStart = 0, lastSOS = 0, lastWifiTry = 0, lastGpsUpdate = 0;
float refPitch = 0, refRoll = 0;
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
bool alertSent = false;
double lastLat = 0, lastLng = 0;

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  initMPU();
  delay(100);
  
  calibrateGyro();
  captureReference();

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  unsigned long now = millis();

  while (GPSSerial.available()) {
    gps.encode(GPSSerial.read());
  }

  if (gps.location.isValid() && gps.location.isUpdated()) {
    lastLat = gps.location.lat();
    lastLng = gps.location.lng();
    lastGpsUpdate = now;
  }

  // WiFi Reconnection non-blocking check
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 10000) {
    lastWifiTry = now;
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  // Button handler
  if (buttonPressed()) {
    if (state == FALL_CONFIRMED && !alertSent) {
      Serial.println("Fall alert cancelled by user");
      resetToNormal();
    } else if (now - lastSOS > SOS_COOLDOWN_MS) {
      lastSOS = now;
      soundBuzzer(true);
      sendAlert("sos", "MANUAL DISTRESS BUTTON");
      delay(1500);
      soundBuzzer(false);
    }
  }

  if (now - lastSample >= SAMPLE_INTERVAL) {
    lastSample = now;
    runDetection(now);
  }
}

void runDetection(unsigned long now) {
  float ax, ay, az, gx, gy, gz;
  if (!readMPU(ax, ay, az, gx, gy, gz)) return;

  float accel = sqrt(ax * ax + ay * ay + az * az);
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  float roll  = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
  float motionDps = fabs(gx) + fabs(gy) + fabs(gz);

  switch (state) {
    case NORMAL:
      if (accel < FREEFALL_G) {
        state = FREE_FALL;
        freeFallStart = now;
      }
      break;

    case FREE_FALL:
      if (accel > IMPACT_G) {
        state = IMPACT;
        impactStart = now;
        stillStart = 0;
      } else if (now - freeFallStart > 700) {
        state = NORMAL;
      }
      break;

    case IMPACT:
      if (now - impactStart < 150) return; // Reduced settling wait time

      if (now - impactStart > IMPACT_TIMEOUT_MS) {
        state = NORMAL;
        break;
      }

      if (fabs(pitch - refPitch) > TILT_ANGLE || fabs(roll - refRoll) > TILT_ANGLE) {
        if (motionDps < STILL_MOTION_DPS) {
          if (stillStart == 0) stillStart = now;
          if (now - stillStart > STILL_TIME_MS) {
            state = FALL_CONFIRMED;
            confirmStart = now;
            alertSent = false;
            soundBuzzer(true);
          }
        } else {
          stillStart = 0;
        }
      } else {
        state = NORMAL;
      }
      break;

    case FALL_CONFIRMED:
      if (!alertSent) {
        if (motionDps > 60.0) {
          resetToNormal();
        } else if (now - confirmStart > CANCEL_WINDOW_MS) {
          sendAlert("fall", "FALL DETECTED");
          alertSent = true;
          soundBuzzer(false); // Turn off continuous buzzer after sending alert
        }
      } else if (motionDps > 60.0) {
        resetToNormal();
      }
      break;
  }
}

void resetToNormal() {
  state = NORMAL;
  alertSent = false;
  stillStart = 0;
  soundBuzzer(false);
}

void writeMPU(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

void initMPU() {
  writeMPU(0x6B, 0x00); // Wake up
  writeMPU(0x1A, 0x03); // DLPF ~44Hz
  writeMPU(0x1B, 0x00); // Gyro +/-250 dps
  writeMPU(0x1C, 0x10); // Accel +/-8g
}

bool readMPU(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, 14) != 14) return false;

  int16_t rawAx = Wire.read() << 8 | Wire.read();
  int16_t rawAy = Wire.read() << 8 | Wire.read();
  int16_t rawAz = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read();
  int16_t rawGx = Wire.read() << 8 | Wire.read();
  int16_t rawGy = Wire.read() << 8 | Wire.read();
  int16_t rawGz = Wire.read() << 8 | Wire.read();

  ax = rawAx / ACCEL_LSB_PER_G;
  ay = rawAy / ACCEL_LSB_PER_G;
  az = rawAz / ACCEL_LSB_PER_G;
  gx = (rawGx - gyroBiasX) / GYRO_LSB_PER_DPS;
  gy = (rawGy - gyroBiasY) / GYRO_LSB_PER_DPS;
  gz = (rawGz - gyroBiasZ) / GYRO_LSB_PER_DPS;
  return true;
}

void calibrateGyro() {
  long sx = 0, sy = 0, sz = 0;
  int n = 0;
  for (int i = 0; i < 200; i++) {
    Wire.beginTransmission(MPU_ADDR);
    Wire.write(0x43);
    if (Wire.endTransmission(false) != 0) continue;
    if (Wire.requestFrom(MPU_ADDR, 6) != 6) continue;
    sx += (int16_t)(Wire.read() << 8 | Wire.read());
    sy += (int16_t)(Wire.read() << 8 | Wire.read());
    sz += (int16_t)(Wire.read() << 8 | Wire.read());
    n++;
    delay(5);
  }
  if (n > 0) {
    gyroBiasX = sx / (float)n;
    gyroBiasY = sy / (float)n;
    gyroBiasZ = sz / (float)n;
  }
}

void captureReference() {
  float sumP = 0, sumR = 0;
  int count = 0;
  for (int i = 0; i < 50; i++) {
    float ax, ay, az, gx, gy, gz;
    if (readMPU(ax, ay, az, gx, gy, gz)) {
      sumP += atan2(ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
      sumR += atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
      count++;
    }
    delay(20);
  }
  if (count > 0) {
    refPitch = sumP / count;
    refRoll = sumR / count;
  }
}

bool buttonPressed() {
  static bool lastStable = HIGH;
  static bool lastRead = HIGH;
  static unsigned long changeTime = 0;

  bool r = digitalRead(BUTTON_PIN);
  if (r != lastRead) { lastRead = r; changeTime = millis(); }
  if (millis() - changeTime > 50 && r != lastStable) {
    lastStable = r;
    if (lastStable == LOW) return true;
  }
  return false;
}

void soundBuzzer(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void sendAlert(const char* type, const char* reason) {
  bool haveFix = (millis() - lastGpsUpdate < 10000);

  String mapsUrl = haveFix
    ? "https://maps.google.com/?q=" + String(lastLat, 6) + "," + String(lastLng, 6)
    : "";

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected - Alert failed!");
    return;
  }

#if USE_BACKEND
  {
    String json = "{\"type\":\"" + String(type) + "\","
                  "\"reason\":\"" + String(reason) + "\","
                  "\"has_fix\":" + String(haveFix ? "true" : "false");
    if (haveFix)
      json += ",\"lat\":" + String(lastLat, 6) + ",\"lng\":" + String(lastLng, 6) +
              ",\"maps_url\":\"" + mapsUrl + "\"";
    json += "}";

    HTTPClient http;
    http.begin(BACKEND_URL);
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(5000);
    int code = http.POST(json);
    http.end();
  }
#endif
}
