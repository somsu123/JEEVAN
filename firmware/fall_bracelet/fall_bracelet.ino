#include <Wire.h>
#include <math.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <UniversalTelegramBot.h>
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>

// ---- Fill these in ----
#define WIFI_SSID   "ElderCare"
#define WIFI_PASS    "ami bolbona"
#define BOT_TOKEN   "YOUR_BOT_TOKEN"
#define CHAT_ID     "YOUR_CHAT_ID"

WiFiClientSecure secured_client;
UniversalTelegramBot bot(BOT_TOKEN, secured_client);

// ---- Pins ----
#define SDA_PIN 6
#define SCL_PIN 7
#define MPU_ADDR 0x68
#define BUZZER_PIN 4
#define BUTTON_PIN 2
#define GPS_RX_PIN 17
#define GPS_TX_PIN 16

HardwareSerial GPSSerial(1);
TinyGPSPlus gps;

// ---- Detection thresholds ----
#define FREEFALL_G 0.75
#define IMPACT_G 3.00
#define TILT_ANGLE 35.0
#define STILL_MOTION_DPS 15.0
#define STILL_TIME_MS 5000
#define SAMPLE_INTERVAL 20

enum State { NORMAL, FREE_FALL, IMPACT, FALL_CONFIRMED };
State state = NORMAL;

unsigned long freeFallStart = 0, impactStart = 0, stillStart = 0, lastSample = 0;
float refPitch = 0, refRoll = 0;
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
bool alertSent = false;
double lastLat = 0, lastLng = 0;
bool haveFix = false;

void setup()
{
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Wake up MPU6050
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0);
  Wire.endTransmission();

  calibrateGyro();
  captureReference();

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" connected!");
  secured_client.setInsecure();

  Serial.println("Ready.");
}

void loop()
{
  // Read GPS continuously
  while (GPSSerial.available())
  {
    gps.encode(GPSSerial.read());
  }
  if (gps.location.isValid())
  {
    lastLat = gps.location.lat();
    lastLng = gps.location.lng();
    haveFix = true;
  }

  // Manual SOS button
  if (digitalRead(BUTTON_PIN) == LOW)
  {
    delay(50); // simple debounce
    if (digitalRead(BUTTON_PIN) == LOW)
    {
      soundBuzzer(true);
      sendAlert("MANUAL DISTRESS BUTTON");
      delay(2000);
      soundBuzzer(false);
    }
  }

  // Sample MPU at a fixed rate
  unsigned long now = millis();
  if (now - lastSample >= SAMPLE_INTERVAL)
  {
    lastSample = now;
    runDetection(now);
  }
}

void runDetection(unsigned long now)
{
  float ax, ay, az, gx, gy, gz;
  readMPU(ax, ay, az, gx, gy, gz);

  float accel = sqrt(ax * ax + ay * ay + az * az);
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  float roll  = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
  float motionDps = fabs(gx) + fabs(gy) + fabs(gz);

  switch (state)
  {
    case NORMAL:
      if (accel < FREEFALL_G)
      {
        state = FREE_FALL;
        freeFallStart = now;
        Serial.println("-> FREE_FALL");
      }
      break;

    case FREE_FALL:
      if (accel > IMPACT_G)
      {
        state = IMPACT;
        impactStart = now;
        stillStart = 0;
        Serial.println("-> IMPACT");
      }
      else if (now - freeFallStart > 700)
      {
        state = NORMAL; // no impact followed, false alarm
      }
      break;

    case IMPACT:
      if (now - impactStart < 400) return; // let tumbling settle first

      if (fabs(pitch - refPitch) > TILT_ANGLE || fabs(roll - refRoll) > TILT_ANGLE)
      {
        if (motionDps < STILL_MOTION_DPS)
        {
          if (stillStart == 0) stillStart = now;
          if (now - stillStart > STILL_TIME_MS)
          {
            state = FALL_CONFIRMED;
            Serial.println("### FALL DETECTED ###");
          }
        }
        else
        {
          stillStart = 0; // moved again, reset the wait
        }
      }
      else
      {
        state = NORMAL; // orientation didn't really change, false alarm
      }
      break;

    case FALL_CONFIRMED:
      if (!alertSent)
      {
        soundBuzzer(true);
        sendAlert("FALL DETECTED");
        alertSent = true;
      }
      if (motionDps > 60.0) // person moved - recovered
      {
        state = NORMAL;
        alertSent = false;
        soundBuzzer(false);
      }
      break;
  }
}

void readMPU(float &ax, float &ay, float &az, float &gx, float &gy, float &gz)
{
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 14);

  int16_t rawAx = Wire.read() << 8 | Wire.read();
  int16_t rawAy = Wire.read() << 8 | Wire.read();
  int16_t rawAz = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read(); // skip temperature
  int16_t rawGx = Wire.read() << 8 | Wire.read();
  int16_t rawGy = Wire.read() << 8 | Wire.read();
  int16_t rawGz = Wire.read() << 8 | Wire.read();

  ax = rawAx / 16384.0;
  ay = rawAy / 16384.0;
  az = rawAz / 16384.0;
  gx = (rawGx - gyroBiasX) / 131.0;
  gy = (rawGy - gyroBiasY) / 131.0;
  gz = (rawGz - gyroBiasZ) / 131.0;
}

void calibrateGyro()
{
  long sx = 0, sy = 0, sz = 0;
  for (int i = 0; i < 200; i++)
  {
    Wire.beginTransmission(MPU_ADDR);
    Wire.write(0x43);
    Wire.endTransmission(false);
    Wire.requestFrom(MPU_ADDR, 6);
    sx += Wire.read() << 8 | Wire.read();
    sy += Wire.read() << 8 | Wire.read();
    sz += Wire.read() << 8 | Wire.read();
    delay(5);
  }
  gyroBiasX = sx / 200.0;
  gyroBiasY = sy / 200.0;
  gyroBiasZ = sz / 200.0;
}

void captureReference()
{
  float ax, ay, az, gx, gy, gz;
  readMPU(ax, ay, az, gx, gy, gz);
  refPitch = atan2(ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  refRoll  = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
}

void soundBuzzer(bool on)
{
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
}

void sendAlert(const char* reason)
{
  String msg = "ALERT: " + String(reason) + "\n";
  if (haveFix)
  {
    msg += "Location: https://maps.google.com/?q=" + String(lastLat, 6) + "," + String(lastLng, 6);
  }
  else
  {
    msg += "Location: no GPS fix available.";
  }
  bot.sendMessage(CHAT_ID, msg, "");
  Serial.println("Alert sent: " + msg);
}