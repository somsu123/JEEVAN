# BPM Smart Bracelet — Complete Setup Guide

> **Real-time WiFi Heart Rate Monitoring System**
> ESP32 + MAX30102 → Node.js Backend → React Dashboard

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Hardware Wiring](#hardware-wiring)
3. [Arduino IDE Setup](#arduino-ide-setup)
4. [ESP32 Firmware — Flash Instructions](#esp32-firmware--flash-instructions)
5. [Backend Server — Setup & Run](#backend-server--setup--run)
6. [Frontend Dashboard — Setup & Run](#frontend-dashboard--setup--run)
7. [Testing the Full System](#testing-the-full-system)
8. [How It Works — Technical Deep Dive](#how-it-works--technical-deep-dive)
9. [Troubleshooting](#troubleshooting)
10. [Battery Optimization](#battery-optimization)
11. [WiFi Optimization](#wifi-optimization)
12. [Required Libraries Summary](#required-libraries-summary)

---

## System Architecture

```
┌─────────────────────┐       WebSocket (ws://)       ┌──────────────────────┐
│                     │ ──────────────────────────────→│                      │
│   ESP32 + MAX30102  │   JSON: {bpm, irValue, ...}   │   Node.js Backend    │
│   (Smart Bracelet)  │                                │   Express + WS       │
│                     │                                │   Port 3001          │
└─────────────────────┘                                └──────────┬───────────┘
                                                                  │
                                                        Socket.IO │ (real-time)
                                                                  │
                                                       ┌──────────▼───────────┐
                                                       │                      │
                                                       │   React Dashboard    │
                                                       │   Vite + Tailwind    │
                                                       │   Port 5173          │
                                                       │                      │
                                                       └──────────────────────┘
```

**Data Flow:**
1. ESP32 reads IR data from MAX30102 every ~2.5ms (400 Hz sample rate)
2. SparkFun `checkForBeat()` detects heartbeats from IR signal
3. BPM = 60,000 ÷ (time between consecutive beats in ms)
4. 8-sample moving average smooths the output
5. Every 1 second, a JSON payload is sent over WebSocket to the backend
6. Backend validates, stores in ring buffer, and broadcasts via Socket.IO
7. Dashboard receives and renders in real time

---

## Hardware Wiring

### MAX30102 → ESP32

| MAX30102 Pin | ESP32 Pin | Wire Color (suggested) |
|:------------|:----------|:----------------------|
| VIN         | 3.3V      | Red                   |
| GND         | GND       | Black                 |
| SCL         | GPIO 22   | Yellow                |
| SDA         | GPIO 21   | Blue                  |
| INT         | Not Used  | —                     |

### Power Circuit

```
[3.7V Li-ion Battery] → [TP4056 Charging Module] → [ON/OFF Switch] → [ESP32 VIN]
                              ↑
                         [USB-C for charging]
```

> ⚠️ **Important**: Connect battery to TP4056 B+/B- pads. Connect TP4056 OUT+/OUT- through the switch to ESP32 VIN and GND.

---

## Arduino IDE Setup

### Step 1: Install Arduino IDE
Download from https://www.arduino.cc/en/software (version 2.x recommended).

### Step 2: Add ESP32 Board Support
1. Open Arduino IDE
2. Go to **File → Preferences**
3. In **Additional Board Manager URLs**, add:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Go to **Tools → Board → Board Manager**
5. Search for **"esp32"** and install **"esp32 by Espressif Systems"** (latest version)

### Step 3: Install Required Libraries
Go to **Tools → Manage Libraries** and install:

| Library                  | Author      | Version  | Purpose                    |
|:------------------------|:------------|:---------|:--------------------------|
| SparkFun MAX3010x       | SparkFun    | ≥ 1.1.2  | MAX30102 sensor driver     |
| WebSockets              | links2004   | ≥ 2.4.0  | WebSocket client for ESP32 |
| ArduinoJson (optional)  | bblanchon   | ≥ 7.0    | JSON serialisation         |

> **Note**: The firmware uses manual string concatenation for JSON (no ArduinoJson dependency), but you can install it if you want to extend the firmware later.

### Step 4: Select Board
1. **Tools → Board → esp32 → "ESP32 Dev Module"**
2. **Tools → Port → (select your COM port)**
3. Leave all other settings at defaults

---

## ESP32 Firmware — Flash Instructions

### Step 1: Configure WiFi & Server

Open `firmware/bpm_bracelet/config.h` and edit:

```c
#define WIFI_SSID      "YourWiFiName"        // ← Your WiFi network name
#define WIFI_PASSWORD   "YourWiFiPassword"    // ← Your WiFi password
#define SERVER_HOST    "192.168.1.100"        // ← IP of your backend PC
#define SERVER_PORT    3001
```

**To find your PC's IP address:**
- Windows: Open CMD → type `ipconfig` → look for "IPv4 Address"
- Mac/Linux: Open Terminal → type `ifconfig` or `ip addr`

### Step 2: Open the Sketch

1. In Arduino IDE: **File → Open**
2. Navigate to `firmware/bpm_bracelet/bpm_bracelet.ino`
3. Arduino IDE will automatically open all `.h` and `.cpp` files in the same folder

### Step 3: Compile & Upload

1. Connect ESP32 via USB
2. Click **✓ Verify** to compile (should say "Done compiling")
3. Click **→ Upload** to flash
4. Open **Tools → Serial Monitor** at **115200 baud**

### Expected Serial Output

```
╔══════════════════════════════════════╗
║   BPM Smart Bracelet  v1.0           ║
║   ESP32 + MAX30102                   ║
╚══════════════════════════════════════╝
[SENSOR] MAX30102 detected.
[SENSOR] Initialised — place finger on sensor.
[WiFi] Connecting to YourWiFiName....
[WiFi] Connected!  IP: 192.168.1.42
[WS] Connecting to ws://192.168.1.100:3001/ws/esp32
[WS] Connected to ws://192.168.1.100:3001/ws/esp32
[SEND] {"bpm":0,"irValue":1234,"fingerDetected":false,"signal":"weak","uptime":5}
[SENSOR] No finger detected.
[BEAT] raw=72  smooth=72  IR=87432
[SEND] {"bpm":72,"irValue":87432,"fingerDetected":true,"signal":"good","uptime":6}
```

---

## Backend Server — Setup & Run

### Prerequisites
- **Node.js** ≥ 18.x (download from https://nodejs.org)

### Installation

```bash
cd bpm-server
npm install
```

### Configuration

Edit `.env` if needed (defaults are fine for local development):

```env
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

### Run

```bash
npm run dev
```

### Expected Output

```
╔══════════════════════════════════════════════╗
║   BPM Server v1.0                            ║
║   HTTP + Socket.IO : http://localhost:3001    ║
║   ESP32 WebSocket  : ws://localhost:3001/ws/esp32 ║
╚══════════════════════════════════════════════╝
```

### API Endpoints

| Method | Endpoint           | Description                     |
|:-------|:------------------|:-------------------------------|
| GET    | `/api/health`      | Server health check             |
| GET    | `/api/bpm/history` | Last N BPM readings (?n=60)     |
| GET    | `/api/bpm/status`  | ESP32 connection status         |

---

## Frontend Dashboard — Setup & Run

### Prerequisites
- **Node.js** ≥ 18.x (same as backend)

### Installation

```bash
cd bpm-dashboard
npm install
```

### Run

```bash
npm run dev
```

Dashboard opens at: **http://localhost:5173**

### What You'll See

- **BPM Card** — Large animated heart rate number with pulsing heart icon
- **Live Chart** — Scrolling area chart with last 60+ seconds of data
- **Connection Status** — Green/red dots for Dashboard↔Server and Server↔ESP32
- **Sensor Status** — Finger detection, signal quality bars, IR value, uptime

---

## Testing the Full System

### Quick Test (Without ESP32)

You can simulate the ESP32 using a WebSocket tool:

1. Start the backend: `cd bpm-server && npm run dev`
2. Start the dashboard: `cd bpm-dashboard && npm run dev`
3. Open http://localhost:5173
4. Use `wscat` (or any WebSocket client) to send test data:

```bash
npx wscat -c ws://localhost:3001/ws/esp32
```

Then type JSON messages:

```json
{"bpm":72,"irValue":87000,"fingerDetected":true,"signal":"good","uptime":10}
{"bpm":75,"irValue":88000,"fingerDetected":true,"signal":"good","uptime":11}
{"bpm":0,"irValue":1200,"fingerDetected":false,"signal":"weak","uptime":12}
{"bpm":68,"irValue":92000,"fingerDetected":true,"signal":"excellent","uptime":13}
```

You should see the dashboard update live with each message.

### Full System Test

1. Start backend server
2. Start dashboard
3. Power on the bracelet (ESP32)
4. Place finger firmly on the MAX30102 sensor
5. Wait 5–10 seconds for BPM to stabilise
6. Verify:
   - ✅ Serial monitor shows beat detections
   - ✅ Dashboard shows real BPM values
   - ✅ Chart draws a live line
   - ✅ Connection indicators are green
   - ✅ Removing finger shows "No Finger" state

---

## How It Works — Technical Deep Dive

### 1. MAX30102 IR Heartbeat Detection

The MAX30102 sensor contains:
- A **red LED** (660nm) and an **IR LED** (880nm)
- A high-sensitivity **photodetector**
- A 18-bit **ADC** with programmable sample rate

For heart rate detection, the IR LED shines light into the skin. Oxygenated hemoglobin in arterial blood absorbs IR light. With each heartbeat, arterial blood volume increases momentarily (the "pulse wave"), causing a tiny dip in the reflected IR signal. The photodetector measures these fluctuations.

### 2. Beat Detection Algorithm

The SparkFun library's `checkForBeat()` function uses:
1. **DC removal** — subtracts the slow-moving average to isolate the AC (pulsatile) component
2. **Low-pass filtering** — removes high-frequency noise
3. **Threshold crossing** — detects when the filtered signal crosses a dynamically adjusted threshold
4. **Slope detection** — confirms the crossing is a genuine peak, not noise
5. Returns `true` when a valid beat is detected

### 3. BPM Calculation

```
BPM = 60,000 ms / (time between consecutive beats in ms)
```

For example: if two consecutive beats are 800ms apart → BPM = 60000/800 = 75 BPM.

The inter-beat interval (IBI) must be between 270ms (≈220 BPM) and 1500ms (≈40 BPM) to be accepted.

### 4. Noise Filtering

Multiple layers of filtering ensure stable output:

| Filter                  | Purpose                                        |
|:------------------------|:-----------------------------------------------|
| IR threshold (>50,000)  | Reject readings when no finger is present       |
| IBI range (270–1500ms)  | Reject physiologically impossible beat intervals|
| BPM range (40–220)      | Reject out-of-range BPM values                  |
| Moving average (8 samples) | Smooth sudden spikes                         |

### 5. Real-Time Streaming

The ESP32 sends a JSON payload every 1 second over a persistent WebSocket connection:

```json
{
  "bpm": 72,
  "irValue": 87432,
  "fingerDetected": true,
  "signal": "good",
  "uptime": 123
}
```

WebSocket was chosen over HTTP polling because:
- **Low latency** — sub-10ms delivery
- **Low overhead** — no HTTP headers per message
- **Persistent connection** — no reconnect per request
- **Bidirectional** — server can send commands back

### 6. WebSocket Sync Architecture

```
ESP32 ──── raw WebSocket ────→ Node.js server ──── Socket.IO ────→ Dashboard(s)
           (ws:// protocol)                        (engine.io)
```

- **ESP32 → Server**: Raw WebSocket (`ws://`) because the ESP32 library doesn't support Socket.IO natively, and raw WS is more memory-efficient.
- **Server → Dashboard**: Socket.IO because it provides automatic reconnection, event namespacing, heartbeat keep-alive, and room support for multiple clients.

### 7. Reconnection Logic

| Component     | Mechanism                                          |
|:-------------|:--------------------------------------------------|
| ESP32 WiFi   | `WiFi.setAutoReconnect(true)` + periodic check     |
| ESP32 WS     | `setReconnectInterval(5000)` — auto-retry every 5s |
| Dashboard    | Socket.IO `reconnection: true` with exponential backoff |
| Server       | Stateless — just accepts new connections            |

---

## Troubleshooting

### ESP32 Issues

| Problem                          | Solution                                                    |
|:---------------------------------|:------------------------------------------------------------|
| `MAX30102 not found!`            | Check wiring — SDA→21, SCL→22, VIN→3.3V, GND→GND          |
| No beats detected                | Press finger firmly, don't press too hard (blocks blood flow)|
| BPM reads 0 with finger on       | Try different finger, adjust `IR_FINGER_THRESHOLD` in config |
| WiFi won't connect                | Check SSID/password in `config.h`, ensure 2.4GHz network     |
| WebSocket won't connect           | Check `SERVER_HOST` IP, ensure backend is running             |
| ESP32 keeps restarting            | Check battery voltage (>3.3V needed), check USB cable        |
| Upload fails                      | Hold BOOT button during upload, try different USB cable       |

### Backend Issues

| Problem                          | Solution                                         |
|:---------------------------------|:-------------------------------------------------|
| `EADDRINUSE`                     | Port 3001 in use — kill other process or change PORT in .env |
| No data from ESP32               | Check ESP32 serial output, verify IP address match |

### Dashboard Issues

| Problem                          | Solution                                         |
|:---------------------------------|:-------------------------------------------------|
| Dashboard shows "Disconnected"   | Ensure backend is running on port 3001            |
| Chart shows no data              | Verify ESP32 is sending data (check backend logs) |
| Blank page                       | Check browser console for errors, run `npm run dev` again |

---

## Battery Optimization

### Power Consumption Estimates

| Component     | Active Current | Notes                           |
|:-------------|:--------------|:-------------------------------|
| ESP32 WiFi    | ~120 mA       | WiFi transmit                   |
| MAX30102      | ~0.6 mA       | IR LED at 0x1F brightness       |
| ESP32 CPU     | ~40 mA        | Single core, 240 MHz            |
| **Total**     | **~160 mA**   | ~6h with 1000mAh battery        |

### Optimisation Strategies

1. **Reduce LED brightness**: In `config.h`, lower `SENSOR_LED_BRIGHTNESS` from `0x1F` to `0x0F` (trades signal quality for power)

2. **Reduce sample rate**: Lower `SENSOR_SAMPLE_RATE` from `400` to `100` (still adequate for heart rate)

3. **Increase send interval**: Change `SEND_INTERVAL_MS` from `1000` to `2000` (fewer WiFi transmissions)

4. **WiFi power saving**: Add to `setup()`:
   ```c
   WiFi.setSleep(true);  // enable WiFi modem sleep
   ```

5. **Lower CPU frequency**: Add to `setup()`:
   ```c
   setCpuFrequencyMhz(80);  // drop from 240MHz to 80MHz
   ```

6. **Light sleep between sends** (advanced):
   ```c
   esp_sleep_enable_timer_wakeup(SEND_INTERVAL_MS * 1000);
   esp_light_sleep_start();
   ```

---

## WiFi Optimization

### For Best Reliability

1. **Use 2.4GHz network** — ESP32 does not support 5GHz

2. **Static IP** — Avoid DHCP delays by adding to `network.cpp`:
   ```c
   IPAddress local_IP(192, 168, 1, 42);
   IPAddress gateway(192, 168, 1, 1);
   IPAddress subnet(255, 255, 255, 0);
   WiFi.config(local_IP, gateway, subnet);
   ```

3. **Keep close to router** — ESP32 antenna is small; stay within 10m for best results

4. **Avoid channel congestion** — Use a WiFi analyser app to find the least congested channel, then set your router to that channel

5. **Disable Bluetooth** — If not using BT, it saves memory and reduces interference:
   ```c
   btStop();
   ```

---

## Required Libraries Summary

### ESP32 (Arduino IDE)

| Library                  | Install via          | Version |
|:------------------------|:--------------------|:--------|
| SparkFun MAX3010x Pulse | Library Manager      | ≥1.1.2  |
| WebSockets (links2004)  | Library Manager      | ≥2.4.0  |
| Wire (built-in)         | Included with ESP32  | —       |
| WiFi (built-in)         | Included with ESP32  | —       |

### Backend (Node.js)

| Package     | Version | Purpose              |
|:-----------|:--------|:--------------------|
| express     | ^4.21   | HTTP server          |
| ws          | ^8.18   | Raw WebSocket server |
| socket.io   | ^4.8    | Dashboard real-time  |
| cors        | ^2.8    | Cross-origin support |
| dotenv      | ^16.4   | Environment config   |

### Frontend (React)

| Package            | Version | Purpose              |
|:------------------|:--------|:--------------------|
| react              | ^19.0   | UI framework         |
| react-dom          | ^19.0   | DOM rendering        |
| recharts           | ^2.15   | Charts               |
| socket.io-client   | ^4.8    | Real-time connection |
| lucide-react       | ^0.460  | Icons                |
| tailwindcss        | ^4.1    | CSS framework        |
| vite               | ^6.0    | Build tool           |

---

## Quick Start (TL;DR)

```bash
# 1. Start backend
cd bpm-server
npm install
npm run dev

# 2. Start dashboard (new terminal)
cd bpm-dashboard
npm install
npm run dev

# 3. Flash ESP32
#    - Edit firmware/bpm_bracelet/config.h with WiFi + server IP
#    - Open firmware/bpm_bracelet/bpm_bracelet.ino in Arduino IDE
#    - Upload to ESP32

# 4. Open http://localhost:5173 and place finger on sensor
```

---

*Built with ESP32, MAX30102, Node.js, React, and ❤️*
