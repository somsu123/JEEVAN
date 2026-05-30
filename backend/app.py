from flask import Flask, request, jsonify
from flask_cors import CORS
import time

# Import our new MongoDB Database Layer
from database import DatabaseLayer

app = Flask(__name__)
CORS(app)

# --- Heart Rate Endpoint ---
@app.route('/api/heartrate', methods=['POST'])
def update_heartrate():
    try:
        data = request.get_json()
        if 'bpm' in data:
            bpm = int(data['bpm'])
            DatabaseLayer.save_bpm(bpm)
            return jsonify({"status": "success", "bpm": bpm}), 200
        return jsonify({"error": "Invalid format"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Medicine Box Endpoint ---
@app.route('/api/medicine', methods=['POST'])
def update_medicine():
    try:
        data = request.get_json()
        updated = False
        lid_open = data.get('lid_open')
        reminder = data.get('reminder_triggered')
        
        if lid_open is not None or reminder is not None:
            DatabaseLayer.update_medicine_state(lid_open, reminder)
            return jsonify({"status": "success", "state": data}), 200
            
        return jsonify({"error": "No valid fields"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Fall Detection Endpoint ---
@app.route('/api/fall', methods=['POST'])
def update_fall():
    try:
        data = request.get_json()
        if 'is_fall' in data:
            is_fall = data['is_fall']
            confidence = data.get('confidence', 0.0)
            
            # Read previous state BEFORE updating, to detect False→True transition
            prev_state = DatabaseLayer.get_full_state()
            was_falling = prev_state.get('is_fall', False)
            
            # Log raw metrics and update state
            debug_info = {k: v for k, v in data.items() if k not in ["is_fall", "confidence"]}
            DatabaseLayer.log_fall_frame(is_fall, confidence, debug_info)
            
            # Log event only on new fall (transition from not-fall to fall)
            if is_fall and not was_falling:
                source = data.get("source", "camera")
                if source == "bracelet":
                    impact_g = data.get("impact_g", 0.0)
                    msg = f"Fall detected by wrist bracelet (impact: {impact_g:.1f}g)"
                else:
                    msg = "Fall detected by vision system (camera)"
                DatabaseLayer.log_event("fall", msg, "critical")
                
            return jsonify({"status": "success"}), 200
        return jsonify({"error": "Invalid format"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Dashboard State Polling ---
@app.route('/api/state', methods=['GET'])
def get_state():
    try:
        state = DatabaseLayer.get_full_state()
        return jsonify(state), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Medicine Schedule API ---
@app.route('/api/schedule', methods=['GET', 'POST'])
def handle_schedule():
    if request.method == 'GET':
        schedule = DatabaseLayer.get_schedule()
        return jsonify({"schedule": schedule}), 200
    
    # POST
    try:
        data = request.get_json()
        # Ensure 'schedule' list is passed
        schedule = data if isinstance(data, list) else data.get('schedule', [])
        DatabaseLayer.save_schedule(schedule)
        return jsonify({"status": "success"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Event Logging API ---
@app.route('/api/events', methods=['GET'])
def get_events():
    try:
        events = DatabaseLayer.get_events(limit=60)
        return jsonify(events), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── REPORTS — Scanned prescriptions ────────────────────────────────────────

@app.route('/api/reports', methods=['GET'])
def get_reports():
    """Return all saved scanned reports from MongoDB."""
    try:
        reports = DatabaseLayer.get_reports(limit=30)
        return jsonify({"reports": reports}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/reports/save', methods=['POST'])
def save_report():
    """Save a scanned report + extracted medicines to MongoDB."""
    try:
        data = request.get_json()
        file_name  = data.get("fileName", "unnamed")
        summary    = data.get("summary", "")
        medicines  = data.get("medicines", [])   # list of { name, dosage, times, purpose }
        scan_date  = data.get("scanDate", "")

        # 1. Save the full report document
        report_id = DatabaseLayer.save_report(file_name, summary, medicines, scan_date)

        # 2. Upsert medicines into the medicines collection
        saved_names = []
        if medicines:
            saved_names = DatabaseLayer.save_medicines_from_scan(medicines, source="scan")

        return jsonify({
            "status": "success",
            "reportId": report_id,
            "medicinesSaved": saved_names
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── MEDICINES — CRUD ────────────────────────────────────────────────────────

@app.route('/api/medicines', methods=['GET'])
def get_medicines():
    """Return all medicines from MongoDB."""
    try:
        medicines = DatabaseLayer.get_all_medicines()
        return jsonify({"medicines": medicines}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/medicines/save', methods=['POST'])
def save_medicines():
    """Bulk-save medicines (from prescription scan or manual entry)."""
    try:
        data = request.get_json()
        medicines = data if isinstance(data, list) else data.get("medicines", [])
        saved = DatabaseLayer.save_medicines_from_scan(medicines, source=data.get("source", "manual") if isinstance(data, dict) else "manual")
        return jsonify({"status": "success", "saved": saved}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/medicines/due', methods=['GET'])
def get_medicines_due():
    """Return medicines whose scheduled time matches now (±2 minutes)."""
    try:
        window = int(request.args.get("window", 2))
        due = DatabaseLayer.get_medicines_due_now(window_minutes=window)
        return jsonify({"due": due}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/medicines/<name>', methods=['DELETE'])
def delete_medicine(name):
    """Delete a medicine by name."""
    try:
        deleted = DatabaseLayer.delete_medicine(name)
        if deleted:
            return jsonify({"status": "deleted", "name": name}), 200
        return jsonify({"error": "Medicine not found"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Listen on all interfaces so ESP32 can connect
    app.run(host='0.0.0.0', port=5000)
