# ElderCare Automation System

A comprehensive IoT and AI-powered system designed to assist with monitoring the well-being and medication adherence of elderly individuals. It consists of multiple modules running seamlessly together via a centralized MongoDB backend.

## Features

1. **Vision-based Fall Detection (Raspberry Pi Camera)** 
   - Runs locally on an external Raspberry Pi using an on-device camera.
   - Privacy-first: all CV/pose estimation runs locally on the Pi; no video stream is sent across the network.
   - Sends real-time fall alert metadata over the local WiFi to the central dashboard.

2. **IoT Integration (ESP32)**
   - Expects REST endpoints for hardware connections checking heart-rate (BPM) and medicine box status (Lid open/close).

3. **Real-time Live Dashboard (Vite + Express)**
   - Beautiful localized dashboard syncing every 1.5 seconds.
   - Displays historic falls, heart-rate state, next medication doses, and total alerts all in real-time from the database.

4. **AI Voice Assistant**
   - Responds to audible triggers and fetches live hardware logs directly using the shared API to give vocal status updates regarding patient well-being and upcoming medicine schedules.

---

## 🛠️ Prerequisites & Setup

### 1. Database Setup
The entire system state, telemetry events, and configuration schedules operate exclusively on a local **MongoDB database**.
- Download and install [MongoDB Community Edition](https://www.mongodb.com/try/download/community).
- Ensure MongoDB is running locally on port `27017` (default).

### 2. Python Environment Setup
This system uses older libraries (like `pyttsx3` and legacy mediapipe dependencies for the voice modules), and thus strictly requires **Python 3.11**.
- Verify you have Python 3.11 installed. If not, download and install it.
- Open your terminal and install the required PIP dependencies.

```powershell
# We assume you have the py launcher installed on Windows
py -3.11 -m pip install -r requirements.txt
```
*(If you do not have a requirements.txt file, ensure at least the following are installed via pip: `flask flask-cors pymongo requests mediapipe opencv-python pyttsx3 numpy`)*

### 3. Raspberry Pi Fall Detector
The vision-based camera fall detector is designed to be offloaded to a separate **Raspberry Pi** (running the code in `D:\elder care fall`). This ensures maximum local processing speed and leaves your central host PC free to run the backend, voice assistant, and dashboard without resource conflicts.

---

## 🚀 Running the System

To launch the central services, simply double-click the `start_system.bat` file, or open a Command Prompt / PowerShell in the root directory and run:

```powershell
.\start_system.bat
```

This batch file will boot 3 separate command windows sequentially:
1. `backend/app.py` - Starts the central Flask API Server locally (port 5000), connecting to MongoDB.
2. `ai_assistant/assistant.py` - Starts the background voice assistant module.
3. Starts the Express/Node dashboard server (port 5050), which launches the Vite-based real-time UI.

*Note: The Raspberry Pi fall detector runs separately on the Pi itself (using the `fall_detector.py` script).*

---

## 📡 Connecting External IoT Hardware

If you are using ESP32 hardware to track BPM or Medicine Box state, ensure it is connected to the same Wi-Fi network as the machine running the system.

In your Arduino code, point your `HTTPClient` to make POST requests to the backend server.
Assuming the computer running the backend has the local IP Address `192.168.1.50`:

**BPM Endpoint** (`POST http://192.168.1.50:5000/api/heartrate`)
```json
{
  "bpm": 72
}
```

**Medicine Box Endpoint** (`POST http://192.168.1.50:5000/api/medicine`)
```json
{
  "lid_open": true,
  "reminder_triggered": false
}
```

*Note: If your friend is using a different Wi-Fi connection from a separate house for the IoT, you will have to use Ngrok or render.com to expose this local `5000` port to the public internet.*

---

## 📩 Configuring Email & SMS Alerts 

Centralized notifications are handled directly by the dashboard server. Configure your preferences inside `dashboard-v2/.env`:
1. Open the configuration file `dashboard-v2/.env`.
2. Provide your caregiver email in `CAREGIVER_EMAIL`.
3. Provide your Gmail login in `GMAIL_USER` and a 16-character Google App Password in `GMAIL_APP_PASSWORD`.
4. (Optional) For SMS alerts, configure your Twilio account SID, token, from number, and caregiver phone number.

---

## Troubleshooting

- **`ModuleNotFoundError: No module named 'pymongo'`:** You are mistakenly using the wrong Python version (e.g., Python 3.13) to run the scripts. The `start_system.bat` explicitly uses `py -3.11`.
- **Dashboard Data not changing:** Ensure MongoDB is actively running in the background (`mongod`). Open MongoDB Compass and confirm that the `eldercare_db` is populated.
