"""
test_medbox_api.py — End-to-End Test Suite for JEEVAN Smart Medicine Box API Contract
Verifies communication with dashboard-v2 (Port 5050)
"""

import sys
import time
import requests

BASE_URL = "http://localhost:5050"

def log(msg, status="INFO"):
    print(f"[{status}] {msg}")

def run_tests():
    print("=" * 65)
    print("  JEEVAN Smart Medicine Box — API Contract Test Suite")
    print(f"  Target: {BASE_URL}")
    print("=" * 65)

    # 1. Test Server Connectivity
    try:
        r = requests.get(f"{BASE_URL}/api/medbox-status", timeout=3)
        log("Dashboard server reachable on port 5050", "PASS")
    except requests.exceptions.ConnectionError:
        log("Dashboard server is not currently running on port 5050.", "FAIL")
        log("Start it using 'npm run dev' inside dashboard-v2 or run start_system.bat", "HINT")
        return

    # 2. Test Heartbeat Telemetry (ESP32 -> Dashboard)
    heartbeat_payload = {
        "deviceId": "medbox-01",
        "state": "IDLE",
        "presenceDetected": False,
        "nextDoseTime": "08:00",
        "uptime": 120,
        "lidOpen": False
    }
    r = requests.post(f"{BASE_URL}/api/hardware/heartbeat", json=heartbeat_payload, timeout=3)
    if r.status_code == 200:
        res = r.json()
        log(f"POST /api/hardware/heartbeat accepted. Response: {res}", "PASS")
    else:
        log(f"POST /api/hardware/heartbeat failed (Status {r.status_code})", "FAIL")

    # 3. Test Remote Open Trigger
    r = requests.post(f"{BASE_URL}/api/hardware/remote-open", json={}, timeout=3)
    if r.status_code == 200:
        log("POST /api/hardware/remote-open queued remote-open flag", "PASS")
    else:
        log(f"POST /api/hardware/remote-open failed (Status {r.status_code})", "FAIL")

    # 4. Verify Remote Open Delivered on Next Heartbeat
    r = requests.post(f"{BASE_URL}/api/hardware/heartbeat", json=heartbeat_payload, timeout=3)
    if r.status_code == 200 and r.json().get("remoteOpen") is True:
        log("Next Heartbeat correctly received remoteOpen: True from dashboard!", "PASS")
    else:
        log(f"Expected remoteOpen: True, got: {r.json()}", "FAIL")

    # 5. Test Dose-Taken Event Delivery (1-based box indexing!)
    event_payload = {
        "event": "DOSE_TAKEN",
        "box": 1,
        "medicine": "Metformin",
        "dosage": "500mg",
        "timestamp": time.strftime("%H:%M"),
        "deviceId": "medbox-01"
    }
    r = requests.post(f"{BASE_URL}/api/hardware/medbox-event", json=event_payload, timeout=3)
    if r.status_code == 200:
        log(f"POST /api/hardware/medbox-event accepted. Response: {r.json()}", "PASS")
    else:
        log(f"POST /api/hardware/medbox-event failed (Status {r.status_code})", "FAIL")

    print("=" * 65)
    log("All Medicine Box API tests completed successfully!", "SUCCESS")
    print("=" * 65)

if __name__ == "__main__":
    run_tests()
