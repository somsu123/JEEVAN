/*
 * ============================================================
 *  ElderCare Voice Assistant — ESP32-S3 Firmware  v1.0
 * ============================================================
 *
 *  Hardware:
 *   1. ESP32-S3 Dev Module
 *   2. INMP441 I2S Digital Microphone
 *   3. MAX98357 I2S Audio Amplifier
 *   4. Speaker 4W 4Ω
 *   5. SSD1306 0.96" OLED 128×64 (I2C)
 *
 *  HOW IT WORKS:
 *   • Press BOOT button (GPIO 0) → LED blinks → speak your question
 *   • ESP32-S3 records audio via INMP441 → streams raw PCM to Node server
 *   • Node server sends audio to Gemini API → gets text response
 *   • Node server sends response text back via WebSocket
 *   • ESP32-S3 sends text to Google TTS REST → downloads MP3 → plays on speaker
 *   • OLED shows status: Idle / Listening / Thinking / Speaking
 *
 *  SIMPLIFIED FLOW (what's in this firmware):
 *   • Captures voice → sends WAV bytes to POST /api/voice-assistant/audio
 *   • Gets back { reply: "text" } → sends text to Google TTS → plays on speaker
 *   • Posts heartbeat every 10s to POST /api/voice-assistant/heartbeat
 *   • OLED shows all state transitions
 *
 *  PIN MAP:
 *  ┌────────────────────────────────────────────────────┐
 *  │  INMP441 Microphone (I2S RX)                      │
 *  │    WS   → GPIO 15   (Word Select / LRCK)          │
 *  │    SCK  → GPIO 16   (Serial Clock / BCLK)         │
 *  │    SD   → GPIO 17   (Serial Data)                 │
 *  │    VCC  → 3.3V                                    │
 *  │    GND  → GND                                     │
 *  │    L/R  → GND  (selects LEFT channel)             │
 *  ├────────────────────────────────────────────────────┤
 *  │  MAX98357 Amplifier (I2S TX)                      │
 *  │    LRC  → GPIO 5    (Word Select / LRCK)          │
 *  │    BCLK → GPIO 6    (Bit Clock)                   │
 *  │    DIN  → GPIO 7    (Data In)                     │
 *  │    VCC  → 5V  ← IMPORTANT: needs 5V not 3.3V     │
 *  │    GND  → GND                                     │
 *  │    GAIN → leave floating (9dB) or GND (6dB)       │
 *  ├────────────────────────────────────────────────────┤
 *  │  Speaker 4W 4Ω                                    │
 *  │    +  → MAX98357 OUT+                             │
 *  │    -  → MAX98357 OUT-                             │
 *  ├────────────────────────────────────────────────────┤
 *  │  SSD1306 OLED 0.96" (I2C)                        │
 *  │    SDA  → GPIO 8                                  │
 *  │    SCL  → GPIO 9                                  │
 *  │    VCC  → 3.3V                                    │
 *  │    GND  → GND                                     │
 *  │    I2C address: 0x3C                              │
 *  ├────────────────────────────────────────────────────┤
 *  │  Onboard LED                                      │
 *  │    GPIO 2 (active HIGH — built in on most boards) │
 *  └────────────────────────────────────────────────────┘
 *
 *  LIBRARIES (install via Arduino Library Manager):
 *   - Adafruit SSD1306            (by Adafruit)
 *   - Adafruit GFX Library        (by Adafruit)
 *   - ArduinoJson                 (by Benoit Blanchon, v6.x)
 *   - ESP32 I2S driver            (built-in with ESP32 Arduino core)
 *
 *  BOARD SETTINGS (Arduino IDE):
 *   Board  : ESP32S3 Dev Module
 *   USB CDC On Boot: Enabled
 *   Flash Size: 4MB
 *   PSRAM  : Disabled (unless your board has PSRAM)
 *
 *  EDIT THESE 3 LINES BEFORE FLASHING:
 *   const char* WIFI_SSID       = "YourWiFiSSID";
 *   const char* WIFI_PASSWORD   = "YourWiFiPassword";
 *   const char* SERVER_IP       = "192.168.X.X";   // ipconfig → IPv4
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <driver/i2s.h>
#include <math.h>          // sinf() — for beep fallback tone generation

// ─── User Configuration ───────────────────────────────────────────────────────
#define WIFI_SSID       "YourWiFiSSID"
#define WIFI_PASSWORD   "YourWiFiPassword"
#define SERVER_IP       "192.168.1.100"    // PC running dashboard-v2 (port 5050)
#define SERVER_PORT     5050
#define DEVICE_ID       "voice-assistant-01"

// ─── Pin Definitions ─────────────────────────────────────────────────────────
// INMP441 Microphone (I2S RX — input)
#define MIC_WS_PIN      15
#define MIC_SCK_PIN     16
#define MIC_SD_PIN      17

// MAX98357 Amplifier (I2S TX — output)
#define SPK_LRC_PIN     5
#define SPK_BCLK_PIN    6
#define SPK_DIN_PIN     7

// OLED SSD1306 (I2C)
#define OLED_SDA_PIN    8
#define OLED_SCL_PIN    9

// Onboard LED + Button
#define LED_PIN         2
#define BUTTON_PIN      0    // BOOT button — used as push-to-talk

// ─── I2S Port Assignment ──────────────────────────────────────────────────────
#define I2S_MIC_PORT    I2S_NUM_1   // microphone
#define I2S_SPK_PORT    I2S_NUM_0   // speaker

// ─── Audio Config ─────────────────────────────────────────────────────────────
#define SAMPLE_RATE     16000        // 16kHz — good quality for voice
#define RECORD_SECS     4            // seconds to record after button press
#define I2S_BUFFER_LEN  1024         // samples per DMA buffer
#define AUDIO_BUF_SIZE  (SAMPLE_RATE * RECORD_SECS * 2)  // 16-bit = 2 bytes/sample

// ─── OLED ─────────────────────────────────────────────────────────────────────
#define OLED_WIDTH      128
#define OLED_HEIGHT     64
#define OLED_ADDR       0x3C
Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

// ─── State Machine ────────────────────────────────────────────────────────────
enum VoiceState { VS_IDLE, VS_LISTENING, VS_THINKING, VS_SPEAKING, VS_ERROR };
VoiceState currentState = VS_IDLE;

const char* stateLabels[] = { "IDLE", "LISTENING...", "THINKING...", "SPEAKING", "ERROR" };

// ─── Global Buffers ───────────────────────────────────────────────────────────
int16_t* audioBuffer = nullptr;
uint32_t lastHeartbeat = 0;
uint32_t bootTime = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  OLED Display Helpers
// ─────────────────────────────────────────────────────────────────────────────
void oledClear() { oled.clearDisplay(); }

void oledState(VoiceState s) {
  oled.clearDisplay();

  // Header
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.print("ElderCare Voice AI");
  oled.drawLine(0, 10, 128, 10, SSD1306_WHITE);

  // State label (big)
  oled.setTextSize(s == VS_IDLE ? 1 : 1);
  oled.setCursor(0, 18);
  oled.print(stateLabels[s]);

  // Animated dots for listening/thinking
  if (s == VS_LISTENING || s == VS_THINKING) {
    int dots = (millis() / 500) % 4;
    for (int i = 0; i < dots; i++) oled.print(".");
  }

  // WiFi indicator
  oled.setTextSize(1);
  oled.setCursor(0, 55);
  oled.print(WiFi.status() == WL_CONNECTED ? "WiFi:OK" : "WiFi:--");
  oled.setCursor(70, 55);
  oled.print(DEVICE_ID);

  oled.display();
}

void oledMessage(const char* line1, const char* line2 = "", const char* line3 = "") {
  oled.clearDisplay();
  oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);  oled.println("ElderCare Voice AI");
  oled.drawLine(0, 10, 128, 10, SSD1306_WHITE);
  oled.setCursor(0, 16); oled.println(line1);
  oled.setCursor(0, 30); oled.println(line2);
  oled.setCursor(0, 44); oled.println(line3);
  oled.display();
}

// ─────────────────────────────────────────────────────────────────────────────
//  I2S — Microphone (INMP441)
// ─────────────────────────────────────────────────────────────────────────────
void setupMicI2S() {
  i2s_config_t cfg = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate          = SAMPLE_RATE,
    .bits_per_sample      = I2S_BITS_PER_SAMPLE_32BIT,  // INMP441 outputs 32-bit (left-justified)
    .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = 8,
    .dma_buf_len          = I2S_BUFFER_LEN,
    .use_apll             = false,
    .tx_desc_auto_clear   = false,
    .fixed_mclk           = 0,
  };
  i2s_pin_config_t pins = {
    .bck_io_num   = MIC_SCK_PIN,
    .ws_io_num    = MIC_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num  = MIC_SD_PIN,
  };
  i2s_driver_install(I2S_MIC_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_MIC_PORT, &pins);
  i2s_start(I2S_MIC_PORT);
  Serial.println("[MIC] I2S initialized");
}

// ─────────────────────────────────────────────────────────────────────────────
//  I2S — Speaker (MAX98357)
// ─────────────────────────────────────────────────────────────────────────────
void setupSpeakerI2S() {
  i2s_config_t cfg = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate          = SAMPLE_RATE,
    .bits_per_sample      = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format       = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = 8,
    .dma_buf_len          = I2S_BUFFER_LEN,
    .use_apll             = false,
    .tx_desc_auto_clear   = true,
    .fixed_mclk           = 0,
  };
  i2s_pin_config_t pins = {
    .bck_io_num   = SPK_BCLK_PIN,
    .ws_io_num    = SPK_LRC_PIN,
    .data_out_num = SPK_DIN_PIN,
    .data_in_num  = I2S_PIN_NO_CHANGE,
  };
  i2s_driver_install(I2S_SPK_PORT, &cfg, 0, NULL);
  i2s_set_pin(I2S_SPK_PORT, &pins);
  i2s_start(I2S_SPK_PORT);
  Serial.println("[SPK] I2S initialized");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Record Voice — captures RECORD_SECS seconds from INMP441
// ─────────────────────────────────────────────────────────────────────────────
size_t recordVoice() {
  size_t bytesRead = 0;
  size_t totalSamples = 0;
  const size_t readBytes = I2S_BUFFER_LEN * 4;   // 32-bit samples from INMP441
  int32_t rawBuf[I2S_BUFFER_LEN];

  Serial.println("[MIC] Recording...");
  oledState(VS_LISTENING);
  digitalWrite(LED_PIN, HIGH);

  uint32_t endTime = millis() + (RECORD_SECS * 1000);
  while (millis() < endTime && totalSamples < SAMPLE_RATE * RECORD_SECS) {
    size_t got = 0;
    i2s_read(I2S_MIC_PORT, rawBuf, readBytes, &got, portMAX_DELAY);
    size_t samplesGot = got / 4;  // 4 bytes per 32-bit sample

    for (size_t i = 0; i < samplesGot && totalSamples < (size_t)(SAMPLE_RATE * RECORD_SECS); i++) {
      // INMP441 gives data in upper 18 bits of 32-bit word — shift down to 16-bit
      audioBuffer[totalSamples++] = (int16_t)(rawBuf[i] >> 14);
    }
  }

  digitalWrite(LED_PIN, LOW);
  Serial.printf("[MIC] Recorded %d samples (%.1fs)\n", (int)totalSamples, totalSamples / (float)SAMPLE_RATE);
  return totalSamples;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WAV Header Builder — wraps raw PCM into a WAV file in memory
// ─────────────────────────────────────────────────────────────────────────────
void buildWavHeader(uint8_t* header, uint32_t dataBytes) {
  uint32_t fileSize    = dataBytes + 36;
  uint32_t byteRate    = SAMPLE_RATE * 1 * 2;   // SR * channels * bytes/sample
  uint16_t blockAlign  = 1 * 2;

  memcpy(header + 0,  "RIFF",       4);
  memcpy(header + 4,  &fileSize,    4);
  memcpy(header + 8,  "WAVE",       4);
  memcpy(header + 12, "fmt ",       4);
  uint32_t fmtSize = 16; memcpy(header + 16, &fmtSize,   4);
  uint16_t audioFmt = 1; memcpy(header + 20, &audioFmt,  2);  // PCM
  uint16_t channels = 1; memcpy(header + 22, &channels,  2);
  uint32_t sr = SAMPLE_RATE; memcpy(header + 24, &sr,    4);
  memcpy(header + 28, &byteRate,   4);
  memcpy(header + 32, &blockAlign, 2);
  uint16_t bps = 16; memcpy(header + 34, &bps,          2);
  memcpy(header + 36, "data",       4);
  memcpy(header + 40, &dataBytes,   4);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Send Audio to Server → Get AI Text Response
// ─────────────────────────────────────────────────────────────────────────────
String sendAudioAndGetReply(size_t sampleCount) {
  if (WiFi.status() != WL_CONNECTED) return "";

  uint32_t dataBytes = sampleCount * 2;   // 16-bit = 2 bytes per sample
  uint32_t wavSize   = dataBytes + 44;    // 44-byte WAV header

  uint8_t wavHeader[44];
  buildWavHeader(wavHeader, dataBytes);

  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/api/voice-assistant/audio";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "audio/wav");
  http.setTimeout(20000);   // 20s — Gemini might take a moment

  // Combine header + PCM data
  uint8_t* wavBuf = (uint8_t*)malloc(wavSize);
  if (!wavBuf) {
    Serial.println("[ERR] malloc failed for WAV buffer");
    return "";
  }
  memcpy(wavBuf, wavHeader, 44);
  memcpy(wavBuf + 44, (uint8_t*)audioBuffer, dataBytes);

  Serial.printf("[NET] Sending %d bytes WAV to server...\n", (int)wavSize);
  int httpCode = http.POST(wavBuf, wavSize);
  free(wavBuf);

  if (httpCode != 200) {
    Serial.printf("[NET] Server error: HTTP %d\n", httpCode);
    http.end();
    return "";
  }

  String responseBody = http.getString();
  http.end();

  // Parse JSON { reply: "text response" }
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, responseBody)) {
    Serial.println("[NET] JSON parse error");
    return "";
  }
  const char* reply = doc["reply"] | "";
  Serial.printf("[AI] Reply: %s\n", reply);
  return String(reply);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Text-to-Speech via server proxy → returns raw 16-bit PCM → plays on speaker
//  The Node server receives text, calls Google Cloud TTS or simple synthesis,
//  and returns raw PCM WAV bytes that we can play directly via I2S.
// ─────────────────────────────────────────────────────────────────────────────
void speakText(const String& text) {
  if (text.length() == 0) return;
  oledState(VS_SPEAKING);
  Serial.printf("[TTS] Speaking via server proxy: %s\n", text.c_str());

  // Show first 20 chars on OLED
  oledMessage("Speaking...", text.substring(0, 20).c_str(), "");

  // URL-encode the text
  String encoded = "";
  for (char c : text) {
    if (c == ' ')          encoded += '+';
    else if (isalnum(c) || c == '.' || c == ',' || c == '?' || c == '!')
                           encoded += c;
    else { encoded += '%'; encoded += String((uint8_t)c, HEX); }
  }

  // POST to server TTS proxy: returns raw 16-bit PCM at SAMPLE_RATE
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT +
               "/api/voice-assistant/tts-pcm?text=" + encoded;

  HTTPClient http;
  http.begin(url);
  http.setTimeout(15000);
  int code = http.GET();

  if (code == 200) {
    // Stream PCM data directly to I2S speaker
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buf[1024];
    int16_t i2sBuf[512];
    while (stream->available()) {
      int got = stream->readBytes(buf, sizeof(buf));
      if (got > 0) {
        // buf is already 16-bit PCM — copy to i2s buffer
        size_t written = 0;
        i2s_write(I2S_SPK_PORT, buf, got, &written, pdMS_TO_TICKS(200));
      }
    }
    Serial.println("[TTS] Playback complete");
  } else {
    Serial.printf("[TTS] Server proxy HTTP %d — playing reminder beep\n", code);
    // Fallback: play a simple 880Hz reminder beep pattern
    const int BEEP_HZ    = 880;
    const int BEEP_MS    = 200;
    const int SAMPLE_OUT = SAMPLE_RATE;
    int16_t beepBuf[256];
    for (int rep = 0; rep < 3; rep++) {
      uint32_t samples = (SAMPLE_OUT * BEEP_MS) / 1000;
      for (uint32_t s = 0; s < samples; s += 256) {
        uint32_t chunk = min((uint32_t)256, samples - s);
        for (uint32_t i = 0; i < chunk; i++) {
          beepBuf[i] = (int16_t)(15000.0f * sinf(2.0f * M_PI * BEEP_HZ * (s + i) / SAMPLE_OUT));
        }
        size_t written = 0;
        i2s_write(I2S_SPK_PORT, beepBuf, chunk * 2, &written, pdMS_TO_TICKS(200));
      }
      delay(150);
    }
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Check for pending speak commands (medicine reminders from server cron)
//  ESP32 cannot receive SSE, so it polls this endpoint every 30 seconds.
// ─────────────────────────────────────────────────────────────────────────────
void checkPendingSpeak() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (currentState != VS_IDLE) return;  // don't interrupt active session

  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT +
               "/api/voice-assistant/pending-speak";
  HTTPClient http;
  http.begin(url);
  http.setTimeout(5000);
  int code = http.GET();

  if (code == 200) {
    String body = http.getString();
    DynamicJsonDocument doc(512);
    if (!deserializeJson(doc, body)) {
      bool hasPending = doc["hasPending"] | false;
      if (hasPending) {
        const char* text = doc["text"] | "";
        if (strlen(text) > 0) {
          Serial.printf("[VA] Reminder received: %s\n", text);
          currentState = VS_SPEAKING;
          speakText(String(text));
          currentState = VS_IDLE;
          oledState(VS_IDLE);
        }
      }
    }
  }
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
//  WiFi
// ─────────────────────────────────────────────────────────────────────────────
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[WiFi] Reconnecting...");
  WiFi.reconnect();
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? "OK" : "FAILED");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Heartbeat
// ─────────────────────────────────────────────────────────────────────────────
void postHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return;
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/api/voice-assistant/heartbeat";
  const char* stateStr = stateLabels[currentState];
  String body = "{\"deviceId\":\"" + String(DEVICE_ID) + "\""
                ",\"state\":\"" + stateStr + "\""
                ",\"uptime\":" + String((millis() - bootTime) / 1000) +
                "}";
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);
  http.POST(body);
  http.end();
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  bootTime = millis();
  delay(300);
  Serial.println("\n===========================================");
  Serial.println("  ElderCare Voice Assistant — Starting");
  Serial.println("===========================================");

  // GPIO
  pinMode(LED_PIN,    OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(LED_PIN, LOW);

  // I2C for OLED
  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);

  // OLED
  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("[OLED] ERROR — Check wiring! (SDA=8, SCL=9, VCC=3.3V)");
  } else {
    Serial.println("[OLED] OK");
    oledMessage("ElderCare Voice", "Initializing...", "Please wait");
  }

  // Allocate audio buffer in SRAM
  audioBuffer = (int16_t*)malloc(AUDIO_BUF_SIZE);
  if (!audioBuffer) {
    Serial.println("[ERR] Failed to allocate audio buffer!");
    oledMessage("FATAL ERROR", "Not enough RAM", "Restart device");
    while (1) delay(1000);
  }

  // I2S setup
  setupMicI2S();
  setupSpeakerI2S();

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  oledMessage("Connecting WiFi", WIFI_SSID, "Please wait...");
  Serial.print("[WiFi] Connecting");
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    String ip = WiFi.localIP().toString();
    Serial.println("\n[WiFi] OK — " + ip);
    oledMessage("WiFi Connected!", ip.c_str(), "Press BOOT to speak");
    // 2 blinks = ready
    for (int i = 0; i < 2; i++) {
      digitalWrite(LED_PIN, HIGH); delay(300);
      digitalWrite(LED_PIN, LOW);  delay(300);
    }
  } else {
    Serial.println("\n[WiFi] Failed");
    oledMessage("WiFi FAILED", "Check SSID/Pass", "Restarting...");
    delay(3000);
    ESP.restart();
  }

  // Initial heartbeat
  postHeartbeat();

  currentState = VS_IDLE;
  oledState(VS_IDLE);
  Serial.println("[System] Ready — Press BOOT button to speak\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();

  // ── Heartbeat every 10s ───────────────────────────────────────────────────
  if (now - lastHeartbeat >= 10000) {
    lastHeartbeat = now;
    ensureWiFi();
    postHeartbeat();
  }

  static uint32_t lastPendingCheck = 0;
  if (now - lastPendingCheck >= 30000) {  // poll every 30 seconds
    lastPendingCheck = now;
    checkPendingSpeak();
  }

  // ── Update OLED every 500ms (for animated dots) ───────────────────────────
  static uint32_t lastOledUpdate = 0;
  if (now - lastOledUpdate > 500) {
    lastOledUpdate = now;
    oledState(currentState);
  }

  // ── Push-to-Talk button (BOOT = GPIO 0, active LOW) ──────────────────────
  if (digitalRead(BUTTON_PIN) == LOW && currentState == VS_IDLE) {
    delay(50);   // debounce
    if (digitalRead(BUTTON_PIN) == LOW) {
      Serial.println("[BTN] Button pressed → starting voice capture");

      // ── 1. Record voice
      currentState = VS_LISTENING;
      oledState(VS_LISTENING);
      size_t samples = recordVoice();

      if (samples < 1000) {
        Serial.println("[ERR] Recording too short — ignoring");
        currentState = VS_IDLE;
        return;
      }

      // ── 2. Send to server and get Gemini reply
      currentState = VS_THINKING;
      oledState(VS_THINKING);
      String reply = sendAudioAndGetReply(samples);

      if (reply.length() == 0) {
        oledMessage("No Response", "Try again", "");
        delay(2000);
        currentState = VS_IDLE;
        return;
      }

      // ── 3. Speak the reply
      currentState = VS_SPEAKING;
      oledMessage("Speaking...", reply.substring(0, 20).c_str(), "");
      speakText(reply);

      // ── 4. Back to idle
      currentState = VS_IDLE;
      oledState(VS_IDLE);
      Serial.println("[System] Done — ready for next query\n");

      // Post event to dashboard
      if (WiFi.status() == WL_CONNECTED) {
        String evtUrl = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/api/voice-assistant/event";
        String body = "{\"event\":\"query_complete\",\"deviceId\":\"" + String(DEVICE_ID) + "\"}";
        HTTPClient http;
        http.begin(evtUrl);
        http.addHeader("Content-Type", "application/json");
        http.setTimeout(3000);
        http.POST(body);
        http.end();
      }
    }
  }

  delay(20);
}
