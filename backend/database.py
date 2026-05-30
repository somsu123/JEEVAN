from pymongo import MongoClient
import time

# Connect to local MongoDB
client = MongoClient("mongodb://localhost:27017")
db = client["eldercare_db"]

class DatabaseLayer:
    @staticmethod
    def initialize_db():
        """Ensure necessary collections and indexes exist."""
        # Setup TTL index so raw logs auto-delete after 7 days
        try:
            db.fall_logs.create_index("timestamp", expireAfterSeconds=604800)
            db.bpm_logs.create_index("timestamp", expireAfterSeconds=604800)
        except Exception:
            pass
        
        # Always upsert the state document with all required fields
        # This ensures new fields appear even after a code update
        db.system_state.update_one(
            {"_id": "current_state"},
            {"$setOnInsert": {
                "is_fall": False,
                "lid_open": False,
                "next_reminder": None,
                "last_torso_angle": 0.0,
                "last_fps": 0.0,
                "bpm": 72,
            }},
            upsert=True
        )

    # ── METRICS & STATE ────────────────────────────────────────────────

    @staticmethod
    def save_bpm(bpm: int):
        """Save raw BPM readings in the same MongoDB connection."""
        db.bpm_logs.insert_one({
            "timestamp": time.time(),
            "bpm": bpm
        })
        db.system_state.update_one(
            {"_id": "current_state"},
            {"$set": {"bpm": bpm, "last_bpm_time": time.time()}},
            upsert=True
        )

    @staticmethod
    def update_medicine_state(lid_open: bool = None, reminder_triggered: bool = None):
        update_fields = {"last_medicine_time": time.time()}
        if lid_open is not None:
            update_fields["lid_open"] = lid_open
        if reminder_triggered is not None:
            update_fields["reminder_triggered"] = reminder_triggered
            
        db.system_state.update_one(
            {"_id": "current_state"},
            {"$set": update_fields},
            upsert=True
        )

    # ── FALL TRACKING ────────────────────────────────────────────────
    @staticmethod
    def log_fall_frame(is_fall: bool, confidence: float, debug_info: dict):
        """Log raw frame metrics (torso angle, fps, etc)."""
        log_entry = {
            "timestamp": time.time(),
            "is_fall": is_fall,
            "confidence": confidence,
        }
        log_entry.update(debug_info)
        db.fall_logs.insert_one(log_entry)

        # Build state update
        state_update = {"is_fall": is_fall, "last_fall_signal": time.time()}

        # If this is an actual fall, snapshot the metrics into system_state
        # so the dashboard can always read them fast without another query
        if is_fall:
            state_update["last_torso_angle"] = debug_info.get("torso_angle", 0.0)
            state_update["last_fps"] = debug_info.get("fps", 0.0)

        db.system_state.update_one(
            {"_id": "current_state"},
            {"$set": state_update},
            upsert=True
        )

    @staticmethod
    def get_fall_stats():
        """Count falls from fall_logs and get last fall metrics."""
        import math
        
        # Get all distinct fall timestamps from fall_logs where is_fall=True
        fall_frames = list(db.fall_logs.find(
            {"is_fall": True}, 
            {"timestamp": 1, "_id": 0}
        ).sort("timestamp", 1))
        
        # Group consecutive fall frames into "incidents" 
        # (frames within 10 seconds of each other = 1 incident)
        incidents = []
        last_incident_time = 0
        for f in fall_frames:
            ts = f["timestamp"]
            if ts - last_incident_time > 10:  # new incident if >10s gap
                incidents.append(ts)
            last_incident_time = ts
        
        total_falls = len(incidents)
        
        # Count today's falls
        start_of_today = time.time() - (time.time() % 86400)
        falls_today = len([t for t in incidents if t >= start_of_today])
        
        # Last fall time
        last_fall_time = incidents[-1] if incidents else None
        
        # Get the latest metrics from an actual fall frame
        latest_fall_log = db.fall_logs.find_one({"is_fall": True}, sort=[("timestamp", -1)])
        
        return {
            "fall_count": total_falls,
            "falls_today": falls_today,
            "last_fall_time": last_fall_time,
            "torso_angle": latest_fall_log.get("torso_angle", 0) if latest_fall_log else 0,
            "fps": latest_fall_log.get("fps", 0) if latest_fall_log else 0.0,
        }

    # ── EVENTS ───────────────────────────────────────────────────────
    @staticmethod
    def log_event(event_type: str, message: str, severity: str):
        db.events.insert_one({
            "type": event_type,
            "message": message,
            "severity": severity,
            "timestamp": time.time()
        })

    @staticmethod
    def get_events(limit: int = 60):
        events = list(db.events.find({}, {"_id": 0}).sort("timestamp", -1).limit(limit))
        return events

    # ── MEDICINE SCHEDULE (legacy simple list) ────────────────────────
    @staticmethod
    def save_schedule(schedule_list):
        db.system_state.update_one(
            {"_id": "current_state"},
            {"$set": {"schedule": schedule_list}},
            upsert=True
        )

    @staticmethod
    def get_schedule():
        state = db.system_state.find_one({"_id": "current_state"})
        return state.get("schedule", []) if state else []

    # ── REPORTS — Scanned prescriptions/documents ─────────────────────
    @staticmethod
    def save_report(file_name: str, summary: str, medicines: list, scan_date: str):
        """Save a scanned report with its summary and extracted medicines."""
        doc = {
            "fileName": file_name,
            "scanDate": scan_date,
            "summary": summary,
            "medicines": medicines,   # list of { name, dosage, times[], purpose }
            "createdAt": time.time(),
        }
        result = db.reports.insert_one(doc)
        return str(result.inserted_id)

    @staticmethod
    def get_reports(limit: int = 20):
        """Return the most recent scanned reports."""
        docs = list(
            db.reports.find({}, {"_id": 1, "fileName": 1, "scanDate": 1,
                                 "summary": 1, "medicines": 1, "createdAt": 1})
                      .sort("createdAt", -1)
                      .limit(limit)
        )
        for d in docs:
            d["id"] = str(d.pop("_id"))
        return docs

    # ── MEDICINES — Extracted from prescriptions ───────────────────────
    @staticmethod
    def save_medicines_from_scan(medicines: list, source: str = "scan"):
        """
        Upsert medicines extracted from a prescription scan.
        medicines = [{ name, dosage, times, purpose }]
        """
        saved = []
        for med in medicines:
            name = med.get("name", "").strip()
            if not name:
                continue
            doc = {
                "name":    name,
                "dosage":  med.get("dosage", ""),
                "purpose": med.get("purpose", ""),
                "times":   med.get("times", []),   # list of "HH:MM" strings
                "source":  source,
                "addedAt": time.time(),
            }
            db.medicines.update_one(
                {"name": {"$regex": f"^{name}$", "$options": "i"}},
                {"$set": doc},
                upsert=True
            )
            saved.append(name)
        return saved

    @staticmethod
    def get_all_medicines():
        """Return all medicines in the database."""
        docs = list(db.medicines.find({}, {"_id": 0}))
        return docs

    @staticmethod
    def get_medicines_due_now(window_minutes: int = 2):
        """
        Return medicines whose scheduled time falls within ±window_minutes of now.
        Used by the reminder cron to trigger voice alerts.
        """
        import datetime
        now = datetime.datetime.now()
        due = []
        all_meds = list(db.medicines.find({}, {"_id": 0}))
        for med in all_meds:
            for t in med.get("times", []):
                try:
                    parts = t.split(":")
                    med_hour, med_min = int(parts[0]), int(parts[1])
                    diff_minutes = abs((now.hour * 60 + now.minute) - (med_hour * 60 + med_min))
                    if diff_minutes <= window_minutes:
                        due.append({**med, "scheduledTime": t})
                        break
                except (ValueError, IndexError):
                    continue
        return due

    @staticmethod
    def delete_medicine(name: str):
        """Delete a medicine by name (case-insensitive)."""
        result = db.medicines.delete_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
        return result.deleted_count > 0

    # ── COMBINED DASHBOARD STATE ──────────────────────────────────────
    @staticmethod
    def get_full_state():
        state = db.system_state.find_one({"_id": "current_state"}, {"_id": 0}) or {}
        
        # Merge dynamic fall stats (counts/last-time) from events collection
        stats = DatabaseLayer.get_fall_stats()
        state.update(stats)

        # Expose last-fall metrics with simple names for the dashboard
        state["torso_angle"] = state.get("last_torso_angle", 0.0)
        state["fps"]         = state.get("last_fps", 0.0)
        
        return state

# Initialize database mapping when this file is imported
DatabaseLayer.initialize_db()
