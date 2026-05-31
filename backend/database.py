"""
Elder Care — Firebase Firestore Database Layer (Python / Flask)
Uses firebase-admin SDK — bypasses security rules entirely (server-side).

Collections managed here:
  bpm_logs       — raw heart-rate readings
  fall_logs      — raw fall-detection frames
  system_state   — live device state (single document: 'current')
  events         — system event log
  medicines      — prescriptions / medicines catalogue
  reports        — scanned prescription documents
"""

import os
import time
import datetime
import pathlib

import firebase_admin
from firebase_admin import credentials, firestore


# ── Firebase Configuration ─────────────────────────────────────────────────────
FIREBASE_PROJECT = "rfidcamera-8681b"


def _find_service_account() -> str | None:
    """
    Auto-detect the service account key JSON in the backend directory.
    Accepts any .json file that contains 'type': 'service_account'.
    """
    import json
    backend_dir = pathlib.Path(__file__).resolve().parent
    # Check priority names first
    priority_names = [
        "firebase-service-account.json",
        "serviceAccountKey.json",
        "service-account.json",
    ]
    for name in priority_names:
        p = backend_dir / name
        if p.exists():
            return str(p)
    # Scan ALL .json files in the folder for the service_account marker
    for p in backend_dir.glob("*.json"):
        try:
            content = json.loads(p.read_text(encoding="utf-8"))
            if content.get("type") == "service_account":
                return str(p)
        except Exception:
            continue
    return None


def _init_firebase():
    """Initialize Firebase Admin SDK with the service account key."""
    if firebase_admin._apps:
        return firestore.client()

    sa_path = _find_service_account()
    if sa_path:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)
        print(f"[Firebase] Initialized with service account: {pathlib.Path(sa_path).name}")
        return firestore.client()

    backend_dir = pathlib.Path(__file__).resolve().parent
    print()
    print("=" * 60)
    print("  [Firebase] SERVICE ACCOUNT KEY NOT FOUND")
    print("=" * 60)
    print(f"  Place the downloaded JSON key in: {backend_dir}")
    print("  Get it from: Firebase Console -> Project Settings -> Service Accounts")
    print()
    raise FileNotFoundError(
        f"Firebase service account key not found in {backend_dir}"
    )


db = _init_firebase()
print(f"[Firebase] Firestore client ready -> {FIREBASE_PROJECT}")


# ── DatabaseLayer ──────────────────────────────────────────────────────────────
class DatabaseLayer:

    @staticmethod
    def initialize_db():
        """Seed the system_state document if it does not exist yet."""
        doc_ref = db.collection("system_state").document("current")
        doc = doc_ref.get()
        if not doc.exists:
            doc_ref.set({
                "is_fall": False,
                "lid_open": False,
                "next_reminder": None,
                "last_torso_angle": 0.0,
                "last_fps": 0.0,
                "bpm": 72,
            })
            print("[Firebase] system_state/current document created.")
        else:
            print("[Firebase] system_state/current already exists.")

    # ── Heart Rate ─────────────────────────────────────────────────────────────

    @staticmethod
    def save_bpm(bpm: int):
        now = time.time()
        db.collection("bpm_logs").add({"timestamp": now, "bpm": bpm})
        db.collection("system_state").document("current").set(
            {"bpm": bpm, "last_bpm_time": now}, merge=True
        )

    @staticmethod
    def get_bpm_history(limit: int = 60) -> list:
        docs = (
            db.collection("bpm_logs")
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        result = [d.to_dict() for d in docs]
        result.reverse()
        return result

    # ── Medicine Box ───────────────────────────────────────────────────────────

    @staticmethod
    def update_medicine_state(lid_open: bool = None, reminder_triggered: bool = None):
        fields = {"last_medicine_time": time.time()}
        if lid_open is not None:
            fields["lid_open"] = lid_open
        if reminder_triggered is not None:
            fields["reminder_triggered"] = reminder_triggered
        db.collection("system_state").document("current").set(fields, merge=True)

    # ── Fall Detection ─────────────────────────────────────────────────────────

    @staticmethod
    def log_fall_frame(is_fall: bool, confidence: float, debug_info: dict):
        entry = {"timestamp": time.time(), "is_fall": is_fall, "confidence": confidence}
        entry.update(debug_info)
        db.collection("fall_logs").add(entry)

        state_update = {"is_fall": is_fall, "last_fall_signal": time.time()}
        if is_fall:
            state_update["last_torso_angle"] = debug_info.get("torso_angle", 0.0)
            state_update["last_fps"] = debug_info.get("fps", 0.0)
        db.collection("system_state").document("current").set(state_update, merge=True)

    @staticmethod
    def get_fall_stats() -> dict:
        # Fetch recent fall_logs ordered by timestamp only (no composite index needed)
        # Filter is_fall in Python to avoid Firestore composite index requirement
        all_docs = (
            db.collection("fall_logs")
            .order_by("timestamp")
            .limit(2000)
            .stream()
        )
        frames = [d.to_dict() for d in all_docs if d.to_dict().get("is_fall")]

        incidents, last_time = [], 0
        for f in frames:
            ts = f.get("timestamp", 0)
            if ts - last_time > 10:
                incidents.append(ts)
            last_time = ts

        total_falls = len(incidents)
        start_of_today = time.time() - (time.time() % 86400)
        falls_today = len([t for t in incidents if t >= start_of_today])
        last_fall_time = incidents[-1] if incidents else None

        # Latest fall frame (already in ascending order — take the last)
        latest = frames[-1] if frames else {}

        return {
            "fall_count": total_falls,
            "falls_today": falls_today,
            "last_fall_time": last_fall_time,
            "torso_angle": latest.get("torso_angle", 0),
            "fps": latest.get("fps", 0.0),
        }

    # ── Events ─────────────────────────────────────────────────────────────────

    @staticmethod
    def log_event(event_type: str, message: str, severity: str):
        db.collection("events").add({
            "type": event_type,
            "message": message,
            "severity": severity,
            "timestamp": time.time(),
        })

    @staticmethod
    def get_events(limit: int = 60) -> list:
        docs = (
            db.collection("events")
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        return [d.to_dict() for d in docs]

    # ── Medicine Schedule ──────────────────────────────────────────────────────

    @staticmethod
    def save_schedule(schedule_list: list):
        db.collection("system_state").document("current").set(
            {"schedule": schedule_list}, merge=True
        )

    @staticmethod
    def get_schedule() -> list:
        doc = db.collection("system_state").document("current").get()
        return doc.to_dict().get("schedule", []) if doc.exists else []

    # ── Reports ────────────────────────────────────────────────────────────────

    @staticmethod
    def save_report(file_name: str, summary: str, medicines: list,
                    scan_date: str, structured_data: dict = None) -> str:
        doc = {
            "fileName": file_name,
            "scanDate": scan_date,
            "summary": summary,
            "medicines": medicines,
            "createdAt": time.time(),
        }
        if structured_data:
            doc.update(structured_data)
        _, ref = db.collection("reports").add(doc)
        return ref.id

    @staticmethod
    def get_reports(limit: int = 20) -> list:
        docs = (
            db.collection("reports")
            .order_by("createdAt", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        result = []
        for d in docs:
            data = d.to_dict()
            data["id"] = d.id
            result.append(data)
        return result

    # ── Medicines ──────────────────────────────────────────────────────────────

    @staticmethod
    def save_medicines_from_scan(medicines: list, source: str = "scan") -> list:
        saved = []
        for med in medicines:
            name = med.get("name", "").strip()
            if not name:
                continue
            doc_id = name.lower().replace(" ", "_")
            db.collection("medicines").document(doc_id).set({
                "name": name,
                "dosage": med.get("dosage", ""),
                "purpose": med.get("purpose", ""),
                "times": med.get("times", []),
                "source": source,
                "addedAt": time.time(),
            })
            saved.append(name)
        return saved

    @staticmethod
    def get_all_medicines() -> list:
        docs = db.collection("medicines").stream()
        return [d.to_dict() for d in docs]

    @staticmethod
    def get_medicines_due_now(window_minutes: int = 2) -> list:
        now = datetime.datetime.now()
        due = []
        for med in DatabaseLayer.get_all_medicines():
            for t in med.get("times", []):
                try:
                    h, m = int(t.split(":")[0]), int(t.split(":")[1])
                    diff = abs((now.hour * 60 + now.minute) - (h * 60 + m))
                    if diff <= window_minutes:
                        due.append({**med, "scheduledTime": t})
                        break
                except (ValueError, IndexError):
                    continue
        return due

    @staticmethod
    def delete_medicine(name: str) -> bool:
        doc_id = name.lower().replace(" ", "_")
        ref = db.collection("medicines").document(doc_id)
        if ref.get().exists:
            ref.delete()
            return True
        return False

    # ── Combined Dashboard State ───────────────────────────────────────────────

    @staticmethod
    def get_full_state() -> dict:
        doc = db.collection("system_state").document("current").get()
        state = doc.to_dict() if doc.exists else {}
        stats = DatabaseLayer.get_fall_stats()
        state.update(stats)
        state["torso_angle"] = state.get("last_torso_angle", 0.0)
        state["fps"]         = state.get("last_fps", 0.0)
        return state


# Initialise on import
DatabaseLayer.initialize_db()
