/*
 * =================================================================================
 *  fall_bracelet.ino — JEEVAN Smart Wearable Fall Detection Belt
 *  Hardware: ESP32 + MPU-6050 + NEO-6M GPS + Buzzer + Push Button
 * =================================================================================
 *
 *  Pin Configuration:
 *    . SDA_PIN          : GPIO 21 (MPU-6050 I2C Data)
 *    . SCL_PIN          : GPIO 22 (MPU-6050 I2C Clock)
 *    . MPU_ADDR         : 0x68    (AD0 connected to GND)
 *    . BUZZER_PIN_1     : GPIO 25 (Primary Active Piezo Buzzer Siren)
 *    . BUZZER_PIN_2     : GPIO 4  (Secondary Buzzer Pin for hardware compatibility)
 *    . STATUS_LED_PIN   : GPIO 2  (ESP32 Onboard Status Indicator)
 *    . BUTTON_PIN       : GPIO 27 (External Push Button with INPUT_PULLUP)
 *    . BOOT_BUTTON_PIN  : GPIO 0  (ESP32 On-board BOOT Button with INPUT_PULLUP)
 *    . GPS_RX_PIN       : GPIO 17 (Connects to NEO-6M GPS TX)
 *    . GPS_TX_PIN       : GPIO 16 (Connects to NEO-6M GPS RX)
 *
 *  Calibration Workflow (BELT BUTTON — GPIO 27 or BOOT GPIO 0):
 *    1. User wears belt in normal standing posture.
 *    2. Press the calibration button to enter Calibration Mode.
 *    3. During calibration (~3 seconds):
 *       - Buzzer emits 2 short beeps per second (double-beep: 90ms ON, 70ms off, 90ms ON).
 *       - MPU-6050 samples wearer's mean upright position (refPitch, refRoll).
 *       - Twilio and ALL emergency alerts are strictly suppressed.
 *    4. Once calibrated:
 *       - Buzzer sounds one solid 1-second continuous beep (calibration confirmed).
 *       - Belt is ARMED: fall detection active, zeroed to calibrated mean position.
 *       - Measurements and graph start from this height/posture.
 *    5. Fall alarm active: tap button once to silence siren and reset.
 *    6. Press button anytime to re-calibrate.
 *
 *  Networking Architecture (Belt -> WiFi -> Dashboard -> Twilio):
 *    . Wi-Fi auto-scans for ElderCare AP variants (handles trailing spaces).
 *    . Tries both "ElderCare" and "ElderCare " (with trailing space).
 *    . Dynamic server resolution via mDNS (LAPTOP-RSME6K8B) and IP fallback.
 *    . Telemetry sent to Central Dashboard (port 5050) & Flask API (port 5000).
 *    . Fall event triggers Twilio Emergency Voice Call & SMS via dashboard.
 *    . Heartbeat sent even while UNCALIBRATED so dashboard always sees belt status.
 * =================================================================================
 */

#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <UniversalTelegramBot.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <math.h>

// ─────────────────────────────────────────────────────────────────────────────────
//  1. CONFIGURATION & PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────────
// Wi-Fi Credentials — matches eldercare hotspot across firmwares
// WiFi SSID — the scan will find the exact variant (with or without trailing space)
#define DEFAULT_WIFI_SSID "ElderCare"
#define WIFI_PASS "ami bolbona"

// Central Dashboard & Twilio Backend Gateway (server discovery matching
// bpm_bracelet / medicine_box)
#define SERVER_WINDOWS_HOST "LAPTOP-RSME6K8B"
#define SERVER_FALLBACK_IP IPAddress(10, 167, 243, 135)
#define DASHBOARD_PORT 5050
#define FLASK_PORT 5000
#define DEVICE_ID "belt-01"

// Telegram Bot Credentials (Optional direct alert from ESP32)
#define BOT_TOKEN "YOUR_BOT_TOKEN"
#define CHAT_ID "YOUR_CHAT_ID"

// Pin Configuration
#define SDA_PIN 21    // MPU-6050 I2C SDA
#define SCL_PIN 22    // MPU-6050 I2C SCL
#define MPU_ADDR 0x68 // MPU-6050 I2C Address

// Buzzer & LED Pins (Dual buzzer pin driving for complete hardware
// compatibility)
#define BUZZER_PIN_1 25  // Primary Active Piezo Buzzer Pin
#define BUZZER_PIN_2 4   // Secondary Buzzer Pin (GPIO 4)
#define STATUS_LED_PIN 2 // Onboard Status LED

// Push Buttons (Support both external wire on GPIO 27 and built-in BOOT button
// GPIO 0)
#define BUTTON_PIN 27     // External Push Button (INPUT_PULLUP)
#define BOOT_BUTTON_PIN 0 // ESP32 On-board BOOT Button (INPUT_PULLUP)

// GPS Hardware UART
#define GPS_RX_PIN 17 // Connects to NEO-6M GPS TX
#define GPS_TX_PIN 16 // Connects to NEO-6M GPS RX

// Fall Detection Physical Thresholds (Calibrated for real-world drop sensitivity)
#define FREEFALL_G          0.88f // Drop below 0.88g → free fall / rapid descent
#define IMPACT_G            1.65f // Spike above 1.65g (preceded by freefall/tumble) → impact
#define DIRECT_IMPACT_G     2.05f // Direct hard impact spike above 2.05g → impact
#define TILT_ANGLE          18.0f // 3D spatial tilt change > 18° from calibrated upright vector
#define STILL_MOTION_DPS    35.0f // Angular motion < 35°/s (tolerant to MPU-6050 gyro noise)
#define STILL_TIME_MS       1000  // 1000ms (1.0s) continuous stillness → fall confirmed
#define IMPACT_WINDOW_MS    5000  // 5.0 seconds observation window after impact
#define SAMPLE_INTERVAL     10    // 10ms (100Hz) high-speed IMU sampling rate (catches 10ms peaks)
#define HEARTBEAT_INTERVAL_MS 3000 // 3s heartbeat telemetry

// Calibration buzzer pattern timing
#define CAL_BEEP_ON_MS   90   // Each calibration beep = 90ms ON
#define CAL_BEEP_GAP_MS  70   // Gap between the two beeps = 70ms silence
#define CAL_CYCLE_MS     1000 // Full cycle = 1 second (2 beeps + sampling)
#define CAL_CYCLES       3    // 3 cycles = ~3 seconds total calibration
#define CAL_DONE_TONE_MS 1000 // 1 second solid buzzer after calibration success

// ─────────────────────────────────────────────────────────────────────────────────
//  2. GLOBAL STATE & INSTANCES
// ─────────────────────────────────────────────────────────────────────────────────
enum State { NORMAL, IMPACT, FALL_CONFIRMED };
State state = NORMAL;

// Calibration state
bool isCalibrated = false;  // true once user has calibrated (or 12s auto-arm)
bool isCalibrating = false; // true while calibration routine is running

// Pre-impact circular buffer (last 40 samples = 400ms at 100Hz)
#define PRE_IMPACT_LEN 40
struct IMUHistory {
  float accel;
  float motionDps;
};
IMUHistory preImpactBuf[PRE_IMPACT_LEN];
int preImpactIdx = 0;

unsigned long impactStart = 0;
unsigned long stillStartTime = 0;
unsigned long sustainedMotionStart = 0;
unsigned long confirmedTime = 0;
unsigned long lastSample = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastBuzzerToggle = 0;
unsigned long lastWiFiRetry = 0;

// 3D Calibrated Gravity Vector (Omnidirectional posture reference)
float refAx = 0.0f, refAy = 0.0f, refAz = 1.0f;
float refGravMag = 1.0f;
float refPitch = 0.0f, refRoll = 0.0f;
float gyroBiasX = 0.0f, gyroBiasY = 0.0f, gyroBiasZ = 0.0f;
float lastImpactG = 0.0f;
float lastTiltAngle = 0.0f;
bool alertSent = false;
bool buzzerPhysicalState = false;

// Network server discovery state
IPAddress dashboardServerIp = SERVER_FALLBACK_IP;
bool serverResolved = false;

// GPS variables
double lastLat = 0.0, lastLng = 0.0;
bool haveFix = false;

HardwareSerial GPSSerial(1);
TinyGPSPlus gps;

WiFiClientSecure secured_client;
UniversalTelegramBot bot(BOT_TOKEN, secured_client);

// Forward Declarations
void readMPU(float &ax, float &ay, float &az, float &gx, float &gy, float &gz);
void calibrateGyro();
void runUserCalibration();
void soundBuzzer(bool on);
void sendAlert(const char *reason);
void sendHeartbeat();
void runDetection(unsigned long now);
void maintainWiFi();
void initWiFi();
bool resolveDashboardServer();
bool isButtonPressed();

// ─────────────────────────────────────────────────────────────────────────────────
//  3. SETUP & HARDWARE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(300);

  Serial.println(
      F("\n========================================================"));
  Serial.println(F("  JEEVAN Smart Wearable Fall Detection Belt"));
  Serial.println(F("  Hardware: ESP32 + MPU-6050 + NEO-6M GPS"));
  Serial.println(F("========================================================"));
  Serial.println(F("[SYSTEM] Belt UNCALIBRATED."));
  Serial.println(F("[SYSTEM] → Wear the belt and press BUTTON (GPIO 27 or BOOT "
                   "GPIO 0) to calibrate."));

  // Initialize GPIO Pins
  pinMode(BUZZER_PIN_1, OUTPUT);
  pinMode(BUZZER_PIN_2, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  soundBuzzer(false);

  // Power-on test chirp (100ms)
  soundBuzzer(true);
  delay(100);
  soundBuzzer(false);

  // Initialize I2C Bus for MPU-6050
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  // Wake up MPU-6050 (clear SLEEP bit in PWR_MGMT_1)
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  byte err = Wire.endTransmission();
  if (err != 0) {
    Serial.printf("[MPU6050] ❌ Sensor not responding at 0x%02X! Check "
                  "SDA:GPIO%d, SCL:GPIO%d\n",
                  MPU_ADDR, SDA_PIN, SCL_PIN);
  } else {
    Serial.println(F("[MPU6050] ✅ Sensor online."));
  }

  // Factory gyro DC offset calibration at boot
  calibrateGyro();

  // Initialize Hardware UART for GPS (NEO-6M baud 9600)
  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf("[GPS] ✅ Initialized GPS UART (RX: GPIO%d, TX: GPIO%d)\n",
                GPS_RX_PIN, GPS_TX_PIN);

  // Connect to Wi-Fi with auto-scan for ElderCare AP
  initWiFi();

  // Enable insecure TLS for Telegram Bot API
  secured_client.setInsecure();

  Serial.println(F("\n[SYSTEM] ⏳ Waiting for user to press CALIBRATION BUTTON "
                   "(GPIO 27 or BOOT)...\n"));
}

// ─────────────────────────────────────────────────────────────────────────────────
//  4. MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi and server connection
  maintainWiFi();

  // 2. Continuous GPS Stream Decoding
  while (GPSSerial.available()) {
    gps.encode(GPSSerial.read());
  }
  if (gps.location.isValid() && gps.location.age() < 30000) {
    lastLat = gps.location.lat();
    lastLng = gps.location.lng();
    haveFix = true;
  } else if (gps.location.age() >= 30000) {
    haveFix = false;
  }

  // 3. Button Handler — edge-detection (HIGH->LOW transition only) to avoid
  //    repeated triggers when held. External GPIO 27 OR on-board BOOT GPIO 0.
  static bool lastButtonState = HIGH;
  bool currentButtonRaw = isButtonPressed() ? LOW : HIGH;

  if (lastButtonState == HIGH && currentButtonRaw == LOW) {
    delay(40); // software debounce
    if (isButtonPressed()) {
      if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
        Serial.println(F("[BUTTON] ESP32 BOOT button (GPIO 0) pressed!"));
      } else {
        Serial.println(F("[BUTTON] External button (GPIO 27) pressed!"));
      }

      if (state == FALL_CONFIRMED) {
        Serial.println(F("[BUTTON] Fall alarm cancelled by user."));
        state     = NORMAL;
        alertSent = false;
        soundBuzzer(false);
      } else {
        // Measure press duration: Tap (<2.5s) = Calibration, Long Press (>2.5s) = Instant Emergency Alert Test
        unsigned long pressStart = millis();
        bool longPressTriggered = false;
        while (isButtonPressed()) {
          delay(20);
          if (millis() - pressStart > 2500 && !longPressTriggered) {
            longPressTriggered = true;
            Serial.println(F("\n🚨 [BUTTON] LONG PRESS (>2.5s) DETECTED → MANUAL EMERGENCY FALL TRIGGER!"));
            soundBuzzer(true);
            delay(150);
            soundBuzzer(false);
            state = FALL_CONFIRMED;
            alertSent = false;
            break;
          }
        }

        if (!longPressTriggered) {
          // Quick tap -> Start user calibration sequence
          Serial.println(F("[BUTTON] Tap detected: Starting calibration sequence..."));
          runUserCalibration();
        }
      }

      // Wait for button release before continuing
      while (isButtonPressed()) { delay(10); }
      delay(50); // post-release debounce
    }
  }
  lastButtonState = currentButtonRaw;

  // 4. Heartbeat — sent regardless of calibration status
  //    Dashboard receives UNCALIBRATED / CALIBRATING / IDLE phases from payload.
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  // 5. Calibration check:
  //    - If user presses calibration button, runUserCalibration() measures upright posture.
  //    - If user drops belt without pressing button, auto-arm with default posture after 12s
  //      so safety detection is NEVER silently blocked.
  if (!isCalibrated) {
    if (now > 12000) {
      isCalibrated = true;
      refAx = 0.0f; refAy = 0.0f; refAz = 1.0f; refGravMag = 1.0f;
      refPitch = 0.0f;
      refRoll  = 0.0f;
      Serial.println(F("[SYSTEM] ⚠️ Belt auto-armed with default upright posture (no button pressed)."));
      digitalWrite(STATUS_LED_PIN, WiFi.status() == WL_CONNECTED ? HIGH : LOW);
    } else {
      static unsigned long lastLedToggle = 0;
      if (now - lastLedToggle >= 500) {
        lastLedToggle = now;
        digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
      }
      return;
    }
  }

  // 6. Sample MPU at 50Hz and run physics detection (ONLY when calibrated)
  if (now - lastSample >= SAMPLE_INTERVAL) {
    lastSample = now;
    runDetection(now);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  BUTTON HELPER — returns true if any configured button is pressed (LOW)
// ─────────────────────────────────────────────────────────────────────────────────
bool isButtonPressed() {
  return (digitalRead(BUTTON_PIN) == LOW || digitalRead(BOOT_BUTTON_PIN) == LOW);
}

// ─────────────────────────────────────────────────────────────────────────────────
//  5. USER CALIBRATION SEQUENCE
//  Called when the calibration button is pressed while the belt is worn.
//  Buzzer pattern during calibration: 2 beeps per second (90ms ON, 70ms gap, 90ms ON)
//  After calibration: 1-second solid continuous tone confirms belt is armed.
//  refPitch/refRoll set to mean standing position — all fall measurements
//  are zero-referenced from this height/posture (graph starts from here).
//  Twilio/alerts strictly suppressed via isCalibrating guard.
// ─────────────────────────────────────────────────────────────────────────────────
void runUserCalibration() {
  isCalibrating = true;
  isCalibrated  = false;
  state         = NORMAL;
  alertSent     = false;
  soundBuzzer(false);

  Serial.println(F("\n========================================================"));
  Serial.println(F("  [CALIBRATION] USER CALIBRATION STARTED"));
  Serial.println(F("  Stand upright in your normal belt wearing position."));
  Serial.println(F("  Measuring mean posture and gyro bias over ~3 seconds..."));
  Serial.println(F("  Twilio/alerts SUPPRESSED during calibration."));
  Serial.println(F("  BUZZER: 2 beeps/sec x3 cycles -> 1s solid tone when done."));
  Serial.println(F("========================================================\n"));

  long  sumGx = 0, sumGy = 0, sumGz = 0;
  float sumAx = 0.0f, sumAy = 0.0f, sumAz = 0.0f;
  float sumPitch = 0.0f, sumRoll = 0.0f;
  int   validSamples = 0;

  // Run CAL_CYCLES one-second cycles.
  // Each cycle: Beep1(90ms) + Gap(70ms) + Beep2(90ms) + IMU sampling (~750ms).
  for (int cycle = 0; cycle < CAL_CYCLES; cycle++) {
    Serial.printf("[CALIBRATION] Cycle %d/%d: 2 beeps this second...\n", cycle + 1, CAL_CYCLES);

    // Beep 1 (90ms ON)
    soundBuzzer(true);
    delay(CAL_BEEP_ON_MS);
    soundBuzzer(false);

    // Inter-beep gap (70ms OFF)
    delay(CAL_BEEP_GAP_MS);

    // Beep 2 (90ms ON)
    soundBuzzer(true);
    delay(CAL_BEEP_ON_MS);
    soundBuzzer(false);

    // IMU sampling for the remaining ~750ms of this 1-second cycle
    unsigned long cycleStart     = millis();
    unsigned long cycleRemaining = (unsigned long)CAL_CYCLE_MS
                                   - (2UL * (unsigned long)CAL_BEEP_ON_MS)
                                   - (unsigned long)CAL_BEEP_GAP_MS;
    while (millis() - cycleStart < cycleRemaining) {
      Wire.beginTransmission(MPU_ADDR);
      Wire.write(0x3B);
      if (Wire.endTransmission(false) == 0 &&
          Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14) == 14) {
        int16_t rawAx = (Wire.read() << 8) | Wire.read();
        int16_t rawAy = (Wire.read() << 8) | Wire.read();
        int16_t rawAz = (Wire.read() << 8) | Wire.read();
        Wire.read();
        Wire.read(); // temperature skip
        int16_t rawGx = (Wire.read() << 8) | Wire.read();
        int16_t rawGy = (Wire.read() << 8) | Wire.read();
        int16_t rawGz = (Wire.read() << 8) | Wire.read();

        sumGx += rawGx;
        sumGy += rawGy;
        sumGz += rawGz;

        float ax = (float)rawAx / 16384.0f;
        float ay = (float)rawAy / 16384.0f;
        float az = (float)rawAz / 16384.0f;

        sumAx += ax;
        sumAy += ay;
        sumAz += az;

        sumPitch += atan2(ax, sqrt(ay * ay + az * az)) * 180.0f / PI;
        sumRoll  += atan2(ay, sqrt(ax * ax + az * az)) * 180.0f / PI;
        validSamples++;
      }
      delay(15); // ~66 samples/sec during sampling window
    }
  }

  // Compute mean calibration reference
  if (validSamples > 0) {
    gyroBiasX = (float)sumGx / validSamples;
    gyroBiasY = (float)sumGy / validSamples;
    gyroBiasZ = (float)sumGz / validSamples;

    refAx = sumAx / validSamples;
    refAy = sumAy / validSamples;
    refAz = sumAz / validSamples;
    refGravMag = sqrt(refAx * refAx + refAy * refAy + refAz * refAz);
    if (refGravMag < 0.1f) refGravMag = 1.0f;

    refPitch = sumPitch / validSamples;
    refRoll  = sumRoll  / validSamples;

    Serial.println(F("\n[CALIBRATION] CALIBRATION COMPLETE!"));
    Serial.printf("[CALIBRATION]   Samples collected  : %d\n", validSamples);
    Serial.printf("[CALIBRATION]   Gyro Biases       -> X: %.1f  Y: %.1f  Z: %.1f\n",
                  gyroBiasX, gyroBiasY, gyroBiasZ);
    Serial.printf("[CALIBRATION]   Mean 3D Vector    -> X: %.2f  Y: %.2f  Z: %.2f (mag=%.2fg)\n",
                  refAx, refAy, refAz, refGravMag);
    Serial.printf("[CALIBRATION]   Mean Posture Ref  -> Pitch: %.2f deg   Roll: %.2f deg\n",
                  refPitch, refRoll);
    Serial.println(F("[CALIBRATION]   Fall detection zeroed to THIS height & posture."));
    Serial.println(F("[CALIBRATION]   Graph & measurements start from this mean position."));
    Serial.println(F("========================================================\n"));
  } else {
    Serial.println(F("[CALIBRATION] WARNING: Sensor read error! Retry on next button press."));
    isCalibrating = false;
    return;
  }

  // 1-second continuous solid buzzer tone — calibration success confirmed
  Serial.println(F("[CALIBRATION] Playing 1-second solid completion tone..."));
  soundBuzzer(true);
  delay(CAL_DONE_TONE_MS);
  soundBuzzer(false);

  isCalibrated  = true;
  isCalibrating = false;

  Serial.println(F("[SYSTEM] Belt ARMED and ACTIVE!"));
  Serial.println(F("[SYSTEM]   Measuring live tilt from calibrated mean position."));
  Serial.println(F("[SYSTEM]   Fall detection active. Press button to re-calibrate.\n"));

  digitalWrite(STATUS_LED_PIN, WiFi.status() == WL_CONNECTED ? HIGH : LOW);
}

// ─────────────────────────────────────────────────────────────────────────────────
//  6. 3D SPATIAL TILT ANGLE COMPUTATION (VECTOR DOT PRODUCT)
//  Calculates the true 3D spatial deviation between calibrated upright posture
//  and current position. Detects falls in all 360° directions (forward, backward,
//  lateral, or diagonal) with zero dead-zones.
// ─────────────────────────────────────────────────────────────────────────────────
float compute3DTiltAngle(float ax, float ay, float az) {
  float mag = sqrt(ax * ax + ay * ay + az * az);
  if (mag < 0.2f || refGravMag < 0.2f) return 0.0f;
  float dot = (ax * refAx + ay * refAy + az * refAz) / (mag * refGravMag);
  if (dot > 1.0f) dot = 1.0f;
  if (dot < -1.0f) dot = -1.0f;
  return acos(dot) * 180.0f / PI;
}

// ─────────────────────────────────────────────────────────────────────────────────
//  7. CLINICAL-GRADE MULTI-FEATURE FALL DETECTION (100Hz)
// ─────────────────────────────────────────────────────────────────────────────────
void runDetection(unsigned long now) {
  float ax, ay, az, gx, gy, gz;
  readMPU(ax, ay, az, gx, gy, gz);

  // Total acceleration magnitude
  float accel = sqrt(ax * ax + ay * ay + az * az);

  // Total rotational velocity
  float motionDps = fabs(gx) + fabs(gy) + fabs(gz);

  // Compute 3D true spatial tilt
  float tilt3D = compute3DTiltAngle(ax, ay, az);

  switch (state) {
  case NORMAL:
    // 1. Maintain 400ms pre-impact circular buffer (40 samples at 100Hz)
    preImpactBuf[preImpactIdx].accel = accel;
    preImpactBuf[preImpactIdx].motionDps = motionDps;
    preImpactIdx = (preImpactIdx + 1) % PRE_IMPACT_LEN;

    // 2. Evaluate impact spike
    if (accel >= IMPACT_G) {
      // Find minimum acceleration and peak tumble motion in preceding 400ms
      float minPreAccel = 99.0f;
      float maxPreMotion = 0.0f;
      for (int i = 0; i < PRE_IMPACT_LEN; i++) {
        if (preImpactBuf[i].accel < minPreAccel) minPreAccel = preImpactBuf[i].accel;
        if (preImpactBuf[i].motionDps > maxPreMotion) maxPreMotion = preImpactBuf[i].motionDps;
      }

      bool hadPreFreefall = (minPreAccel < FREEFALL_G);     // Descent / weightlessness phase
      bool hadPreTumble   = (maxPreMotion > 45.0f);         // Rapid rotation during descent
      bool isDirectHardImpact = (accel >= DIRECT_IMPACT_G); // Heavy collision spike

      if (hadPreFreefall || hadPreTumble || isDirectHardImpact) {
        state = IMPACT;
        impactStart = now;
        lastImpactG = accel;
        stillStartTime = 0;
        sustainedMotionStart = 0;
        Serial.printf("[DETECTION] 💥 IMPACT DETECTED (peak=%.2fg | preMin=%.2fg | preMotion=%.1f dps | direct=%s)\n",
                      accel, minPreAccel, maxPreMotion, isDirectHardImpact ? "YES" : "NO");
      }
    }
    break;

  case IMPACT:
    // Peak hold: record highest shock during impact phase
    if (accel > lastImpactG) lastImpactG = accel;

    // Initial 150ms debounce while mechanical bounce oscillations subside
    if (now - impactStart < 150) return;

    lastTiltAngle = tilt3D;

    // Posture and immobility evaluation
    if (tilt3D >= TILT_ANGLE) {
      if (motionDps < STILL_MOTION_DPS) {
        sustainedMotionStart = 0; // Clear any active motion streak
        if (stillStartTime == 0) {
          stillStartTime = now;
          Serial.printf("[DETECTION] 📐 3D Tilt %.1f° >= %.1f°. Measuring immobility (%dms)...\n",
                        tilt3D, TILT_ANGLE, STILL_TIME_MS);
        }
        if (now - stillStartTime >= STILL_TIME_MS) {
          state = FALL_CONFIRMED;
          confirmedTime = now;
          Serial.println(F("\n🚨🚨 ### CRITICAL FALL CONFIRMED! ### 🚨🚨"));
          Serial.printf("   Impact: %.2fg | 3D Tilt: %.1f° | Immobile: %dms\n\n",
                        lastImpactG, lastTiltAngle, STILL_TIME_MS);
        }
      } else {
        // Glitch filter: only reset stillness if motion is sustained > 180ms
        // (prevents electronic gyro jitter from wiping out valid rest time)
        if (sustainedMotionStart == 0) sustainedMotionStart = now;
        if (now - sustainedMotionStart > 180) {
          stillStartTime = 0;
        }
      }
    }

    // Generous observation window (5.0 seconds) for belt to settle
    if (now - impactStart > IMPACT_WINDOW_MS) {
      Serial.printf("[DETECTION] Impact window timed out (tilt=%.1f°, motion=%.1f dps). Resetting to NORMAL.\n",
                    lastTiltAngle, motionDps);
      state = NORMAL;
      stillStartTime = 0;
      sustainedMotionStart = 0;
    }
    break;

  case FALL_CONFIRMED:
    // Dispatch alert exactly once per fall
    if (!alertSent) {
      soundBuzzer(true);
      sendAlert("FALL DETECTED");
      alertSent = true;
    }

    // Non-blocking siren pulsation: 150ms ON / 150ms OFF
    if (now - lastBuzzerToggle >= 150) {
      lastBuzzerToggle = now;
      buzzerPhysicalState = !buzzerPhysicalState;
      soundBuzzer(buzzerPhysicalState);
    }

    // Protected Recovery: locked for at least 5 seconds so Wi-Fi dispatch completes
    if (now - confirmedTime > 5000 && motionDps > 80.0f) {
      Serial.printf("[RECOVERY] 🏃 Standing motion detected (%.1f dps) → Alarm silenced.\n", motionDps);
      state = NORMAL;
      alertSent = false;
      soundBuzzer(false);
    }
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  7. EMERGENCY ALERT DISPATCH (DASHBOARD + TWILIO + TELEGRAM)
// ─────────────────────────────────────────────────────────────────────────────────
void sendAlert(const char *reason) {
  // Safety guard: never alert during calibration
  if (isCalibrating) {
    Serial.println(F("[ALERT] ⛔ Alert suppressed — calibration in progress."));
    return;
  }

  Serial.printf("\n🚨 [ALERT] Triggering emergency response: %s\n", reason);

  // Determine GPS location
  String mapsUrl = "";
  String location = "Inside Home (Smart Safety Belt)";
  String address =
      "Flat 402, Green Valley Apartments, Kolkata, West Bengal - 700091";

  if (haveFix && (lastLat != 0.0 || lastLng != 0.0)) {
    mapsUrl = "https://maps.google.com/?q=" + String(lastLat, 6) + "," +
              String(lastLng, 6);
    location = "Outdoor (GPS Coordinates)";
    address = mapsUrl;
  }

  // 1. Telegram Alert
  if (strcmp(BOT_TOKEN, "YOUR_BOT_TOKEN") != 0 &&
      WiFi.status() == WL_CONNECTED) {
    String msg = "🚨 JEEVAN EMERGENCY ALERT: " + String(reason) + "\n";
    msg += haveFix ? ("📍 Location (Outdoor): " + mapsUrl)
                   : "🏠 Location: Inside Home (No GPS fix)\nAddress: Flat "
                     "402, Green Valley Apartments, Kolkata";
    bot.sendMessage(CHAT_ID, msg, "");
    Serial.println(F("[TELEGRAM] ✅ Alert dispatched via Telegram Bot."));
  }

  // 2. Central Dashboard → triggers Twilio Voice Call + SMS
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    char url[128];
    snprintf(url, sizeof(url), "http://%s:%d/api/fall-event",
             dashboardServerIp.toString().c_str(), DASHBOARD_PORT);

    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(4000);

      String payload = "{";
      payload += "\"source\":\"belt\",";
      payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
      payload += "\"confidence\":0.95,";
      payload += "\"location\":\"" + location + "\",";
      payload += "\"address\":\"" + address + "\",";
      payload += "\"reason\":\"" + String(reason) + "\",";
      payload +=
          "\"impactG\":" + String(lastImpactG > 0 ? lastImpactG : IMPACT_G, 2) +
          ",";
      payload += "\"tiltAngle\":" +
                 String(lastTiltAngle > 0 ? lastTiltAngle : TILT_ANGLE, 1) +
                 ",";
      payload += "\"is_fall\":true,";
      payload += "\"forceAlert\":true,";
      payload += "\"haveGps\":" + String(haveFix ? "true" : "false") + ",";
      payload += "\"latitude\":" + String(lastLat, 6) + ",";
      payload += "\"longitude\":" + String(lastLng, 6) + ",";
      payload += "\"mapsUrl\":\"" + mapsUrl + "\"";
      payload += "}";

      Serial.printf("[HTTP] Posting fall event → %s\n", url);
      int code = http.POST(payload);
      Serial.printf(
          "[HTTP] %s Dashboard returned HTTP %d (Twilio call initiated)\n",
          (code == 200 || code == 201) ? "✅" : "⚠️", code);
      http.end();
    }

    // Central Flask backend notification
    snprintf(url, sizeof(url), "http://%s:%d/api/fall",
             dashboardServerIp.toString().c_str(), FLASK_PORT);
    if (http.begin(client, url)) {
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(2000);
      http.POST("{\"source\":\"belt\",\"is_fall\":true,\"confidence\":0.95,"
                "\"reason\":\"" +
                String(reason) + "\"}");
      http.end();
    }
  } else {
    Serial.println(
        F("[HTTP] ⚠️ Wi-Fi not connected. Siren active locally only."));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  8. HEARTBEAT TELEMETRY TO DASHBOARD
//  Sent every HEARTBEAT_INTERVAL_MS regardless of calibration state.
//  Includes calibrated + calibrating fields so dashboard shows correct status.
// ─────────────────────────────────────────────────────────────────────────────────
void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  char url[128];
  snprintf(url, sizeof(url), "http://%s:%d/api/belt/heartbeat",
           dashboardServerIp.toString().c_str(), DASHBOARD_PORT);

  if (http.begin(client, url)) {
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(1500);

    const char *phaseStr = isCalibrating             ? "CALIBRATING"
                         : !isCalibrated             ? "UNCALIBRATED"
                         : state == IMPACT           ? "IMPACT"
                         : state == FALL_CONFIRMED   ? "FALL_CONFIRMED"
                                                     : "IDLE";

    String payload = "{";
    payload += "\"deviceId\":\""   + String(DEVICE_ID)                        + "\",";
    payload += "\"fallPhase\":\""  + String(phaseStr)                         + "\",";
    payload += "\"calibrated\":"   + String(isCalibrated  ? "true" : "false")  + ",";
    payload += "\"calibrating\":"  + String(isCalibrating ? "true" : "false")  + ",";
    payload += "\"uptime\":"       + String(millis() / 1000)                   + ",";
    payload += "\"impactG\":"      + String(lastImpactG, 2)                   + ",";
    payload += "\"tiltAngle\":"    + String(lastTiltAngle, 1)                 + ",";
    payload += "\"haveGps\":"      + String(haveFix ? "true" : "false")        + ",";
    payload += "\"lat\":"          + String(lastLat, 6)                        + ",";
    payload += "\"lng\":"          + String(lastLng, 6);
    payload += "}";

    int code = http.POST(payload);
    Serial.printf("[HEARTBEAT] HTTP %d | Phase: %s | Cal: %s\n",
                  code, phaseStr, isCalibrated ? "YES" : "NO");
    http.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  9. MPU-6050 SENSOR ACCESS & BOOT GYRO CALIBRATION
// ─────────────────────────────────────────────────────────────────────────────────
void readMPU(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  ax = 0.0f; ay = 0.0f; az = 1.0f;
  gx = 0.0f; gy = 0.0f; gz = 0.0f;
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0)
    return;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14) != 14)
    return;

  int16_t rawAx = (Wire.read() << 8) | Wire.read();
  int16_t rawAy = (Wire.read() << 8) | Wire.read();
  int16_t rawAz = (Wire.read() << 8) | Wire.read();
  Wire.read();
  Wire.read(); // Skip temperature
  int16_t rawGx = (Wire.read() << 8) | Wire.read();
  int16_t rawGy = (Wire.read() << 8) | Wire.read();
  int16_t rawGz = (Wire.read() << 8) | Wire.read();

  // ±2g: 16384 LSB/g  |  ±250°/s: 131 LSB/(°/s)
  ax = (float)rawAx / 16384.0f;
  ay = (float)rawAy / 16384.0f;
  az = (float)rawAz / 16384.0f;

  gx = ((float)rawGx - gyroBiasX) / 131.0f;
  gy = ((float)rawGy - gyroBiasY) / 131.0f;
  gz = ((float)rawGz - gyroBiasZ) / 131.0f;
}

void calibrateGyro() {
  Serial.println(
      F("[BOOT-CAL] Gyro bias calibration. Keep belt flat & still..."));
  long sx = 0, sy = 0, sz = 0;
  int samples = 0;

  for (int i = 0; i < 200; i++) {
    Wire.beginTransmission(MPU_ADDR);
    Wire.write(0x43);
    if (Wire.endTransmission(false) == 0 &&
        Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6) == 6) {
      int16_t rx = (Wire.read() << 8) | Wire.read();
      int16_t ry = (Wire.read() << 8) | Wire.read();
      int16_t rz = (Wire.read() << 8) | Wire.read();
      sx += rx;
      sy += ry;
      sz += rz;
      samples++;
    }
    delay(5);
  }

  if (samples > 0) {
    gyroBiasX = (float)sx / samples;
    gyroBiasY = (float)sy / samples;
    gyroBiasZ = (float)sz / samples;
    Serial.printf("[BOOT-CAL] ✅ Gyro Biases → X: %.1f  Y: %.1f  Z: %.1f\n",
                  gyroBiasX, gyroBiasY, gyroBiasZ);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
//  10. BUZZER & WI-FI UTILITIES
// ─────────────────────────────────────────────────────────────────────────────────
void soundBuzzer(bool on) {
  buzzerPhysicalState = on;
  digitalWrite(BUZZER_PIN_1, on ? HIGH : LOW);
  digitalWrite(BUZZER_PIN_2, on ? HIGH : LOW);
  if (!on) {
    digitalWrite(STATUS_LED_PIN,
                 (isCalibrated && WiFi.status() == WL_CONNECTED) ? HIGH : LOW);
  } else {
    digitalWrite(STATUS_LED_PIN, HIGH);
  }
}

bool resolveDashboardServer() {
  if (WiFi.status() != WL_CONNECTED)
    return false;

  // Direct IP target to avoid mDNS timeout delays
  dashboardServerIp = SERVER_FALLBACK_IP;
  serverResolved = true;
  Serial.printf("[NET] ✅ Dashboard server targeted at %s (Port %d)\n",
                dashboardServerIp.toString().c_str(), DASHBOARD_PORT);
  return true;
}

void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);

  // Scan all networks and print them — helps debug SSID mismatch issues
  String activeSSID = "";
  Serial.println(F("[WiFi] Scanning for ElderCare networks..."));
  int n = WiFi.scanNetworks();
  Serial.printf("[WiFi] Found %d network(s) nearby.\n", n);
  for (int i = 0; i < n; i++) {
    String found   = WiFi.SSID(i);
    String trimmed = found;
    trimmed.trim(); // strip any trailing/leading spaces for comparison
    Serial.printf("[WiFi]   [%d] '%s' (RSSI: %d dBm)\n", i, found.c_str(), WiFi.RSSI(i));
    if (trimmed.equalsIgnoreCase("ElderCare") || found.startsWith("ElderCare")) {
      activeSSID = found; // use the exact SSID as advertised by the hotspot
      Serial.printf("[WiFi] Matched AP: '%s' (RSSI: %d dBm)\n", activeSSID.c_str(), WiFi.RSSI(i));
      break;
    }
  }
  WiFi.scanDelete();

  if (activeSSID.length() == 0) {
    Serial.println(F("[WiFi] No ElderCare AP found in scan. Trying 'ElderCare'..."));
    activeSSID = "ElderCare";
  }

  // First attempt
  Serial.printf("[WiFi] Connecting to '%s'...\n", activeSSID.c_str());
  WiFi.begin(activeSSID.c_str(), WIFI_PASS);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 25) {
    delay(250);
    Serial.print(F("."));
    tries++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("[WiFi] Connected! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!MDNS.begin("jeevan-fall-belt")) {
      Serial.println(F("[mDNS] Error starting mDNS responder!"));
    } else {
      Serial.println(F("[mDNS] Responder started (jeevan-fall-belt.local)"));
    }
    resolveDashboardServer();
    return;
  }

  // First attempt failed — try alternate SSID variant with trailing space
  Serial.printf("[WiFi] Failed with '%s'. Trying 'ElderCare ' (trailing space)...\n", activeSSID.c_str());
  WiFi.disconnect();
  delay(500);
  WiFi.begin("ElderCare ", WIFI_PASS);

  tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(250);
    Serial.print(F("."));
    tries++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(STATUS_LED_PIN, HIGH);
    Serial.printf("[WiFi] Connected via trailing-space SSID! IP: %s | RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!MDNS.begin("jeevan-fall-belt")) {
      Serial.println(F("[mDNS] Error starting mDNS responder!"));
    } else {
      Serial.println(F("[mDNS] Responder started."));
    }
    resolveDashboardServer();
  } else {
    digitalWrite(STATUS_LED_PIN, LOW);
    Serial.println(F("[WiFi] Both SSID variants failed. Background retry every 8s."));
    Serial.println(F("[WiFi]   -> Verify hotspot SSID is 'ElderCare' or 'ElderCare ' (with space)"));
    Serial.println(F("[WiFi]   -> Verify password is 'ami bolbona'"));
    Serial.println(F("[WiFi]   -> Verify hotspot is on 2.4GHz band (ESP32 is 2.4GHz only!)"));
  }
}

void maintainWiFi() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    serverResolved = false;
    if (now - lastWiFiRetry >= 8000) {
      lastWiFiRetry = now;
      Serial.println(F("[WiFi] ⚠️ Disconnected. Reconnecting..."));
      WiFi.reconnect();
    }
  } else {
    if (!serverResolved) {
      resolveDashboardServer();
    }
    if (!buzzerPhysicalState && isCalibrated) {
      digitalWrite(STATUS_LED_PIN, HIGH);
    }
  }
}
