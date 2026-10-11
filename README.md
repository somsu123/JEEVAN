# JEEVAN (Joint Elderly Evaluation Vital Assistance Network)

[![Platform](https://img.shields.io/badge/Platform-Node.js%20%7C%20Python%20%7C%20ESP32-blue.svg)](https://github.com/somsu123/JEEVAN)
[![Frontend](https://img.shields.io/badge/Frontend-React%2019%20%7C%20Vite%20%7C%20TailwindCSS-61dafb.svg)](https://github.com/somsu123/JEEVAN)
[![Backend](https://img.shields.io/badge/Backend-Flask%20%7C%20Express%20%7C%20WebSocket-success.svg)](https://github.com/somsu123/JEEVAN)
[![Database](https://img.shields.io/badge/Database-MongoDB-47A248.svg)](https://github.com/somsu123/JEEVAN)
[![AI/ML](https://img.shields.io/badge/AI-MediaPipe%20%7C%20Whisper%20%7C%20Ollama-orange.svg)](https://github.com/somsu123/JEEVAN)

**JEEVAN (Joint Elderly Evaluation Vital Assistance Network)** is a comprehensive 360° IoT and Edge-AI assistive healthcare ecosystem engineered for real-time elderly well-being monitoring, automated medication management, multi-sensor fall detection, continuous vitals telemetry, and conversational AI assistance.

Designed with privacy-first edge computing and seamless multi-device synchronization, JEEVAN bridges wearable ESP32 microcontrollers, computer-vision edge nodes, and a modern real-time caregiver dashboard into a unified, life-saving healthcare network.

---

## 🌟 Key Features

### 1. 🖥️ Real-Time 360° Caregiver Dashboard (`dashboard-v2`)
- **Modern Responsive UI**: Built with React 19, TypeScript, and Tailwind CSS v4.
- **Live Vitals Monitor**: 60-second real-time BPM sparkline synced with ESP32 wrist telemetry.
- **Fall Alert Center**: Interactive chronological timeline with confidence scores, posture detection metadata, and immediate emergency SOS triggers.
- **Smart Medication Tracker**: Visual 4-slot medicine status, next-dose countdown timers, and remote schedule programming.
- **Local AI Medical Scanner**: Prescription & clinical report OCR and analysis using Ollama Vision.
- **Server-Sent Events (SSE)**: Sub-second bi-directional telemetry streaming on port `5050`.

### 2. 🚨 Dual Fall Detection Architecture
- **AI Vision-Based Fall Detector**:
  - MediaPipe Pose skeleton tracking running locally via USB webcam (`webcam_fall_detector.py`) or Raspberry Pi (`hardware/elder care fall/fall_detector.py`).
  - Analyzes vertical-to-horizontal torso angles, bounding box aspect ratios, and downward velocity.
  - **100% Privacy-Preserving**: Video frames never leave the local machine; only lightweight event metadata and confidence ratings are transmitted.
- **Wearable Smart Fall Bracelet (ESP32)**:
  - MPU6050 6-axis accelerometer & gyroscope running dedicated firmware (`firmware/fall_bracelet/`).
  - Detects free-fall acceleration, high-impact collision thresholds, and subsequent inactivity.
  - Triggers local buzzer/LED alarm and immediately dispatches emergency HTTP alerts over Wi-Fi.

### 3. 💊 Smart Medicine Box (`firmware/medicine_box/`)
- **Proximity-Gated Lid Actuation**: Ultrasonic sensor (HC-SR04) detects patient approach (15–20 cm) during scheduled dosage windows and commands an SG90 servo to open the lid (`90°`).
- **Slot LED Guidance**: Dedicated visual LEDs for compartments 0–3 guiding the patient to the exact compartment.
- **Intake Confirmation**: Physical push-button records medicine intake, closes the servo lid (`0°`), and sends a `DOSE_TAKEN` confirmation event to the backend.
- **16x2 I2C LCD**: Shows live Indian Standard Time (IST), scheduled dose notifications, and Wi-Fi connection diagnostics.

### 4. 💓 Continuous Vitals Telemetry (`bpm-server` & `firmware/bpm_bracelet/`)
- ESP32 + MAX30102 PPG optical pulse oximeter sampling at 400 Hz.
- Peak detection algorithm calculating filtered Heart Rate (BPM) and IR reflectance.
- Low-latency WebSocket streaming (`ws://<IP>:3001/ws/esp32`) into a Node.js ring buffer, broadcasting directly to the live dashboard.

### 5. 🎙️ AI Voice Assistant — MITRA
- Offline voice assistant powered by local Whisper speech-to-text and Ollama LLM.
- Responds to elder vocal queries about health status, upcoming medication schedules, and daily reminders.
- Supports both PC-hosted audio mode and dedicated ESP32-S3 hardware module (INMP441 I2S microphone + MAX98357 I2S amplifier + SSD1306 OLED display).

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│            JEEVAN (Joint Elderly Evaluation Vital Assistance Network)           │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
┌───────▼──────────────────────┐ ┌───────▼──────────────────────┐ ┌───────▼──────────────────────┐
│     IoT Hardware & Edge      │ │       Backend Services       │ │     Caregiver Interface      │
├──────────────────────────────┤ ├──────────────────────────────┤ ├──────────────────────────────┤
│ • ESP32 Smart Medicine Box   │ │ • Flask REST API (Port 5000) │ │ • React 19 + Vite Dashboard │
│ • ESP32 Fall Bracelet        │ │ • Vitals WS (Port 3001)      │ │ • Express Bridge (Port 5050) │
│ • ESP32 BPM Vital Bracelet   │ │ • MongoDB ('JEEVAN')         │ │ • Real-time SSE Stream       │
│ • AI Pose Webcam Fall Cam    │ │ • Local Whisper / Ollama     │ │ • Email & SMS Emergency SOS  │
│ • ESP32-S3 Hardware Voice AI │ │ • Medication Scheduler       │ │ • Clinical Report Scanner    │
└──────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────────┘
```

---

## 📁 Repository Structure

```
JEEVAN/
├── README.md                          # Main project documentation
├── start_system.bat                   # 1-click startup launcher for all services
├── start_fall_camera.bat              # Standalone launcher for AI webcam detector
├── start_testing.bat                  # Developer testing environment launcher
├── flash_medbox.bat                   # Fast flash helper for ESP32 medicine box
├── flash_fall_bracelet.bat            # Fast flash helper for ESP32 fall bracelet
├── flash_esp32.bat                    # Fast flash helper for ESP32 BPM bracelet
├── requirements.txt                   # Central Python dependencies
│
├── dashboard-v2/                      # Unified Caregiver Dashboard
│   ├── src/                           # React 19 TypeScript application
│   ├── server.ts                      # Node.js / Express proxy bridge & SSE server (Port 5050)
│   ├── package.json                   # Dashboard dependencies
│   └── README.md                      # Dashboard-specific guide
│
├── backend/                           # Central REST API & Database Layer
│   ├── app.py                         # Flask application (Port 5000)
│   ├── database.py                    # MongoDB driver & collection interfaces
│   ├── whisper_sidecar.py             # Audio transcription sidecar service
│   └── clear_mongo.py                 # Database maintenance & wipe utility
│
├── bpm-server/                        # Real-Time Vitals WebSocket Engine
│   ├── server.js                      # High-throughput Node.js WS server (Port 3001)
│   ├── bpmStore.js                    # In-memory vitals ring buffer & statistics
│   └── validation.js                  # ESP32 sensor payload validation
│
├── firmware/                          # Microcontroller Source Code (ESP32)
│   ├── medicine_box/                  # Smart Medicine Box Arduino sketch & docs
│   │   ├── medicine_box.ino
│   │   └── README.md
│   ├── fall_bracelet/                 # MPU6050 Fall Detection Bracelet sketch
│   │   └── fall_bracelet.ino
│   └── bpm_bracelet/                  # MAX30102 Heart-Rate Bracelet sketch
│       └── bpm_bracelet.ino
│
├── ai_assistant/                      # Conversational Voice Assistant
│   ├── main_assistant.py              # MITRA voice AI processing pipeline
│   └── README_HARDWARE.md             # ESP32-S3 audio module hardware guide
│
├── hardware/                          # Hardware schematics, guides & edge code
│   ├── elder care fall/               # Raspberry Pi MediaPipe fall detector
│   │   ├── fall_detector.py
│   │   └── fall_log_schema.md
│   └── voice_assistant/               # ESP32-S3 firmware sketch
│       └── voice_assistant.ino
│
└── webcam_fall_detector.py            # Local PC USB AI vision fall tracker HUD
```

---

## 🛠️ Prerequisites & Installation

### 1. System Requirements
- **Operating System**: Windows 10/11, Ubuntu 22.04+, or macOS
- **Python**: **Python 3.11** (strictly required for `pyttsx3`, `mediapipe`, and speech dependencies)
- **Node.js**: **v18.0.0 or higher**
- **MongoDB**: [MongoDB Community Edition](https://www.mongodb.com/try/download/community) running locally on port `27017` or MongoDB Atlas URI

### 2. Environment Setup

#### Clone the Repository:
```bash
git clone https://github.com/somsu123/JEEVAN.git
cd JEEVAN
```

#### Install Python Dependencies:
```powershell
py -3.11 -m pip install -r requirements.txt
```

#### Install Node.js Dependencies:
```powershell
# Install dashboard dependencies
cd dashboard-v2
npm install
cd ..

# Install BPM WebSocket server dependencies
cd bpm-server
npm install
cd ..
```

#### Configure Environment:
Ensure `dashboard-v2/.env` is configured with your network IP and caregiver notification settings:
```env
PORT=5050
FLASK_BACKEND_URL=http://localhost:5000
VITE_WS_URL=ws://localhost:3001
CAREGIVER_EMAIL=caregiver@example.com
GMAIL_USER=your_gmail@gmail.com
GMAIL_APP_PASSWORD=your_16_char_app_password
```

---

## 🚀 Running the System

### 1-Click Startup (Recommended)
Simply double-click [`start_system.bat`](start_system.bat) or run from PowerShell:

```powershell
.\start_system.bat
```

This starts 4 coordinated background services:
1. **Central Flask REST API** → `http://localhost:5000`
2. **BPM Vitals WebSocket Server** → `ws://localhost:3001`
3. **JEEVAN Dashboard & Bridge** → `http://localhost:5050`
4. **AI Vision Fall Detection HUD** → Live camera pose tracking window

### Manual Startup (Individual Modules)

If running services individually across terminals:

```powershell
# Terminal 1: Backend REST API
py -3.11 backend\app.py

# Terminal 2: Vitals WebSocket Server
cd bpm-server && node server.js

# Terminal 3: Caregiver Dashboard
cd dashboard-v2 && npm run dev

# Terminal 4: AI Fall Detection Camera
py -3.11 webcam_fall_detector.py
```

---

## 🔌 Hardware Modules & Pinout Reference

### Smart Medicine Box (ESP32)
| Component | ESP32 GPIO | Description |
|---|---|---|
| **I2C SDA** | `GPIO 21` | 16x2 LCD SDA (Address `0x27`) |
| **I2C SCL** | `GPIO 22` | 16x2 LCD SCL |
| **HC-SR04 Trig** | `GPIO 5` | Ultrasonic trigger pulse |
| **HC-SR04 Echo** | `GPIO 18` | Ultrasonic echo input |
| **Intake Button** | `GPIO 4` | Dose confirmation push button (`INPUT_PULLUP`) |
| **Servo Motor** | `GPIO 13` | SG90 lid actuation (0° closed, 90° open) |
| **Compartment LEDs** | `GPIO 27, 26, 25, 33` | LEDs for Compartments 0, 1, 2, 3 |
| **Status LED** | `GPIO 2` | Onboard network status LED |

### Wearable Fall Bracelet (ESP32)
| Component | ESP32 GPIO | Description |
|---|---|---|
| **MPU6050 SDA** | `GPIO 21` | 6-axis IMU I2C Data |
| **MPU6050 SCL** | `GPIO 22` | 6-axis IMU I2C Clock |
| **Alarm Buzzer** | `GPIO 19` | Emergency audible alarm |
| **Alert LED** | `GPIO 23` | High-visibility fall alert strobe |
| **Cancel Button** | `GPIO 18` | False-positive cancel button |

### BPM Vitals Bracelet (ESP32)
| Component | ESP32 GPIO | Description |
|---|---|---|
| **MAX30102 SDA** | `GPIO 21` | Pulse oximeter I2C Data |
| **MAX30102 SCL** | `GPIO 22` | Pulse oximeter I2C Clock |
| **VIN / GND** | `3.3V / GND` | Dedicated 3.3V power supply |

---

## 🌐 API & Communication Endpoints

### Central Flask REST API (`http://localhost:5000`)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/state` | Returns consolidated system state (vitals, medbox, falls) |
| `POST` | `/api/fall` | Ingests fall detection events from camera or wearable |
| `POST` | `/api/heartrate` | Ingests ESP32 heart rate (BPM) telemetry |
| `POST` | `/api/medicine` | Updates medicine box lid & reminder states |
| `GET` | `/api/schedule` | Retrieves patient medication dispensing schedule |
| `POST` | `/api/schedule` | Pushes updated medication schedule |
| `GET` | `/api/medicines` | Lists configured medications & dosages |
| `POST` | `/api/reports/save` | Stores scanned prescription analysis |

### Vitals WebSocket Server (`ws://localhost:3001`)
- **`ws://<SERVER_IP>:3001/ws/esp32`**: Ingests JSON telemetry packets from the MAX30102 bracelet:
  ```json
  {
    "deviceId": "ESP32_BPM_01",
    "bpm": 74,
    "confidence": 95,
    "irValue": 52000,
    "timestamp": 1728638400000
  }
  ```

---

## 🔧 Troubleshooting

- **`ModuleNotFoundError: No module named 'pymongo'`**: Ensure you are running under Python 3.11 (`py -3.11`).
- **Dashboard Telemetry Not Updating**: Verify MongoDB is running locally on port `27017` and that the `JEEVAN` database is active.
- **Hardware Cannot Connect to Wi-Fi**: Confirm that the ESP32 firmware SSID matches your local 2.4 GHz Wi-Fi network and that the computer's firewall permits inbound connections on ports `5000`, `3001`, and `5050`.

---

## 📄 License & Attribution

This project is open-source under the **MIT License**.

Developed for **JEEVAN (Joint Elderly Evaluation Vital Assistance Network)**. Dedicated to empowering independent living and caregiver peace of mind through compassionate IoT and AI engineering.
