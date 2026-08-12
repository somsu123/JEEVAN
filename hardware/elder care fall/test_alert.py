#!/usr/bin/env python3
"""
ElderCare — Fall Detector UI Tester
========================================
Run this script to send a simulated fall detection event to the 
dashboard to check if the notifications pop up correctly.
"""

import requests
import sys

# Dashboard IP and Port
DASHBOARD_URL = "http://localhost:5050/api/fall-event"
ALT_DASHBOARD_URL = "http://10.206.196.135:5050/api/fall-event"

payload = {
    "event": "FALL_DETECTED",
    "deviceId": "pi-camera-test",
    "location": "Living Room",
    "confidence": 0.92,       # High confidence triggers "Critical Fall"
    "source": "camera"
}

def send_alert(url):
    print(f"Sending simulated fall alert to {url}...")
    try:
        r = requests.post(url, json=payload, timeout=5)
        if r.status_code == 200:
            print("==================================================")
            print(" ✅ SUCCESS: Mock fall alert successfully sent!")
            print(f" Response: {r.json()}")
            print("==================================================")
            print("Check your dashboard browser window now:")
            print(" 1. You should see a red flashing 'FALL DETECTED' banner at the bottom.")
            print(" 2. You will see an active alert indicator in the top header.")
            print(" 3. Go to the 'Fall Alerts' page to view the log and click 'Resolve'.")
            return True
        else:
            print(f" ❌ ERROR: Server returned status code {r.status_code}")
            print(f" Response text: {r.text}")
            return False
    except Exception as e:
        print(f" ❌ ERROR: Failed to connect to server: {e}")
        return False

if __name__ == "__main__":
    # Try localhost first
    if not send_alert(DASHBOARD_URL):
        print("\nRetrying with network-facing IP address...")
        send_alert(ALT_DASHBOARD_URL)
