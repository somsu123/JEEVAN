/*
 * ============================================================
 *  fall_bracelet.ino — ESP8266 (NodeMCU) Wrist Fall Detector
 * ============================================================
 *  Hardware:  NodeMCU ESP8266 + MPU6050 (I2C)
 *  Pins:      SDA → D2 (GPIO4), SCL → D1 (GPIO5)
 *  Purpose:   Detects falls using a multi-stage algorithm:
 *             1. FREE-FALL phase  : total-G drops < 0.45g
 *             2. IMPACT phase     : total-G spikes > 2.3g (within 600ms)
 *             3. POSTURE phase    : Z-axis stays low (person horizontal, > 1.5s)
 *             All three must fire IN ORDER → confirmed fall
 *
 *  Reports to: POST http://<server>:5050/api/fall-event
 *  Source tag: "bracelet"  (same endpoint used by Pi camera)
 * ============================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>        // ESP8266-specific (replaces WiFi.h)
#include <ESP8266HTTPClient.h>  // ESP8266-specific (replaces HTTPClient.h)
#include <WiFiClient.h>         // Required by ESP8266HTTPClient

// ─── CONFIGURATION ──────────────────────────────────────────
#define WIFI_SSID         "ElderCare"
#define WIFI_PASSWORD     "ami bolbona"
#define SERVER_IP         "10.113.44.135"   // Current PC hotspot IP
#define SERVER_PORT       5050

// Stringify helper for port number in URL macro
#define STR_HELPER(x) #x
#define STR(x) STR_HELPER(x)

#define FALL_EVENT_URL    "http://" SERVER_IP ":" STR(SERVER_PORT) "/api/fall-event"
#define HEARTBEAT_URL     "http://" SERVER_IP ":" STR(SERVER_PORT) "/api/bracelet/heartbeat"

#define SERIAL_BAUD       115200
#define WIFI_RETRY_MS     10000   // Reconnect check every 10 s

// ─── NodeMCU I2C Pins ───────────────────────────────────────
// NodeMCU: D2 = GPIO4 (SDA),  D1 = GPIO5 (SCL)
#define I2C_SDA  4
#define I2C_SCL  5

// ─── MPU6050 I2C Registers ──────────────────────────────────
#define MPU_ADDR          0x68
#define MPU_PWR_REG       0x6B
#define MPU_ACCEL_REG     0x3B
#define MPU_GYRO_CONFIG   0x1B
#define MPU_ACCEL_CONFIG  0x1C
#define MPU_SMPLRT_DIV    0x19
#define MPU_CONFIG_REG    0x1A

// Accelerometer scale: ±4g → 8192 LSB/g
#define ACCEL_SCALE_4G    8192.0f

// ─── FALL DETECTION THRESHOLDS ──────────────────────────────
// Stage 1 — Free-fall window
// Real free-fall from standing height (~1m) lasts ~450ms and drops to ~0.1g.
// Normal arm movements never drop below ~0.6g.
#define FF_THRESHOLD_G        0.30f   // total-G must drop BELOW 0.30g  (was 0.45g)
#define FF_MIN_DURATION_MS    100     // must stay in free-fall ≥ 100 ms  (was 50ms)
#define FF_MAX_DURATION_MS    700     // realistic free-fall < 700 ms

// Stage 2 — Impact
// A real fall from 1 m standing height generates 4–8g on a hard floor.
// 3.5g filters out stumbles, furniture bumps, arm slams on a desk.
#define IMPACT_THRESHOLD_G    3.5f    // total-G must spike ABOVE 3.5g   (was 2.3g)
#define IMPACT_WINDOW_MS      600     // impact must arrive within 600 ms after free-fall

// Stage 3 — Posture (lying / motionless after impact)
// Require the wrist to be nearly flat (|Gz| < 0.40g) for 3 full seconds.
// If the person catches themselves or gets up quickly → no alert.
#define POSTURE_Z_MAX_G       0.40f   // |Gz| must stay < 0.40g          (was 0.65g)
#define POSTURE_CONFIRM_MS    3000    // must hold posture for 3 s        (was 1500ms)
#define POSTURE_WINDOW_MS     5000    // window to wait for posture after impact (was 4000ms)

// ─── ANTI-FALSE-POSITIVE: Pre-fall activity filter ──────────
// Trigger strict mode (higher impact threshold) even for moderate activity.
#define PRE_MOTION_SAMPLES         30        // 300 ms at 100 Hz
#define PREFALL_HIGH_MOTION_G      0.6f      // XY RMS above this = active  (was 1.0g)
#define IMPACT_STRICT_THRESHOLD_G  5.0f      // strict impact when active   (was 3.2g)

// Post-fall cooldown: suppress repeat alerts for 60 s
#define ALERT_COOLDOWN_MS     60000          // (was 30000 = 30 s)

// ─── Heartbeat interval ──────────────────────────────────────
#define HEARTBEAT_INTERVAL_MS  15000    // every 15 s

// ─── Sample rate ─────────────────────────────────────────────
#define SAMPLE_RATE_HZ    100           // 100 Hz polling
#define SAMPLE_PERIOD_MS  (1000 / SAMPLE_RATE_HZ)

// ============================================================
//  SHARED TYPES — declared first so Arduino's auto-prototype
//  pass can resolve all custom types before any function uses them
// ============================================================
struct Vec3f { float x, y, z; };   // 3-axis float vector

enum FallPhase {
  PHASE_IDLE,
  PHASE_FREEFALL,
  PHASE_IMPACT_WAIT,
  PHASE_POSTURE_CHECK,
  PHASE_COOLDOWN
};

FallPhase     fallPhase      = PHASE_IDLE;
unsigned long phaseEnteredMs = 0;
float         lastImpactG    = 0.0f;
bool          mpuReady       = false;
unsigned long lastAlertMs    = 0;
unsigned long lastHeartbeatMs  = 0;
unsigned long lastWiFiCheckMs  = 0;

// Pre-fall XY motion ring buffer (300 ms @ 100 Hz = 30 samples)
float   xyBuffer[PRE_MOTION_SAMPLES];
uint8_t xyHead = 0;

void xyBufferPush(float xyMag) {
  xyBuffer[xyHead] = xyMag;
  xyHead = (xyHead + 1) % PRE_MOTION_SAMPLES;
}

float xyBufferRms() {
  float sum = 0.0f;
  for (uint8_t i = 0; i < PRE_MOTION_SAMPLES; i++) sum += xyBuffer[i] * xyBuffer[i];
  return sqrt(sum / PRE_MOTION_SAMPLES);
}

const char* phaseName(FallPhase p) {
  switch (p) {
    case PHASE_IDLE:          return "IDLE";
    case PHASE_FREEFALL:      return "FREE_FALL";
    case PHASE_IMPACT_WAIT:   return "IMPACT_WAIT";
    case PHASE_POSTURE_CHECK: return "POSTURE";
    case PHASE_COOLDOWN:      return "COOLDOWN";
  }
  return "UNKNOWN";
}

// ============================================================
//  MPU6050 RAW DRIVER  (no external library needed)
// ============================================================

bool mpuInit() {
  Wire.begin(I2C_SDA, I2C_SCL);

  // Wake the device (clear sleep bit)
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_PWR_REG);
  Wire.write(0x00);
  if (Wire.endTransmission(true) != 0) {
    Serial.println(F("[MPU] ERROR: No ACK on PWR_MGMT_1 — check wiring"));
    return false;
  }
  delay(100);

  // Verify WHOAMI (0x68 expected; some clones return 0x72/0x70)
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)1, (uint8_t)1); // cast all 3 → removes ESP8266 ambiguity
  uint8_t whoami = Wire.available() ? Wire.read() : 0xFF;
  if (whoami != 0x68 && whoami != 0x72 && whoami != 0x70) {
    Serial.printf("[MPU] WARN: unexpected WHOAMI=0x%02X (expected 0x68) — proceeding\n", whoami);
  }

  // Sample rate divider: 1 kHz / (1+9) = 100 Hz
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_SMPLRT_DIV); Wire.write(9);
  Wire.endTransmission(true);

  // DLPF: bandwidth ~21 Hz (smooth, ideal for fall detection)
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_CONFIG_REG); Wire.write(0x04);
  Wire.endTransmission(true);

  // Accel config: ±4g range (AFS_SEL=1)
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_ACCEL_CONFIG); Wire.write(0x08);
  Wire.endTransmission(true);

  // Gyro config: ±500 °/s (FS_SEL=1) — not used for fall logic, just quietens noise
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_GYRO_CONFIG); Wire.write(0x08);
  Wire.endTransmission(true);

  Serial.println(F("[MPU] MPU6050 ready — 100 Hz, ±4g range"));
  return true;
}

Vec3f mpuReadAccel() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(MPU_ACCEL_REG);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (uint8_t)1); // cast all 3 → removes ESP8266 ambiguity

  int16_t ax = ((int16_t)Wire.read() << 8) | Wire.read();
  int16_t ay = ((int16_t)Wire.read() << 8) | Wire.read();
  int16_t az = ((int16_t)Wire.read() << 8) | Wire.read();

  return { ax / ACCEL_SCALE_4G, ay / ACCEL_SCALE_4G, az / ACCEL_SCALE_4G };
}

// ============================================================
//  WIFI  &  HTTP  (ESP8266 style)
// ============================================================
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print(F("[WiFi] Connecting"));
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500); Serial.print('.'); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected  IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("\n[WiFi] Could not connect — will retry in loop"));
  }
}

void checkWiFi() {
  if (millis() - lastWiFiCheckMs > WIFI_RETRY_MS) {
    lastWiFiCheckMs = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println(F("[WiFi] Reconnecting..."));
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }
}

// ── POST helper (ESP8266 requires WiFiClient) ────────────────
void httpPost(const char* url, const String& json) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[HTTP] Offline — skipping POST"));
    return;
  }
  WiFiClient client;          // <-- Required on ESP8266
  HTTPClient http;
  http.begin(client, url);    // ESP8266 API: begin(client, url)
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  int code = http.POST(json);
  Serial.printf("[HTTP] POST %s → HTTP %d\n", url, code);
  http.end();
}

// ── Send fall event to dashboard server ─────────────────────
void postFallEvent(float confidence, float impactG) {
  String json = "{";
  json += "\"event\":\"FALL_DETECTED\"";
  json += ",\"source\":\"bracelet\"";
  json += ",\"deviceId\":\"esp8266-fall-bracelet-01\"";
  json += ",\"location\":\"Wrist Bracelet\"";
  json += ",\"confidence\":" + String(confidence, 3);
  json += ",\"impact_g\":" + String(impactG, 2);
  json += ",\"is_fall\":true";
  json += "}";
  httpPost(FALL_EVENT_URL, json);
}

// ── Send periodic heartbeat (keeps device "online" in dashboard) ─
void postHeartbeat() {
  String json = "{";
  json += "\"deviceId\":\"esp8266-fall-bracelet-01\"";
  json += ",\"fallPhase\":\"" + String(phaseName(fallPhase)) + "\"";
  json += ",\"uptime\":" + String(millis() / 1000);
  json += "}";
  httpPost(HEARTBEAT_URL, json);
}

// ============================================================
//  FALL DETECTION STATE MACHINE  (called at 100 Hz)
// ============================================================
void processFall(Vec3f a, unsigned long nowMs) {

  float totalG = sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
  float xyG    = sqrt(a.x*a.x + a.y*a.y);

  // Always update pre-fall motion buffer
  xyBufferPush(xyG);

  switch (fallPhase) {

    // ── IDLE: watching for free-fall ──────────────────────
    case PHASE_IDLE: {
      if (totalG < FF_THRESHOLD_G) {
        fallPhase      = PHASE_FREEFALL;
        phaseEnteredMs = nowMs;
        Serial.printf("[FALL] FREE-FALL start  totalG=%.2f\n", totalG);
      }
      break;
    }

    // ── FREEFALL: confirm it's real, not a micro-bump ─────
    case PHASE_FREEFALL: {
      unsigned long elapsed = nowMs - phaseEnteredMs;

      if (totalG >= FF_THRESHOLD_G + 0.15f) {
        // G is restored
        if (elapsed < FF_MIN_DURATION_MS) {
          // Too short → arm bump / noise, abort
          Serial.printf("[FALL] FF abort (too short %lums)\n", elapsed);
          fallPhase = PHASE_IDLE;
        } else if (elapsed <= FF_MAX_DURATION_MS) {
          // Valid free-fall duration → wait for impact
          Serial.printf("[FALL] FF confirmed  %lums → waiting IMPACT\n", elapsed);
          fallPhase      = PHASE_IMPACT_WAIT;
          phaseEnteredMs = nowMs;
        } else {
          // Too long → slow arm lowering, not a fall
          Serial.println(F("[FALL] FF abort (too long — slow arm movement)"));
          fallPhase = PHASE_IDLE;
        }
      } else if (elapsed > FF_MAX_DURATION_MS) {
        Serial.println(F("[FALL] FF abort (exceeded max duration)"));
        fallPhase = PHASE_IDLE;
      }
      break;
    }

    // ── IMPACT_WAIT: look for hard G-spike ────────────────
    case PHASE_IMPACT_WAIT: {
      unsigned long elapsed = nowMs - phaseEnteredMs;

      // Use stricter threshold if the person was very active before the fall
      float xyRms = xyBufferRms();
      bool  highActivity = (xyRms > PREFALL_HIGH_MOTION_G);
      float impactThresh = highActivity ? IMPACT_STRICT_THRESHOLD_G : IMPACT_THRESHOLD_G;

      if (highActivity) {
        Serial.printf("[FALL] High pre-activity (xyRMS=%.2f) → strict thresh=%.1fg\n",
                      xyRms, impactThresh);
      }

      if (totalG >= impactThresh) {
        lastImpactG    = totalG;
        Serial.printf("[FALL] IMPACT  G=%.2f → waiting POSTURE\n", totalG);
        fallPhase      = PHASE_POSTURE_CHECK;
        phaseEnteredMs = nowMs;
      } else if (elapsed > IMPACT_WINDOW_MS) {
        // No impact → person just bent over quickly, not a fall
        Serial.printf("[FALL] No impact in %dms → ABORT\n", IMPACT_WINDOW_MS);
        fallPhase = PHASE_IDLE;
      }
      break;
    }

    // ── POSTURE_CHECK: arm must stay CONTINUOUSLY horizontal ───
    case PHASE_POSTURE_CHECK: {
      unsigned long windowElapsed = nowMs - phaseEnteredMs;
      float absZ = fabs(a.z);
      float totalGNow = sqrt(a.x*a.x + a.y*a.y + a.z*a.z);

      // BUG FIX 1: Track CONTINUOUS horizontal time separately.
      // Any arm movement above threshold resets the continuous timer to 0.
      // The full POSTURE_CONFIRM_MS must be uninterrupted.
      static unsigned long postureStartMs = 0;

      bool isHorizontal = (absZ < POSTURE_Z_MAX_G) && (totalGNow < 1.20f);
      // totalGNow < 1.20g: also ensures person is mostly still (not flailing)

      if (isHorizontal) {
        if (postureStartMs == 0) {
          postureStartMs = nowMs;   // start the continuous timer
        }
        unsigned long continuousMs = nowMs - postureStartMs;

        if (continuousMs >= POSTURE_CONFIRM_MS) {
          // ───────────────────────────────────────────────
          //  🚨 CONFIRMED FALL
          // ───────────────────────────────────────────────
          float confidence = 0.90f;
          if      (lastImpactG >= 3.5f) confidence = 0.97f;
          else if (lastImpactG >= 2.8f) confidence = 0.94f;

          Serial.printf("\n*** FALL CONFIRMED  impact=%.2fg  posture=%lums  conf=%.0f%% ***\n\n",
                        lastImpactG, continuousMs, confidence * 100.0f);

          postFallEvent(confidence, lastImpactG);
          lastAlertMs    = nowMs;
          postureStartMs = 0;       // reset for next time
          fallPhase      = PHASE_COOLDOWN;
          phaseEnteredMs = nowMs;
        }
      } else {
        // BUG FIX 2: Any break in horizontal posture resets the continuous timer immediately.
        // No grace period — if arm moves, the clock resets to zero.
        if (postureStartMs != 0) {
          Serial.printf("[FALL] Posture broke (absZ=%.2f G=%.2f) — resetting timer\n", absZ, totalGNow);
          postureStartMs = 0;
        }
      }

      // If the full window passed without achieving 3s continuous posture → abort
      if (windowElapsed > POSTURE_WINDOW_MS && fallPhase == PHASE_POSTURE_CHECK) {
        Serial.println(F("[FALL] Posture window expired — no 3s continuous posture → ABORT"));
        postureStartMs = 0;
        fallPhase = PHASE_IDLE;
      }
      break;
    }

    // ── COOLDOWN: suppress duplicates; stay until person actually stands up ─
    case PHASE_COOLDOWN: {
      if (nowMs - phaseEnteredMs >= ALERT_COOLDOWN_MS) {
        // BUG FIX 3: Don’t return to IDLE if person is still lying down.
        // totalG near 1g AND absZ near 0 means still horizontal on ground.
        float gNow  = sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
        float azNow = fabs(a.z);
        bool  stillLying = (azNow < POSTURE_Z_MAX_G) && (gNow < 1.20f);

        if (!stillLying) {
          Serial.println(F("[FALL] Cooldown done — person upright → IDLE"));
          fallPhase = PHASE_IDLE;
        }
        // else stay in COOLDOWN silently until person gets up
      }
      break;
    }
  }
}

// ============================================================
//  SETUP  &  LOOP
// ============================================================
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);

  Serial.println();
  Serial.println(F("╔══════════════════════════════════════════╗"));
  Serial.println(F("║  ElderCare — Wrist Fall Detector         ║"));
  Serial.println(F("║  NodeMCU ESP8266 + MPU6050               ║"));
  Serial.println(F("║  Algorithm: Free-fall → Impact → Posture ║"));
  Serial.println(F("╚══════════════════════════════════════════╝"));

  mpuReady = mpuInit();
  if (!mpuReady) {
    Serial.println(F("[FATAL] MPU6050 not found! Check D2(SDA)/D1(SCL). Halting."));
    while (true) { delay(1000); }
  }

  memset(xyBuffer, 0, sizeof(xyBuffer));

  initWiFi();

  Serial.println(F("[MAIN] System ready — monitoring at 100 Hz"));
  Serial.printf("[MAIN] Fall events → " FALL_EVENT_URL "\n");
}

void loop() {
  unsigned long nowMs = millis();
  static unsigned long lastSampleMs = 0;

  // ── Enforce 100 Hz sample rate ───────────────────────────
  if (nowMs - lastSampleMs < SAMPLE_PERIOD_MS) {
    yield();   // yield() is important on ESP8266 to feed the watchdog
    return;
  }
  lastSampleMs = nowMs;

  // ── Read accelerometer ───────────────────────────────────
  Vec3f accel = mpuReadAccel();

  // ── Run fall state machine ───────────────────────────────
  processFall(accel, nowMs);

  // ── Periodic WiFi reconnect ──────────────────────────────
  checkWiFi();

  // ── Heartbeat every 15 s ─────────────────────────────────
  if (nowMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = nowMs;
    postHeartbeat();

    float totalG = sqrt(accel.x*accel.x + accel.y*accel.y + accel.z*accel.z);
    Serial.printf("[HB] phase=%-12s  totalG=%.2f  WiFi=%s\n",
                  phaseName(fallPhase), totalG,
                  WiFi.status() == WL_CONNECTED ? "OK" : "OFFLINE");
  }
}
