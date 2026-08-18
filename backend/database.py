"""
Elder Care — MongoDB Atlas Database Layer (Python / Flask)
Replaced Firebase Admin SDK connection with PyMongo Atlas connection.
"""

import os
import time
import datetime
from pymongo import MongoClient
from dotenv import load_dotenv

# Load env variables from .env file
load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise ValueError("Environment variable MONGO_URI is not set. Please define it in your .env file.")

# Connect to MongoDB Atlas
client = MongoClient(MONGO_URI)
db = client["JEEVAN"]
print(f"[MongoDB] Connected successfully to Atlas -> JEEVAN")


# ── DatabaseLayer ──────────────────────────────────────────────────────────────
class DatabaseLayer:

    @staticmethod
    def initialize_db():
        """Seed the system_state document if it does not exist yet."""
        # Setup TTL index so raw fall logs auto-delete after 7 days
        try:
            db.fall_logs.create_index("timestamp", expireAfterSeconds=604800)
        except Exception:
            pass

        # Ensure system_state has the default current state doc
        db.system_state.update_one(
            {"_id": "current"},
            {"$setOnInsert": {
                "is_fall": False,
                "lid_open": False,
                "next_reminder": None,
                "last_torso_angle": 0.0,
                "last_fps": 0.0,
                "bpm": 72,
                "schedule": []
            }},
            upsert=True
        )
        print("[MongoDB] system_state initialized.")

    # ── Heart Rate ─────────────────────────────────────────────────────────────

    @staticmethod
    def save_bpm(bpm: int):
        now = time.time()
        db.bpm_logs.insert_one({"timestamp": now, "bpm": bpm})
        db.system_state.update_one(
            {"_id": "current"},
            {"$set": {"bpm": bpm, "last_bpm_time": now}},
            upsert=True
        )

    @staticmethod
    def get_bpm_history(limit: int = 60) -> list:
        docs = list(db.bpm_logs.find({}, {"_id": 0}).sort("timestamp", -1).limit(limit))
        docs.reverse()
        return docs

    # ── Medicine Box ───────────────────────────────────────────────────────────

    @staticmethod
    def update_medicine_state(lid_open: bool = None, reminder_triggered: bool = None):
        fields = {"last_medicine_time": time.time()}
        if lid_open is not None:
            fields["lid_open"] = lid_open
        if reminder_triggered is not None:
            fields["reminder_triggered"] = reminder_triggered
        db.system_state.update_one(
            {"_id": "current"},
            {"$set": fields},
            upsert=True
        )

    # ── Fall Detection ─────────────────────────────────────────────────────────

    @staticmethod
    def log_fall_frame(is_fall: bool, confidence: float, debug_info: dict):
        entry = {"timestamp": time.time(), "is_fall": is_fall, "confidence": confidence}
        entry.update(debug_info)
        db.fall_logs.insert_one(entry)

        state_update = {"is_fall": is_fall, "last_fall_signal": time.time()}
        if is_fall:
            state_update["last_torso_angle"] = debug_info.get("torso_angle", 0.0)
            state_update["last_fps"] = debug_info.get("fps", 0.0)
        db.system_state.update_one(
            {"_id": "current"},
            {"$set": state_update},
            upsert=True
        )

    @staticmethod
    def get_fall_stats() -> dict:
        # Group consecutive fall frames into "incidents"
        # (frames within 10 seconds of each other = 1 incident)
        fall_frames = list(db.fall_logs.find(
            {"is_fall": True},
            {"timestamp": 1, "_id": 0}
        ).sort("timestamp", 1))

        incidents = []
        last_incident_time = 0
        for f in fall_frames:
            ts = f.get("timestamp", 0)
            if ts - last_incident_time > 10:
                incidents.append(ts)
            last_incident_time = ts

        total_falls = len(incidents)
        start_of_today = time.time() - (time.time() % 86400)
        falls_today = len([t for t in incidents if t >= start_of_today])
        last_fall_time = incidents[-1] if incidents else None

        # Latest fall frame
        latest_fall_log = db.fall_logs.find_one({"is_fall": True}, sort=[("timestamp", -1)])

        return {
            "fall_count": total_falls,
            "falls_today": falls_today,
            "last_fall_time": last_fall_time,
            "torso_angle": latest_fall_log.get("torso_angle", 0) if latest_fall_log else 0,
            "fps": latest_fall_log.get("fps", 0) if latest_fall_log else 0.0,
        }

    # ── Events ─────────────────────────────────────────────────────────────────

    @staticmethod
    def log_event(event_type: str, message: str, severity: str):
        db.events.insert_one({
            "type": event_type,
            "message": message,
            "severity": severity,
            "timestamp": time.time(),
        })

    @staticmethod
    def get_events(limit: int = 60) -> list:
        return list(db.events.find({}, {"_id": 0}).sort("timestamp", -1).limit(limit))

    # ── Medicine Schedule ──────────────────────────────────────────────────────

    @staticmethod
    def save_schedule(schedule_list: list):
        db.system_state.update_one(
            {"_id": "current"},
            {"$set": {"schedule": schedule_list}},
            upsert=True
        )

    @staticmethod
    def get_schedule() -> list:
        doc = db.system_state.find_one({"_id": "current"})
        return doc.get("schedule", []) if doc else []

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
        res = db.reports.insert_one(doc)
        return str(res.inserted_id)

    @staticmethod
    def get_reports(limit: int = 20) -> list:
        docs = list(db.reports.find().sort("createdAt", -1).limit(limit))
        for doc in docs:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
        return docs

    # ── Medicines ──────────────────────────────────────────────────────────────

    @staticmethod
    def save_medicines_from_scan(medicines: list, source: str = "scan") -> list:
        saved = []
        for med in medicines:
            name = med.get("name", "").strip()
            if not name:
                continue
            doc_id = name.lower().replace(" ", "_")
            db.medicines.update_one(
                {"_id": doc_id},
                {"$set": {
                    "name": name,
                    "dosage": med.get("dosage", ""),
                    "purpose": med.get("purpose", ""),
                    "times": med.get("times", []),
                    "source": source,
                    "addedAt": time.time(),
                }},
                upsert=True
            )
            saved.append(name)
        return saved

    @staticmethod
    def get_all_medicines() -> list:
        docs = list(db.medicines.find())
        for doc in docs:
            if "_id" in doc:
                del doc["_id"]
        return docs

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
        res = db.medicines.delete_one({"_id": doc_id})
        return res.deleted_count > 0

    # ── Combined Dashboard State ───────────────────────────────────────────────

    @staticmethod
    def get_full_state() -> dict:
        doc = db.system_state.find_one({"_id": "current"}) or {}
        if "_id" in doc:
            del doc["_id"]
        stats = DatabaseLayer.get_fall_stats()
        doc.update(stats)
        doc["torso_angle"] = doc.get("last_torso_angle", 0.0)
        doc["fps"]         = doc.get("last_fps", 0.0)
        return doc


# Initialise on import
DatabaseLayer.initialize_db()
