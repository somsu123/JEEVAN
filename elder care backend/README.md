# ElderCare Backend Suite

Central IoT and AI backend services for the ElderCare / JEEVAN monitoring platform.

This repository contains the backend server services that power real-time health telemetry, medicine schedules, fall event logs, and voice assistance.

---

## ??? Architecture & Modules

```
elder-care-backend/
+-- backend/                   # Central Flask REST API & MongoDB Atlas database layer
¦   +-- app.py                 # Main Flask server (port 5000)
¦   +-- database.py            # MongoDB Atlas interface (collections: system_state, fall_logs, medicines, etc.)
¦   +-- whisper_sidecar.py     # Local Whisper audio transcription bridge
¦   +-- clear_mongo.py         # MongoDB reset utility
¦   +-- test_atlas.py          # Atlas connectivity test
¦   +-- test_tts.py            # TTS diagnostic script
¦
+-- bpm-server/                # Real-time WebSocket server for vitals
¦   +-- server.js              # Node.js WebSocket & HTTP server (port 3001)
¦   +-- bpmStore.js            # In-memory vitals ring buffer & statistics
¦   +-- validation.js          # Payload validation logic
¦   +-- package.json           # WebSocket dependencies
¦
+-- ai_assistant/              # Intelligent Voice Assistant module
¦   +-- main_assistant.py      # Voice interaction & vocal status updates
¦   +-- README_HARDWARE.md     # Hardware integration details
¦
+-- tools/                     # Hardware & API contract testing tools
¦   +-- test_medbox_api.py     # End-to-end tests for smart medicine box endpoints
¦
+-- medicines.json             # Seed medication data
+-- requirements.txt           # Python dependencies
+-- .env.example               # Template environment configuration
+-- start_backend.bat          # 1-click startup script for all services
```

---

## ??? Prerequisites

1. **Python 3.11** (required for `pyttsx3` and legacy voice modules)
2. **Node.js** (v18+ recommended)
3. **MongoDB Atlas** account or local MongoDB instance

---

## ?? Setup & Installation

### 1. Configure Environment Variables

Copy `.env.example` to `.env` in the root (or configure inside `backend/`):

```bash
copy .env.example .env
```

Fill in your MongoDB connection string in `.env`:
```env
MONGO_URI="mongodb+srv://<username>:<password>@cluster0.mongodb.net/JEEVAN"
PORT=5000
```

### 2. Install Python Dependencies

```powershell
py -3.11 -m pip install -r requirements.txt
```

### 3. Install BPM WebSocket Server Dependencies

```powershell
cd bpm-server
npm install
cd ..
```

---

## ? Running the Backend

You can run all services automatically by launching:
```powershell
.\start_backend.bat
```

Or start the individual services manually:

### 1. Central Flask REST API (Port 5000)
```powershell
py -3.11 backend\app.py
```

### 2. Live Vitals WebSocket Server (Port 3001)
```powershell
cd bpm-server
node server.js
```

### 3. Voice Assistant
```powershell
py -3.11 ai_assistant\main_assistant.py
```

---

## ?? Key REST Endpoints (Flask API - Port 5000)

| Endpoint | Method | Description |
|---|---|---|
| `/api/state` | `GET` | Fetches consolidated system vitals, fall status, and medbox state |
| `/api/fall` | `POST` | Receives fall detections from camera or wrist bracelet |
| `/api/heartrate` | `POST` | Telemetry endpoint for ESP32 heart rate (BPM) |
| `/api/medicine` | `POST` | Updates medicine box lid open/close & reminder states |
| `/api/schedule` | `GET`, `POST` | Manages patient medication schedules |
| `/api/reports` | `GET` | Fetches scanned medical prescription reports |
| `/api/reports/save` | `POST` | Saves scanned prescription reports and medicines |
| `/api/medicines` | `GET` | Lists all patient medications |
| `/api/medicines/due` | `GET` | Returns medications due at current time window |
