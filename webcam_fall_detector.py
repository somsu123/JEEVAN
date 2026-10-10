#!/usr/bin/env python3
"""
=============================================================================
ElderCare — USB Webcam AI Fall Detection System
=============================================================================
Real-time pose estimation and fall detection using OpenCV and MediaPipe.
Runs locally on your computer with any connected USB webcam.

Features:
  • Auto-detects connected USB webcam (indexes 0, 1, 2...)
  • Real-time skeleton tracking and posture angle analysis
  • Multi-factor fall detection algorithms:
      1. Shoulder-Hip vertical compression ratio
      2. Torso horizontal inclination angle (>45°)
      3. Floor-level proximity detection
  • Live video HUD with color-coded status overlay
  • Real-time heartbeat & fall event telemetry to ElderCare Dashboard (port 5050)
  • Direct persistence to Flask backend (port 5000)

Usage:
  py -3.11 webcam_fall_detector.py [--camera 0] [--backend http://localhost:5050]
=============================================================================
"""

import sys
import os
import time
import json
import logging
import argparse
import threading
from datetime import datetime
from collections import deque

import cv2
import requests

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("WebcamFallDetector")

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "DASHBOARD_URL": os.getenv("DASHBOARD_URL", "http://localhost:5050"),
    "FLASK_URL":     os.getenv("FLASK_URL", "http://localhost:5000"),
    "DEVICE_ID":     os.getenv("DEVICE_ID", "usb-webcam-01"),
    "LOCATION":      os.getenv("LOCATION", "Living Room"),
    "FRAME_WIDTH":   640,
    "FRAME_HEIGHT":  480,
    "FPS_TARGET":    20,
    # Detection Tuning
    "FALL_FRAMES_NEEDED":    4,      # Consecutive frames needed to trigger
    "COOLDOWN_SECONDS":      15,     # Cooldown between repeat alerts
    "MIN_CONFIDENCE":        0.60,   # Minimum detection threshold
    "TORSO_ANGLE_THRESHOLD": 45.0,   # Torso degrees from vertical
}

class PoseFallDetector:
    def __init__(self, config):
        self.config = config
        self.consecutive_fall_frames = 0
        self.last_alert_time = 0.0
        
        if HAS_MEDIAPIPE:
            self.mp_pose = mp.solutions.pose
            self.mp_drawing = mp.solutions.drawing_utils
            self.mp_drawing_styles = mp.solutions.drawing_styles
            self.pose = self.mp_pose.Pose(
                min_detection_confidence=0.55,
                min_tracking_confidence=0.55,
                model_complexity=1,  # 1 = Full model for PC (high precision)
            )
        else:
            self.pose = None

    def analyze_frame(self, frame_bgr):
        if not self.pose:
            return False, 0.0, {}, None

        h, w, _ = frame_bgr.shape
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        results = self.pose.process(frame_rgb)

        if not results.pose_landmarks:
            self.consecutive_fall_frames = max(0, self.consecutive_fall_frames - 1)
            return False, 0.0, {"status": "No Person"}, results

        lm = results.pose_landmarks.landmark
        MP = self.mp_pose.PoseLandmark

        def get_pt(name):
            l = lm[MP[name].value]
            return l.x, l.y, l.visibility

        try:
            ls_x, ls_y, ls_v = get_pt("LEFT_SHOULDER")
            rs_x, rs_y, rs_v = get_pt("RIGHT_SHOULDER")
            lh_x, lh_y, lh_v = get_pt("LEFT_HIP")
            rh_x, rh_y, rh_v = get_pt("RIGHT_HIP")
            lk_x, lk_y, lk_v = get_pt("LEFT_KNEE")
            rk_x, rk_y, rk_v = get_pt("RIGHT_KNEE")
        except Exception:
            return False, 0.0, {"status": "Landmark Error"}, results

        min_vis = 0.35
        if min(ls_v, rs_v, lh_v, rh_v) < min_vis:
            return False, 0.0, {"status": "Low Visibility"}, results

        # Midpoints (normalized 0-1)
        shoulder_x = (ls_x + rs_x) / 2.0
        shoulder_y = (ls_y + rs_y) / 2.0
        hip_x      = (lh_x + rh_x) / 2.0
        hip_y      = (lh_y + rh_y) / 2.0
        knee_y     = (lk_y + rk_y) / 2.0 if (lk_v > min_vis and rk_v > min_vis) else None

        # ── Indicator 1: Shoulder-to-hip / knee vertical drop ─────────────────
        knee_ref = knee_y if knee_y is not None else hip_y + 0.2
        drop_ratio = (shoulder_y - hip_y) / max(abs(knee_ref - hip_y), 0.01)
        indicator_1 = (drop_ratio > 0.70)  # Shoulders approaching hip/knee horizontal level

        # ── Indicator 2: Torso horizontal angle ───────────────────────────────
        dx = abs(shoulder_x - hip_x)
        dy = abs(shoulder_y - hip_y)
        # Ratio dx/dy > 0.8 means torso is tilted > ~40 degrees
        indicator_2 = (dx / max(dy, 0.001)) > 0.85

        # ── Indicator 3: Body low in frame ───────────────────────────────────
        indicator_3 = (shoulder_y > 0.55 and hip_y > 0.60)

        # Score & Confidence
        score = sum([indicator_1, indicator_2, indicator_3])
        confidence = 0.0
        if score == 1:
            confidence = 0.55
        elif score == 2:
            confidence = 0.78
        elif score >= 3:
            confidence = 0.94

        is_fall_pose = confidence >= self.config["MIN_CONFIDENCE"]
        if is_fall_pose:
            self.consecutive_fall_frames += 1
        else:
            self.consecutive_fall_frames = max(0, self.consecutive_fall_frames - 1)

        now = time.time()
        should_alert = (
            self.consecutive_fall_frames >= self.config["FALL_FRAMES_NEEDED"]
            and is_fall_pose
            and (now - self.last_alert_time) > self.config["COOLDOWN_SECONDS"]
        )

        if should_alert:
            self.last_alert_time = now
            self.consecutive_fall_frames = 0

        debug_info = {
            "score": score,
            "confidence": confidence,
            "consecutive_frames": self.consecutive_fall_frames,
            "is_fall_pose": is_fall_pose,
            "should_alert": should_alert,
            "shoulder_y": shoulder_y,
            "hip_y": hip_y,
            "indicator_1": indicator_1,
            "indicator_2": indicator_2,
            "indicator_3": indicator_3,
        }

        return should_alert, confidence, debug_info, results

def send_heartbeat(config):
    """Sends periodic camera heartbeat to the dashboard."""
    try:
        requests.post(
            f"{config['DASHBOARD_URL']}/api/camera/heartbeat",
            json={"deviceId": config["DEVICE_ID"], "status": "online"},
            timeout=2
        )
    except Exception:
        pass

def send_fall_event(config, confidence: float):
    """Broadcasts fall event to Dashboard and Flask backend."""
    now = datetime.now()
    payload = {
        "event": "FALL_DETECTED",
        "deviceId": config["DEVICE_ID"],
        "location": config["LOCATION"],
        "timestamp": now.strftime("%H:%M:%S — %b %d, %Y"),
        "confidence": round(confidence, 2),
        "source": "camera",
    }

    def _post():
        try:
            r = requests.post(f"{config['DASHBOARD_URL']}/api/fall-event", json=payload, timeout=4)
            if r.ok:
                log.info(f"🚨 Fall Event successfully sent to Dashboard! (Confidence: {confidence:.0%})")
        except Exception as e:
            log.warning(f"Could not notify dashboard: {e}")

        try:
            requests.post(
                f"{config['FLASK_URL']}/api/fall",
                json={"is_fall": True, "confidence": confidence, "source": "camera"},
                timeout=4
            )
        except Exception:
            pass

    threading.Thread(target=_post, daemon=True).start()

def find_working_camera(preferred_idx=0):
    """Probes video capture devices to find a working camera index."""
    test_indices = [preferred_idx, 0, 1, 2, 3]
    seen = set()
    for idx in test_indices:
        if idx in seen: continue
        seen.add(idx)
        cap = cv2.VideoCapture(idx)
        if cap.isOpened():
            ret, frame = cap.read()
            if ret and frame is not None and frame.size > 0:
                log.info(f"Found active camera on Index {idx} (Resolution: {frame.shape[1]}x{frame.shape[0]})")
                cap.release()
                return idx
            cap.release()
    return preferred_idx

def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="ElderCare AI Camera Fall Detector")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (default: 0)")
    parser.add_argument("--dashboard", type=str, default=DEFAULT_CONFIG["DASHBOARD_URL"], help="Dashboard URL")
    parser.add_argument("--flask", type=str, default=DEFAULT_CONFIG["FLASK_URL"], help="Flask API URL")
    parser.add_argument("--headless", action="store_true", help="Run without preview window")
    args = parser.parse_args()

    config = DEFAULT_CONFIG.copy()
    config["DASHBOARD_URL"] = args.dashboard
    config["FLASK_URL"]     = args.flask

    print()
    print("=" * 65)
    print("  [CAMERA] ElderCare -- AI Vision Fall Detection System")
    print(f"  Dashboard Server : {config['DASHBOARD_URL']}")
    print(f"  Backend API      : {config['FLASK_URL']}")
    print(f"  Location         : {config['LOCATION']}")
    print("=" * 65)
    print()

    cam_idx = find_working_camera(args.camera)
    cap = cv2.VideoCapture(cam_idx)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config["FRAME_WIDTH"])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config["FRAME_HEIGHT"])
    cap.set(cv2.CAP_PROP_FPS, config["FPS_TARGET"])

    if not cap.isOpened():
        log.error(f"Failed to open camera on index {cam_idx}. Please check USB connection.")
        sys.exit(1)

    detector = PoseFallDetector(config)

    last_heartbeat_time = 0.0
    fps_time = time.time()
    frame_count = 0
    current_fps = 0.0
    active_alert_display_until = 0.0

    log.info("AI Fall Detection is running. Press 'q' or 'ESC' in the camera window to exit.")

    while True:
        ret, frame = cap.read()
        if not ret or frame is None:
            time.sleep(0.05)
            continue

        frame_count += 1
        if time.time() - fps_time >= 1.0:
            current_fps = frame_count / (time.time() - fps_time)
            frame_count = 0
            fps_time = time.time()

        # Send heartbeat to dashboard every 5 seconds
        if time.time() - last_heartbeat_time >= 5.0:
            last_heartbeat_time = time.time()
            send_heartbeat(config)

        # Run AI Pose & Fall Detection
        should_alert, confidence, debug, results = detector.analyze_frame(frame)

        if should_alert:
            active_alert_display_until = time.time() + 6.0
            send_fall_event(config, confidence)

        # Draw visual HUD
        if not args.headless:
            # Draw MediaPipe skeleton landmarks
            if results and results.pose_landmarks and detector.mp_drawing:
                detector.mp_drawing.draw_landmarks(
                    frame,
                    results.pose_landmarks,
                    detector.mp_pose.POSE_CONNECTIONS,
                    landmark_drawing_spec=detector.mp_drawing_styles.get_default_pose_landmarks_style()
                )

            h, w, _ = frame.shape
            is_in_alert = time.time() < active_alert_display_until
            is_fall_pose = debug.get("is_fall_pose", False)

            # Top Status Bar
            if is_in_alert or is_fall_pose:
                bar_color = (0, 0, 220)  # Red
                status_text = "🚨 FALL DETECTED! ALERT SENT" if is_in_alert else f"⚠️ FALL POSE ({int(confidence*100)}%)"
            else:
                bar_color = (30, 160, 40) # Green
                status_text = "MONITORING — PATIENT NORMAL"

            cv2.rectangle(frame, (0, 0), (w, 48), bar_color, -1)
            cv2.putText(frame, status_text, (15, 32), cv2.FONT_HERSHEY_DUPLEX, 0.75, (255, 255, 255), 2)

            # Bottom Info Overlay
            cv2.rectangle(frame, (0, h - 35), (w, h), (20, 20, 20), -1)
            fps_str = f"FPS: {current_fps:.1f} | Cam: #{cam_idx} | Frames: {debug.get('consecutive_frames', 0)}/{config['FALL_FRAMES_NEEDED']}"
            cv2.putText(frame, fps_str, (12, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1)

            dash_status = f"Dashboard: {config['DASHBOARD_URL']}"
            cv2.putText(frame, dash_status, (w - 280, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (100, 220, 120), 1)

            cv2.imshow("ElderCare — USB AI Fall Detection Camera", frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:
                log.info("Quit requested by user.")
                break

    cap.release()
    cv2.destroyAllWindows()
    log.info("Camera detector shut down cleanly.")

if __name__ == "__main__":
    main()
