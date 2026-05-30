# ElderCare Dashboard v2

**Unified 360° elderly care IoT monitoring dashboard** built with React 19 + TypeScript + Tailwind CSS v4 + Gemini AI.

Extends `D:\ai_care` (React/Gemini) and connects to `D:\Elder--Care` (Flask/MongoDB/ESP32 backend).

---

## Architecture

```
D:\Elder--Care\dashboard-v2\
├── server.ts            ← Node/Express bridge (port 5050)
│   ├── /api/vitals      → Proxies Flask /api/state
│   ├── /api/fall-event  → Receives Pi/bracelet fall events
│   ├── /api/medicine-*  → Proxies Flask /api/medicine + /api/schedule
│   ├── /api/voice-chat  → Gemini AI voice assistant (MITRA)
│   ├── /api/scan-report → Gemini Vision report analysis
│   └── /api/events-stream → SSE real-time push to frontend
│
├── src/
│   ├── App.tsx          ← Global state, SSE listener, all view routing
│   ├── types.ts         ← All interfaces
│   └── components/
│       ├── Sidebar.tsx       ← 6-item navigation
│       ├── Overview.tsx      ← Report analytics (from ai_care)
│       ├── LiveVitals.tsx    ← BPM sparkline + 4 vital cards
│       ├── FallAlerts.tsx    ← Event timeline + confidence meters
│       ├── MedicineBox.tsx   ← Slot cards + countdown timers
│       ├── VoiceAssistant.tsx← MITRA chat UI
│       └── ReportScanner.tsx ← Gemini scan (from ai_care)
│
└── pi-fall-detector/
    ├── fall_detector.py  ← MediaPipe Pose fall detection (run on Pi)
    └── requirements.txt
```

---

## Quick Start

### 1. Start existing ElderCare backend
```bash
# In D:\Elder--Care\
py -3.11 backend\app.py          # Flask on port 5000
```

### 2. Set up dashboard-v2
```bash
cd D:\Elder--Care\dashboard-v2

# Copy .env.example to .env and fill in your Gemini API key
copy .env.example .env

npm install
npm run dev                       # Node bridge on port 5050 + Vite
```

### 3. Open browser
```
http://localhost:5050
```

### 4. Start Raspberry Pi fall detector (optional)
```bash
# On Raspberry Pi:
pip install -r pi-fall-detector/requirements.txt
BACKEND_URL=http://<your-pc-ip>:5050 python pi-fall-detector/fall_detector.py
```

---

## Features

| Module | Status | Connected To |
|--------|--------|-------------|
| Live Vitals Telemetry | ✅ | ESP32 bracelet → Flask → Node bridge |
| BPM Sparkline (60-pt) | ✅ | App.tsx 1s timer + hardware poll |
| Fall Detection (Camera) | ✅ | Pi MediaPipe → /api/fall-event |
| Fall Detection (Bracelet) | ✅ | braclet_bpm.ino → /api/fall-event |
| Medicine Reminder Box | ✅ | medicine_box.ino → Flask → Node |
| AI Voice Assistant (MITRA) | ✅ | Gemini 2.5 Flash |
| Clinical Report Scanner | ✅ | Gemini 2.5 Flash Vision |
| SSE Real-time Push | ✅ | /api/events-stream |
| Emergency SOS | ✅ | Global state + fall count badge |

---

## Environment Variables

```env
GEMINI_API_KEY=your_key_here
FLASK_BACKEND_URL=http://localhost:5000
PORT=5050
```

---

## Testing Fall Alerts (without hardware)

```bash
# Simulate a fall event via curl:
curl -X POST http://localhost:5050/api/fall-event \
  -H "Content-Type: application/json" \
  -d '{"event":"FALL_DETECTED","deviceId":"test","location":"Bedroom","confidence":0.92,"source":"camera"}'
```
