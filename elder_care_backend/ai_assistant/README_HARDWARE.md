# ElderCare AI Voice Assistant — Hardware Guide

## Your Hardware
| # | Component | Role |
|---|---|---|
| 1 | ESP32-S3 Dev Module | Controller |
| 2 | INMP441 | I2S Digital Microphone |
| 3 | MAX98357 | I2S Audio Amplifier |
| 4 | Speaker 4W 4Ω | Audio output |
| 5 | SSD1306 OLED 0.96" (128×64) | Status display |

---

## Two AI Systems — How They Coexist

### System A: ESP32-S3 Hardware (Physical Device)
- **File**: `D:\Elder--Care\hardware\voice_assistant\voice_assistant.ino`
- **What it does**: Physical voice assistant device near the elder
  - Press BOOT button → speak a question
  - INMP441 records 4 seconds of audio
  - Sends WAV to dashboard server → Local AI (Whisper + Ollama) answers
  - MAX98357 + Speaker plays the response
  - OLED shows: IDLE / LISTENING / THINKING / SPEAKING

### System B: Python Assistant on PC
- **File**: `D:\Elder--Care\ai_assistant\main_assistant.py`
- **What it does**: Richer PC-based assistant with:
  - Ollama LLM (offline AI)
  - Medicine reminders and scheduling
  - Health symptom detection
  - Weather and news
  - Persistent chat memory

---

## Wiring Table

### INMP441 Microphone → ESP32-S3
| INMP441 Pin | ESP32-S3 GPIO | Notes |
|---|---|---|
| VDD | 3.3V | |
| GND | GND | |
| WS | GPIO 15 | Word Select |
| SCK | GPIO 16 | Serial Clock |
| SD | GPIO 17 | Serial Data |
| L/R | GND | Left channel |

### MAX98357 Amplifier → ESP32-S3
| MAX98357 Pin | ESP32-S3 GPIO | Notes |
|---|---|---|
| VIN | **5V** ← Must be 5V | |
| GND | GND | |
| LRC | GPIO 5 | Left/Right Clock |
| BCLK | GPIO 6 | Bit Clock |
| DIN | GPIO 7 | Data In |
| GAIN | Float | 9dB (leave unconnected) |

### Speaker → MAX98357
| Speaker | MAX98357 |
|---|---|
| + (red) | OUT+ |
| - (black) | OUT- |

### SSD1306 OLED → ESP32-S3
| OLED Pin | ESP32-S3 GPIO | Notes |
|---|---|---|
| VCC | 3.3V | |
| GND | GND | |
| SDA | GPIO 8 | I2C Data |
| SCL | GPIO 9 | I2C Clock |
| Address | — | 0x3C |

---

## Libraries to Install (Arduino IDE)
1. **Adafruit SSD1306** — by Adafruit
2. **Adafruit GFX Library** — by Adafruit
3. **ArduinoJson** — by Benoit Blanchon (v6.x)

---

## Configuration (edit before flashing)
Open `hardware/voice_assistant/voice_assistant.ino` and change:
```cpp
#define WIFI_SSID       "YourWiFiSSID"
#define WIFI_PASSWORD   "YourWiFiPassword"
#define SERVER_IP       "192.168.X.X"   // PC IP from ipconfig
```

## Board Settings (Arduino IDE)
- **Board**: ESP32S3 Dev Module
- **USB CDC On Boot**: Enabled
- **Flash Size**: 4MB
- **Port**: Your COM port

---

## How It Works (Data Flow)
```
[Press BOOT button]
       ↓
INMP441 records 4s audio
       ↓
WAV bytes → POST /api/voice-assistant/audio (port 5050)
       ↓
Node server → Local Ollama → text response
       ↓
{ reply: "..." } → ESP32-S3
       ↓
Google TTS → MP3 audio → MAX98357 → Speaker
       ↓
OLED shows "IDLE" again
```

## Dashboard Integration
- Dashboard shows **ESP32 ONLINE/OFFLINE** badge (heartbeat every 10s)
- Last spoken query appears in the voice assistant panel
- All powered by SSE (`voice_assistant_heartbeat`, `voice_assistant_query` events)
