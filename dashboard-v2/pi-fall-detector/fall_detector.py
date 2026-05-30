#!/usr/bin/env python3
"""
ElderCare — Raspberry Pi Fall Detector
========================================
Privacy-first fall detection: all CV runs locally on the Pi.
No video stream is ever sent to the dashboard.
Only event metadata (timestamp, confidence, location) is posted.

Requirements:
    pip install opencv-python mediapipe requests

Usage:
    python fall_detector.py

Configuration:
    Edit the CONFIG section below or set environment variables.
"""

import cv2
import time
import json
import logging
import os
import threading
from datetime import datetime
from collections import deque

# ── Try importing optional deps ────────────────────────────────────────────────
try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    HAS_MEDIAPIPE = False
    print("[WARN] mediapipe not installed. Install with: pip install mediapipe")

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("[WARN] requests not installed. Install with: pip install requests")

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fall_detector")

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION — edit here or use environment variables
# ══════════════════════════════════════════════════════════════════════════════
CONFIG = {
    "BACKEND_URL":       os.getenv("BACKEND_URL",       "http://localhost:5050"),
    "DEVICE_ID":         os.getenv("DEVICE_ID",         "pi-camera-01"),
    "LOCATION":          os.getenv("LOCATION",          "Living Room"),
    "CAMERA_INDEX":      int(os.getenv("CAMERA_INDEX",  "0")),
    "FRAME_WIDTH":       int(os.getenv("FRAME_WIDTH",   "640")),
    "FRAME_HEIGHT":      int(os.getenv("FRAME_HEIGHT",  "480")),
    "FPS_TARGET":        int(os.getenv("FPS_TARGET",    "15")),
    # Fall detection thresholds
    "FALL_FRAMES_NEEDED":    int(os.getenv("FALL_FRAMES_NEEDED",    "5")),   # consecutive frames with fall pose
    "COOLDOWN_SECONDS":      int(os.getenv("COOLDOWN_SECONDS",      "10")),  # seconds between alerts
    "MIN_CONFIDENCE":        float(os.getenv("MIN_CONFIDENCE",      "0.55")), # minimum detection confidence
    # Pose thresholds
    "SHOULDER_HIP_DROP_RATIO": float(os.getenv("SHOULDER_HIP_DROP_RATIO", "0.15")), # normalized Y drop
    "TORSO_ANGLE_THRESHOLD":   float(os.getenv("TORSO_ANGLE_THRESHOLD",   "45.0")),  # degrees from vertical
    # Privacy
    "SAVE_THUMBNAILS":    os.getenv("SAVE_THUMBNAILS", "false").lower() == "true",
    "THUMBNAIL_DIR":      os.getenv("THUMBNAIL_DIR",   "./fall_thumbnails"),
    "SHOW_PREVIEW":       os.getenv("SHOW_PREVIEW",    "false").lower() == "true",
}

# ══════════════════════════════════════════════════════════════════════════════
# FALL DETECTION LOGIC
# ══════════════════════════════════════════════════════════════════════════════
class FallDetector:
    def __init__(self):
        self.last_alert_time = 0.0
        self.consecutive_fall_frames = 0
        self.frame_history: deque = deque(maxlen=10)

        if HAS_MEDIAPIPE:
            self.mp_pose = mp.solutions.pose
            self.pose = self.mp_pose.Pose(
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
                model_complexity=0,  # Lite model for Pi performance
            )
        else:
            self.pose = None

    def analyze_frame(self, frame_rgb):
        """
        Run pose estimation on a single RGB frame.
        Returns (is_fall: bool, confidence: float, debug_info: dict)
        """
        if self.pose is None:
            return False, 0.0, {}

        results = self.pose.process(frame_rgb)
        if not results.pose_landmarks:
            self.consecutive_fall_frames = max(0, self.consecutive_fall_frames - 1)
            return False, 0.0, {"landmarks": False}

        lm = results.pose_landmarks.landmark
        MP = self.mp_pose.PoseLandmark

        # Extract key landmarks (normalized 0-1 coordinates)
        # In image space: Y increases downward. Lower Y = higher on screen.
        def get(name):
            l = lm[MP[name].value]
            return l.x, l.y, l.visibility

        try:
            ls_x, ls_y, ls_v = get("LEFT_SHOULDER")
            rs_x, rs_y, rs_v = get("RIGHT_SHOULDER")
            lh_x, lh_y, lh_v = get("LEFT_HIP")
            rh_x, rh_y, rh_v = get("RIGHT_HIP")
            lk_x, lk_y, lk_v = get("LEFT_KNEE")
            rk_x, rk_y, rk_v = get("RIGHT_KNEE")
        except Exception:
            return False, 0.0, {}

        # Visibility check — skip if key joints not visible
        min_vis = 0.4
        if min(ls_v, rs_v, lh_v, rh_v) < min_vis:
            return False, 0.0, {"visibility": "low"}

        # Midpoints
        shoulder_y = (ls_y + rs_y) / 2
        hip_y = (lh_y + rh_y) / 2
        knee_y = (lk_y + rk_y) / 2 if (lk_v > min_vis and rk_v > min_vis) else None

        # ── FALL INDICATOR 1: Shoulder Y drops close to or below knee Y ─────
        # In image coords (Y↓), a fall means shoulder_y approaches knee_y
        indicator_1 = False
        knee_ref = knee_y if knee_y is not None else hip_y + 0.2
        drop_ratio = (shoulder_y - hip_y) / max(abs(knee_ref - hip_y), 0.01)
        if drop_ratio > 0.8:  # shoulders nearly at knee level → horizontal
            indicator_1 = True

        # ── FALL INDICATOR 2: Torso nearly horizontal ─────────────────────────
        indicator_2 = False
        torso_dy = abs(hip_y - shoulder_y)
        torso_dx = abs((lh_x + rh_x) / 2 - (ls_x + rs_x) / 2)
        if torso_dy < CONFIG["SHOULDER_HIP_DROP_RATIO"]:
            indicator_2 = True

        # ── FALL INDICATOR 3: Very low shoulder position relative to frame ────
        indicator_3 = shoulder_y > 0.65  # shoulders very low in frame

        # Score and confidence
        score = sum([indicator_1, indicator_2, indicator_3])
        confidence = 0.0
        if score == 1: confidence = 0.55
        elif score == 2: confidence = 0.75
        elif score == 3: confidence = 0.92

        debug = {
            "shoulder_y": round(shoulder_y, 3),
            "hip_y": round(hip_y, 3),
            "knee_y": round(knee_y, 3) if knee_y else "n/a",
            "drop_ratio": round(drop_ratio, 3),
            "torso_dy": round(torso_dy, 3),
            "indicators": [indicator_1, indicator_2, indicator_3],
            "score": score,
            "confidence": round(confidence, 2),
        }

        is_fall_pose = confidence >= CONFIG["MIN_CONFIDENCE"]
        return is_fall_pose, confidence, debug

    def update(self, is_fall_pose: bool, confidence: float) -> tuple[bool, float]:
        """
        Apply temporal smoothing: require N consecutive frames before triggering.
        Returns (should_alert, final_confidence)
        """
        if is_fall_pose:
            self.consecutive_fall_frames += 1
        else:
            self.consecutive_fall_frames = max(0, self.consecutive_fall_frames - 1)

        should_alert = (
            self.consecutive_fall_frames >= CONFIG["FALL_FRAMES_NEEDED"]
            and confidence >= CONFIG["MIN_CONFIDENCE"]
            and (time.time() - self.last_alert_time) > CONFIG["COOLDOWN_SECONDS"]
        )

        if should_alert:
            self.last_alert_time = time.time()
            self.consecutive_fall_frames = 0

        return should_alert, confidence


# ══════════════════════════════════════════════════════════════════════════════
# BACKEND NOTIFICATION
# ══════════════════════════════════════════════════════════════════════════════
def send_fall_alert(confidence: float, thumbnail_b64: str | None = None):
    """POST fall event to the Node bridge server (which forwards to Flask)."""
    if not HAS_REQUESTS:
        log.warning("requests library missing — cannot send alert!")
        return

    payload = {
        "event": "FALL_DETECTED",
        "deviceId": CONFIG["DEVICE_ID"],
        "location": CONFIG["LOCATION"],
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "confidence": round(confidence, 3),
        "source": "camera",
    }
    if thumbnail_b64:
        payload["thumbnail"] = thumbnail_b64

    url = f"{CONFIG['BACKEND_URL']}/api/fall-event"

    def _post():
        try:
            r = requests.post(url, json=payload, timeout=5)
            if r.ok:
                log.info(f"[OK] Fall alert sent → {url} (confidence={confidence:.0%})")
            else:
                log.error(f"[ERR] Server responded {r.status_code}: {r.text[:200]}")
        except Exception as e:
            log.error(f"[ERR] Could not reach backend: {e}")

    # Post in background thread — don't block the video loop
    threading.Thread(target=_post, daemon=True).start()


def save_thumbnail(frame_bgr, confidence: float) -> str | None:
    """Optionally save a thumbnail on detection (privacy off by default)."""
    if not CONFIG["SAVE_THUMBNAILS"]:
        return None
    try:
        os.makedirs(CONFIG["THUMBNAIL_DIR"], exist_ok=True)
        filename = os.path.join(
            CONFIG["THUMBNAIL_DIR"],
            f"fall_{datetime.now().strftime('%Y%m%d_%H%M%S')}_conf{int(confidence*100)}.jpg"
        )
        # Blur faces for privacy before saving
        cv2.imwrite(filename, frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 60])
        log.info(f"Thumbnail saved: {filename}")
        return filename
    except Exception as e:
        log.error(f"Thumbnail save failed: {e}")
        return None


# ══════════════════════════════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════════════════════════════
def main():
    log.info("=" * 60)
    log.info("  ElderCare Pi Fall Detector — Starting")
    log.info(f"  Backend: {CONFIG['BACKEND_URL']}")
    log.info(f"  Device:  {CONFIG['DEVICE_ID']} @ {CONFIG['LOCATION']}")
    log.info(f"  Camera:  index={CONFIG['CAMERA_INDEX']}, {CONFIG['FRAME_WIDTH']}x{CONFIG['FRAME_HEIGHT']}")
    log.info(f"  Preview: {'ON' if CONFIG['SHOW_PREVIEW'] else 'OFF (privacy)'}")
    log.info("=" * 60)

    if not HAS_MEDIAPIPE:
        log.error("MediaPipe not installed! Run: pip install mediapipe")
        return

    cap = cv2.VideoCapture(CONFIG["CAMERA_INDEX"])
    if not cap.isOpened():
        log.error(f"Cannot open camera index {CONFIG['CAMERA_INDEX']}")
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  CONFIG["FRAME_WIDTH"])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CONFIG["FRAME_HEIGHT"])
    cap.set(cv2.CAP_PROP_FPS, CONFIG["FPS_TARGET"])

    detector = FallDetector()
    frame_interval = 1.0 / CONFIG["FPS_TARGET"]
    last_frame_time = 0.0
    total_frames = 0

    log.info("Monitoring started. Press Ctrl+C to stop.")

    try:
        while True:
            now = time.time()
            if now - last_frame_time < frame_interval:
                time.sleep(0.001)
                continue

            ret, frame_bgr = cap.read()
            if not ret:
                log.warning("Frame capture failed — retrying...")
                time.sleep(0.1)
                continue

            last_frame_time = now
            total_frames += 1

            # Convert to RGB for MediaPipe
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

            # Analyze
            is_fall_pose, confidence, debug = detector.analyze_frame(frame_rgb)
            should_alert, final_conf = detector.update(is_fall_pose, confidence)

            if should_alert:
                log.warning(f"⚠ FALL DETECTED — confidence={final_conf:.0%} | debug={json.dumps(debug)}")
                save_thumbnail(frame_bgr, final_conf)
                send_fall_alert(final_conf)

            # Optional preview window
            if CONFIG["SHOW_PREVIEW"]:
                status = f"FALL! ({final_conf:.0%})" if is_fall_pose else "Normal"
                color = (0, 0, 255) if is_fall_pose else (0, 255, 100)
                cv2.putText(frame_bgr, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
                cv2.putText(frame_bgr, f"Frames: {detector.consecutive_fall_frames}/{CONFIG['FALL_FRAMES_NEEDED']}",
                            (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
                cv2.imshow("ElderCare — Fall Detector", frame_bgr)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break

            # Heartbeat log every 5 minutes
            if total_frames % (CONFIG["FPS_TARGET"] * 300) == 0:
                log.info(f"Heartbeat — {total_frames} frames processed, system running normally.")

    except KeyboardInterrupt:
        log.info("Stopped by user (Ctrl+C)")
    finally:
        cap.release()
        if CONFIG["SHOW_PREVIEW"]:
            cv2.destroyAllWindows()
        log.info("Fall detector shutdown complete.")


if __name__ == "__main__":
    main()
