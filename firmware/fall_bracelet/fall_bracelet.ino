/*
 * =================================================================================
 *  fall_bracelet.ino — JEEVAN Wearable Fall Detector (ESP32 + MPU-6050)
 *  PRODUCTION FIRMWARE: Pure ESP32 + MPU-6050 Fall Detection with Heavy-Fall
 * Buzzer
 * =================================================================================
 *
 *  Hardware Specifications:
 *    • Microcontroller: ESP32 Dev Module (2.4 GHz Wi-Fi)
 *    • IMU Sensor: MPU-6050 6-Axis Motion Sensor (I2C: SDA=21, SCL=22,
 * Addr=0x68) • Alarm Buzzer: Active Piezo Buzzer (GPIO 25) • Status Indicator:
 * Built-in LED (GPIO 2) • Optional Reset/SOS Button: Push Button (GPIO 27 with
 * INPUT_PULLUP)
 *
 *  Multi-Stage Fall Detection Physics Algorithm:
 *    1. Free-Fall Phase: Total acceleration drops below 0.60g (duration:
 * 50–600ms).
 *    2. Heavy Impact Phase: Total acceleration spikes above 3.00g with high
 * angular velocity (> 150°/s).
 *    3. Orientation & Tilt Check: Significant posture tilt change (> 35°)
 * relative to reference.
 *    4. Stillness / Immobility Check: Lack of recovery movement (< 30°/s)
 * for 2.5 seconds.
 *    5. Heavy Fall Alarm: Loud non-blocking buzzer alarm pulses on GPIO 25,
 *       and emergency fall telemetry is posted immediately to the JEEVAN
 * Dashboard.
 * =================================================================================
 */

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <Wire.h>
#include <math.h>

// ─────────────────────────────────────────────────────────────────────────────────
//  1. CONFIGURATION & PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────────
#define DEFAULT_WIFI_SSID "ElderCare"
#define WIFI_PASS "ami bolbona"

// Central Dashboard & Backend Endpoints
#define DASHBOARD_HOST "10.122.37.135"
#define DASHBOARD_PORT 5050
#define FLASK_PORT 5000
#define DEVICE_ID "bracelet-01"

// Pin Configuration
#define SDA_PIN 21    // I2C SDA
#define SCL_PIN 22    // I2C SCL
#define MPU_ADDR 0x68 // MPU-6050 I2C Address (AD0 = GND)

#define BUZZER_PIN 25    // Active Piezo Buzzer Pin (Loud Heavy-Fall Alarm)
#define STATUS_LED_PIN 2 // Onboard Status LED
#define BUTTON_PIN 27    // Optional Cancel / SOS Button (INPUT_PULLUP)

// Fall Detection Physical Thresholds
#define FREEFALL_G_THRESHOLD 0.60f // Drop below 0.60g indicates free fall
#define IMPACT_G_THRESHOLD 3.00f   // Spike above 3.00g indicates high impact
#define TILT_ANGLE_THRESHOLD 35.0f // Orientation change > 35 degrees
#define STILL_MOTION_DPS 30.0f  // Angular motion < 30°/s indicates immobility
#define STILL_DURATION_MS 2500  // Immobility duration required to confirm fall
#define ALARM_DURATION_MS 20000 // Buzzer alarm active duration (20 seconds)

// Sampling & Network Timing (ms)
#define SAMPLE_INTERVAL_MS 20      // 50 Hz IMU Sampling Rate
#define HEARTBEAT_INTERVAL_MS 5000 // 5s Heartbeat to Dashboard

// MPU-6050 Sensitivity Constants (±8g, ±250°/s)
#define ACCEL_SCALE_FACTOR 4096.0f // LSB per g for ±8g range
#define GYRO_SCALE_FACTOR 131.0f   // LSB per °/s for ±250°/s range

// ─────────────────────────────────────────────────────────────────────────────────
//  2. GLOBAL STATE VARIABLES
// ─────────────────────────────────────────────────────────────────────────────────
enum FallState {
  STATE_NORMAL,
  STATE_FREEFALL,
  STATE_IMPACT,
  STATE_STILLNESS_CHECK,
  STATE_FALL_CONFIRMED
};

FallState currentState = STATE_NORMAL;

// Timing Markers
unsigned long lastSampleMs = 0;
unsigned long freeFallStartMs = 0;
unsigned long impactStartMs = 0;
unsigned long stillStartMs = 0;
unsigned long alarmStartMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWiFiRetryMs = 0;
unsigned long lastBuzzerToggleMs = 0;

// Sensor Reference and Calibration
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
float refPitch = 0, refRoll = 0;
float peakImpactG = 0;
bool mpuReady = false;
bool wifiConnected = false;
bool buzzerPhysicalState = false;
bool alertDispatched = false;
String activeSSID = DEFAULT_WIFI_SSID;

// ─────────────────────────────────────────────────────────────────────────────────
//  3. MPU-6050 I2C LOW-LEVEL DRIVER
// ─────────────────────────────────────────────────────────────────────────────────
void writeMPURegister(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool initMPU6050() {
  Wire.beginTransmission(MPU_ADDR);
  byte error = Wire.endTransmission();
  if (error != 0) {
    Serial.printf("[MPU6050] ❌ Sensor not found at 0x%02X! (Error %d)\n",
                  MPU_ADDR, error);
    return false;
  }

  // 1. Wake up MPU-6050 (clear SLEEP bit in PWR_MGMT_1)
  writeMPURegister(0x6B, 0x00);
  delay(10);

  // 2. Set Clock Source to X-Gyro PLL for high stability
  writeMPURegister(0x6B, 0x01);

  // 3. Configure Digital Low Pass Filter (DLPF ~ 44 Hz)
  writeMPURegister(0x1A, 0x03);

  // 4. Configure Gyroscope Full Scale Range: ±250 °/s
  writeMPURegister(0x1B, 0x00);

  // 5. Configure Accelerometer Full Scale Range: ±8g
  writeMPURegister(0x1C, 0x10);

  Serial.println(F("[MPU6050] ✅ MPU-6050 6-Axis IMU Initialized (±8g, "
                   "±250°/s, DLPF 44Hz)"));
  return true;
}

bool readMPU6050(float &ax, float &ay, float &az, float &gx, float &gy,
                 float &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B); // Starting register for Accel X
  if (Wire.endTransmission(false) != 0)
    return false;

  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14) != 14)
    return false;

  int16_t rawAx = (Wire.read() << 8) | Wire.read();
  int16_t rawAy = (Wire.read() << 8) | Wire.read();
  int16_t rawAz = (Wire.read() << 8) | Wire.read();
  Wire.read();
  Wire.read(); // Skip Temperature registers (0x41, 0x42)
  int16_t rawGx = (Wire.read() << 8) | Wire.read();
  int16_t rawGy = (Wire.read() << 8) | Wire.read();
  int16_t rawGz = (Wire.read() << 8) | Wire.read();

  // Convert to physical units
  ax = (float)rawAx / ACCEL_SCALE_FACTOR;
  ay = (float)rawAy / ACCEL_SCALE_FACTOR;
  az = (float)rawAz / ACCEL_SCALE_FACTOR;

  gx = ((float)rawGx - gyroBiasX) / GYRO_SCALE_FACTOR;
  gy = ((float)rawGy - gyroBiasY) / GYRO_SCALE_FACTOR;
  gz = ((float)rawGz - gyroBiasZ) / GYRO_SCALE_FACTOR;

  return true;
}

void calibrateSensors() {
  Serial.println(F("[CALIBRATION] Calibrating MPU-6050 gyro bias & posture "
                   "reference. Keep device still..."));
  long sumGx = 0, sumGy = 0, sumGz = 0;
  float sumPitch = 0, sumRoll = 0;
  int validSamples = 0;

  for (int i = 0; i < 200; i++) {
    Wire.beginTransmission(MPU_ADDR);
    Wire.write(0x3B);
    if (Wire.endTransmission(false) == 0 &&
        Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14) == 14) {
      int16_t rawAx = (Wire.read() << 8) | Wire.read();
      int16_t rawAy = (Wire.read() << 8) | Wire.read();
      int16_t rawAz = (Wire.read() << 8) | Wire.read();
      Wire.read();
      Wire.read();
      int16_t rawGx = (Wire.read() << 8) | Wire.read();
      int16_t rawGy = (Wire.read() << 8) | Wire.read();
      int16_t rawGz = (Wire.read() << 8) | Wire.read();

      sumGx += rawGx;
      sumGy += rawGy;
      sumGz += rawGz;

      float ax = (float)rawAx / ACCEL_SCALE_FACTOR;
      float ay = (float)rawAy / ACCEL_SCALE_FACTOR;
      float az = (float)rawAz / ACCEL_SCALE_FACTOR;

      sumPitch += atan2(ax, sqrt(ay * ay + az * az)) * 180.0f / M_PI;
      sumRoll += atan2(ay, sqrt(ax * ax + az * az)) * 180.0f / M_PI;
      validSamples++;
    }
    delay(5);
  }

  if (validSamples > 0) {
    gyroBiasX = (float)sumGx / validSamples;
    gyroBiasY = (float)sumGy / validSamples;
    gyroBiasZ = (float)sumGz / validSamples;
    refPitch = sumPitch / validSamples;
    refRoll = sumRoll / validSamples;

    Serial.printf("[CALIBRATION] ✅ Complete! Gyro Biases -> X: %.1f, Y: %.1f, "
                  "Z: %.1f | Posture Pitch: %.1f°, Roll: %.1f°\n",
                  gyroBiasX, gyroBiasY, gyroBiasZ, refPitch, refRoll);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  4. BUZZER & ALERT ENGINE
// ─────────────────────────────────────────────────────────────────────────────────
void setBuzzer(bool on) {
  buzzerPhysicalState = on;
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void triggerBeep(int durationMs) {
  setBuzzer(true);
  delay(durationMs);
  setBuzzer(false);
}

void updateAlarmBuzzer() {
  if (currentState != STATE_FALL_CONFIRMED) {
    if (buzzerPhysicalState)
      setBuzzer(false);
    return;
  }

  unsigned long now = millis();

  // Rapid High-Impact Emergency Pulse: 150ms ON, 100ms OFF
  if (buzzerPhysicalState && (now - lastBuzzerToggleMs >= 150)) {
    setBuzzer(false);
    digitalWrite(STATUS_LED_PIN, LOW);
    lastBuzzerToggleMs = now;
  } else if (!buzzerPhysicalState && (now - lastBuzzerToggleMs >= 100)) {
    setBuzzer(true);
    digitalWrite(STATUS_LED_PIN, HIGH);
    lastBuzzerToggleMs = now;
  }

  // Auto-silence alarm after duration
  if (now - alarmStartMs >= ALARM_DURATION_MS) {
    Serial.println(F("[ALARM] ⏱️ Alarm buzzer auto-silenced after 20 seconds."));
    resetToNormal();
  }
}

void resetToNormal() {
  currentState = STATE_NORMAL;
  setBuzzer(false);
  digitalWrite(STATUS_LED_PIN, wifiConnected ? HIGH : LOW);
  alertDispatched = false;
  stillStartMs = 0;
  peakImpactG = 0;
  Serial.println(F("[STATE] 🔄 System reset to STATE_NORMAL."));
}

// ─────────────────────────────────────────────────────────────────────────────────
//  5. NETWORK TELEMETRY & FALL DISPATCH
// ─────────────────────────────────────────────────────────────────────────────────
void sendFallAlertToDashboard(float impactG, float tiltAngle) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    Serial.println(
        F("[ALERT] ⚠️ Cannot send fall alert — Wi-Fi not connected!"));
    return;
  }

  WiFiClient client;
  HTTPClient http;

  // 1. Post Fall Event to Dashboard (Port 5050)
  char dashUrl[96];
  snprintf(dashUrl, sizeof(dashUrl), "http://%s:%d/api/fall-event",
           DASHBOARD_HOST, DASHBOARD_PORT);

  if (http.begin(client, dashUrl)) {
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(2500);

    String payload = "{";
    payload += "\"source\":\"bracelet\",";
    payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
    payload += "\"confidence\":0.95,";
    payload += "\"location\":\"Wearable Bracelet (MPU6050)\",";
    payload += "\"impactG\":" + String(impactG, 2) + ",";
    payload += "\"tiltAngle\":" + String(tiltAngle, 1) + ",";
    payload += "\"is_fall\":true";
    payload += "}";

    Serial.printf("[ALERT] 🚨 Posting Critical Fall Alert to %s...\n", dashUrl);
    int httpCode = http.POST(payload);
    if (httpCode == 200 || httpCode == 201) {
      Serial.println(
          F("[ALERT] ✅ Fall alert successfully acknowledged by Dashboard!"));
    } else {
      Serial.printf("[ALERT] ⚠️ Dashboard returned HTTP %d\n", httpCode);
    }
    http.end();
  }

  // 2. Post Fall Event to Flask Backend (Port 5000)
  char flaskUrl[96];
  snprintf(flaskUrl, sizeof(flaskUrl), "http://%s:%d/api/fall", DASHBOARD_HOST,
           FLASK_PORT);

  if (http.begin(client, flaskUrl)) {
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(2500);

    String payload = "{";
    payload += "\"source\":\"bracelet\",";
    payload += "\"is_fall\":true,";
    payload += "\"confidence\":0.95,";
    payload += "\"reason\":\"High Impact Fall (" + String(impactG, 2) + "g)\"";
    payload += "}";

    http.POST(payload);
    http.end();
  }
}

void sendHeartbeat() {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED)
    return;

  WiFiClient client;
  HTTPClient http;

  char url[96];
  snprintf(url, sizeof(url), "http://%s:%d/api/bracelet/heartbeat",
           DASHBOARD_HOST, DASHBOARD_PORT);

  if (!http.begin(client, url))
    return;

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(1500);

  const char *phaseStr = "IDLE";
  if (currentState == STATE_FREEFALL)
    phaseStr = "FREE_FALL";
  else if (currentState == STATE_IMPACT)
    phaseStr = "IMPACT";
  else if (currentState == STATE_STILLNESS_CHECK)
    phaseStr = "STILLNESS";
  else if (currentState == STATE_FALL_CONFIRMED)
    phaseStr = "FALL_CONFIRMED";

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"fallPhase\":\"" + String(phaseStr) + "\",";
  payload += "\"uptime\":" + String(millis() / 1000);
  payload += "}";

  http.POST(payload);
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────────
//  6. BULLETPROOF WI-FI MANAGER
// ─────────────────────────────────────────────────────────────────────────────────
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.setAutoReconnect(true);

  Serial.println(F("\n[WiFi] Scanning for 2.4GHz Wi-Fi networks..."));
  int n = WiFi.scanNetworks();
  bool matched = false;
  for (int i = 0; i < n; ++i) {
    String found = WiFi.SSID(i);
    if (!matched && (found == "ElderCare" || found == "ElderCare " ||
                     found.startsWith("ElderCare"))) {
      activeSSID = found;
      matched = true;
      Serial.printf("[WiFi] >>> Matched Hotspot: '%s' <<<\n",
                    activeSSID.c_str());
    }
  }

  Serial.printf("[WiFi] Connecting to '%s'...\n", activeSSID.c_str());
  WiFi.begin(activeSSID.c_str(), WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(400);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("\n[WiFi] ✅ Connected! IP: %s\n",
                  WiFi.localIP().toString().c_str());
  } else {
    wifiConnected = false;
    digitalWrite(STATUS_LED_PIN, LOW);
    Serial.println(
        F("\n[WiFi] ⚠️ Initial connection timed out. Background retry active."));
  }
}

void maintainWiFi() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      wifiConnected = false;
      digitalWrite(STATUS_LED_PIN, LOW);
      Serial.println(F("[WiFi] ⚠️ Wi-Fi disconnected! Retrying..."));
    }
    if (now - lastWiFiRetryMs >= 10000) {
      lastWiFiRetryMs = now;
      WiFi.reconnect();
    }
  } else if (!wifiConnected) {
    wifiConnected = true;
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("[WiFi] ✅ Reconnected! IP: %s\n",
                  WiFi.localIP().toString().c_str());
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  7. PHYSICS FALL DETECTION ALGORITHM
// ─────────────────────────────────────────────────────────────────────────────────
void runFallDetection(unsigned long now) {
  float ax, ay, az, gx, gy, gz;
  if (!readMPU6050(ax, ay, az, gx, gy, gz)) {
    return;
  }

  // 1. Total Acceleration Vector Magnitude: a = sqrt(ax² + ay² + az²)
  float accelMag = sqrt(ax * ax + ay * ay + az * az);

  // 2. Posture Angle (Pitch & Roll)
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * 180.0f / M_PI;
  float roll = atan2(ay, sqrt(ax * ax + az * az)) * 180.0f / M_PI;
  float tiltAngle = max(fabs(pitch - refPitch), fabs(roll - refRoll));

  // 3. Rotational Velocity Magnitude: ω = sqrt(gx² + gy² + gz²)
  float gyroMag = sqrt(gx * gx + gy * gy + gz * gz);

  // Debug Print on significant movement
  if (accelMag > 1.8f || gyroMag > 120.0f || currentState != STATE_NORMAL) {
    Serial.printf("[IMU] a: %.2fg | ω: %.1f°/s | Tilt: %.1f° | State: %d\n",
                  accelMag, gyroMag, tiltAngle, currentState);
  }

  switch (currentState) {
  case STATE_NORMAL:
    // Phase 1: Free Fall Detection (< 0.60g)
    if (accelMag < FREEFALL_G_THRESHOLD) {
      currentState = STATE_FREEFALL;
      freeFallStartMs = now;
      peakImpactG = 0;
      Serial.printf(
          "[DETECTION] ⚡ Free-fall initiated (accel=%.2fg < %.2fg)\n",
          accelMag, FREEFALL_G_THRESHOLD);
    }
    // Direct Heavy Impact Detection (> 3.2g with high rotational rate)
    else if (accelMag > (IMPACT_G_THRESHOLD + 0.2f) && gyroMag > 160.0f) {
      currentState = STATE_IMPACT;
      impactStartMs = now;
      peakImpactG = accelMag;
      Serial.printf("[DETECTION] 💥 Sudden Heavy Impact detected! (Peak=%.2fg, "
                    "Gyro=%.1f°/s)\n",
                    accelMag, gyroMag);
    }
    break;

  case STATE_FREEFALL:
    // Track peak acceleration or transition to IMPACT
    if (accelMag > IMPACT_G_THRESHOLD) {
      currentState = STATE_IMPACT;
      impactStartMs = now;
      peakImpactG = accelMag;
      Serial.printf("[DETECTION] 💥 Impact following free-fall! (Peak=%.2fg, "
                    "Duration=%lums)\n",
                    accelMag, now - freeFallStartMs);
    } else if (now - freeFallStartMs > 600) {
      // Free fall timed out without impact (e.g. normal gentle drop or toss)
      currentState = STATE_NORMAL;
    }
    break;

  case STATE_IMPACT:
    // Track peak impact G during settling window
    if (accelMag > peakImpactG) {
      peakImpactG = accelMag;
    }

    // Allow 200ms settling time for initial bounce
    if (now - impactStartMs < 200)
      return;

    // Check for Posture Change (Tilt > 35°)
    if (tiltAngle > TILT_ANGLE_THRESHOLD) {
      currentState = STATE_STILLNESS_CHECK;
      stillStartMs = now;
      Serial.printf("[DETECTION] 📐 Tilt threshold exceeded (%.1f° > %.1f°). "
                    "Checking immobility...\n",
                    tiltAngle, TILT_ANGLE_THRESHOLD);
    } else if (now - impactStartMs > 2500) {
      // No posture change after impact -> recovery/bounce
      Serial.println(F("[DETECTION] ↩️ Impact without tilt change -> Normal "
                       "motion resumed."));
      currentState = STATE_NORMAL;
    }
    break;

  case STATE_STILLNESS_CHECK:
    // Patient is immobile if rotational motion is low
    if (gyroMag < STILL_MOTION_DPS) {
      if (now - stillStartMs >= STILL_DURATION_MS) {
        // CONFIRMED HEAVY FALL!
        currentState = STATE_FALL_CONFIRMED;
        alarmStartMs = now;
        lastBuzzerToggleMs = now;
        setBuzzer(true);

        Serial.printf("\n==================================================\n");
        Serial.printf(" 🚨🚨 CRITICAL HEAVY FALL CONFIRMED! 🚨🚨\n");
        Serial.printf(" Peak Impact: %.2f g | Posture Tilt: %.1f°\n",
                      peakImpactG, tiltAngle);
        Serial.printf(" Actuating Emergency Siren on Buzzer (GPIO %d)!\n",
                      BUZZER_PIN);
        Serial.printf("==================================================\n\n");

        // Dispatch immediate alert
        sendFallAlertToDashboard(peakImpactG, tiltAngle);
        alertDispatched = true;
      }
    } else if (gyroMag > 75.0f) {
      // Person got up and moved vigorously -> False alarm / recovery
      Serial.printf("[DETECTION] 🏃 Motion detected (%.1f°/s) -> Patient stood "
                    "up. Resetting.\n",
                    gyroMag);
      resetToNormal();
    }
    break;

  case STATE_FALL_CONFIRMED:
    // Alarm remains active until timeout or button press
    if (gyroMag > 90.0f) {
      // Vigorous recovery motion resets alarm
      Serial.println(F("[ALARM] Patient recovered motion. Silencing alarm."));
      resetToNormal();
    }
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  8. BUTTON HANDLER (CANCEL / MANUAL SOS)
// ─────────────────────────────────────────────────────────────────────────────────
void checkButton() {
  static bool lastButtonState = HIGH;
  static unsigned long lastDebounceMs = 0;

  int reading = digitalRead(BUTTON_PIN);
  if (reading != lastButtonState) {
    lastDebounceMs = millis();
    lastButtonState = reading;
  }

  if ((millis() - lastDebounceMs) > 50) {
    if (reading == LOW) { // Button pressed (INPUT_PULLUP)
      if (currentState == STATE_FALL_CONFIRMED) {
        Serial.println(
            F("[BUTTON] 🛑 Fall alarm cancelled by user push button."));
        resetToNormal();
      } else {
        // Manual Distress Alert
        Serial.println(F("[BUTTON] 🆘 Manual Distress Button triggered!"));
        triggerBeep(300);
        sendFallAlertToDashboard(1.0f, 0.0f);
      }
      delay(300); // Button cooldown
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  9. SETUP & MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println(F("\n=================================================="));
  Serial.println(F("  JEEVAN Wearable Fall Detector (ESP32 + MPU-6050)"));
  Serial.println(F("  Production Firmware with Heavy-Fall Buzzer"));
  Serial.println(F("=================================================="));

  // Initialize GPIO Pins
  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzer(false);

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Startup Test Beep on Buzzer
  triggerBeep(100);

  // Initialize I2C Bus for MPU-6050
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000); // 400 kHz Fast I2C Mode

  // Initialize and Calibrate MPU-6050
  mpuReady = initMPU6050();
  if (mpuReady) {
    calibrateSensors();
  } else {
    Serial.println(
        F("[MPU6050] ⚠️ Check wiring: VCC->3V3, GND->GND, SDA->21, SCL->22"));
  }

  // Connect to Wi-Fi
  initWiFi();
}

void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi Connection in Background
  maintainWiFi();

  // 2. Non-blocking Buzzer Alarm Sequencer
  updateAlarmBuzzer();

  // 3. User Push Button Handler (Cancel alarm / Manual SOS)
  checkButton();

  // 4. 50 Hz IMU Sampling and Fall Detection (every 20ms)
  if (mpuReady && (now - lastSampleMs >= SAMPLE_INTERVAL_MS)) {
    lastSampleMs = now;
    runFallDetection(now);
  }

  // 5. 5-Second Heartbeat to Dashboard (keeps bracelet marked 'online')
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    sendHeartbeat();
  }
}
