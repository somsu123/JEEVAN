# ElderCare MongoDB Fall Detector Schema Specifications

This document defines the official schema used to log and store fall events inside the local **MongoDB** database (`eldercare_db`) under the **`fall_logs`** collection.

In MongoDB, document structures are dynamic (schemaless), but keeping a standardized schema guarantees that your dashboard, AI voice assistant, and Python analytics scripts can reliably query historic detections.

---

## 📊 Database Collection: `fall_logs`

Each record represents a vision-based frame telemetry snapshot or a wearable-based impact alert logged during the detection process.

### 1. JSON Schema Definition

```json
{
  "_id": "6475a89f9d2a3c2004bb1a24",
  "timestamp": 1779188040.235,
  "iso_timestamp": "2026-05-30T13:40:40.235Z",
  "is_fall": true,
  "confidence": 0.92,
  "source": "camera",
  "location": "Living Room",
  "device_id": "pi-camera-01",
  "metrics": {
    "torso_angle": 82.4,
    "fps": 14.8,
    "angle_score": 0.92,
    "height_score": 0.88,
    "bbox_score": 0.95
  }
}
```

---

### 2. Field Specifications & Descriptions

| Field Name | BSON Data Type | Value Range | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| `_id` | `ObjectId` | Auto-generated | **Yes** | MongoDB's primary key index for record uniqueness. |
| `timestamp` | `Double` | Unix Epoch | **Yes** | Float representing absolute time in seconds (e.g. `time.time()`). |
| `iso_timestamp` | `String` | ISO 8601 | No | Standardized UTC format for easy human reading and external API integration. |
| `is_fall` | `Boolean` | `true` or `false` | **Yes** | **Fall detected (Yes or No)**. Indicates whether a fall pose is confirmed. |
| `confidence` | `Double` | `0.0` - `1.0` | **Yes** | Combined confidence percentage calculated by the vision algorithms. |
| `source` | `String` | `"camera"`, `"bracelet"` | **Yes** | The source device that triggered the warning event. |
| `location` | `String` | Text name | **Yes** | Friendly name of the area (e.g., `"Living Room"`, `"Kitchen"`). |
| `device_id` | `String` | Alphanumeric | No | Unique ID of the sensor hardware for multi-device environments. |
| `metrics` | `Document` | Nested Object | No | Contains physical bounding metrics calculated during pose detection. |
| `metrics.torso_angle`| `Double` | `0.0` - `90.0` | No | Angle from vertical (0° = standing, 90° = horizontal/fallen). |
| `metrics.fps` | `Double` | `1.0` - `60.0` | No | Frame processing rate during calculation on the device. |

---

## 🛠️ Python MongoDB Operations Guide

Here is a guide showing how to interact with this database schema using `pymongo` in Python.

### 1. Connect to Database & Create TTL (Automatic Auto-Clean) Index
We configure a TTL index to ensure raw log files older than **7 days** are automatically cleaned up, keeping the database fast and lightweight.

```python
from pymongo import MongoClient

# Connect to local MongoDB
client = MongoClient("mongodb://localhost:27017")
db = client["eldercare_db"]
logs_col = db["fall_logs"]

# Auto-delete logs after 7 days (604800 seconds) to conserve storage
logs_col.create_index("timestamp", expireAfterSeconds=604800)
print("✅ Connected to MongoDB and verified TTL indexes.")
```

### 2. Inserting a New Log (Fall Detected: YES)
```python
import time
from datetime import datetime

log_document = {
    "timestamp": time.time(),
    "iso_timestamp": datetime.utcnow().isoformat() + "Z",
    "is_fall": True,               # Fall Detected: Yes
    "confidence": 0.92,
    "source": "camera",
    "location": "Living Room",
    "device_id": "pi-camera-01",
    "metrics": {
        "torso_angle": 82.4,
        "fps": 15.0,
        "angle_score": 0.92,
        "height_score": 0.88,
        "bbox_score": 0.95
    }
}

insert_result = logs_col.insert_one(log_document)
print(f"✅ Alert saved in MongoDB! Document ID: {insert_result.inserted_id}")
```

### 3. Fetching Historic Detections
You can easily filter database documents based on the `is_fall` field to retrieve stats.

```python
# Fetch only the logs where a fall was detected (is_fall = True)
detected_falls = list(logs_col.find({"is_fall": True}).sort("timestamp", -1))

print(f"📋 Total Falls Logged: {len(detected_falls)}")
for fall in detected_falls[:5]: # Show last 5 incidents
    print(f" 🚨 {fall['iso_timestamp']} - Location: {fall['location']} | Confidence: {fall['confidence'] * 100:.0f}%")
```

### 4. Aggregation Query (Calculating Today's Fall Incidents)
This groups raw records to identify how many individual fall events occurred today:
```python
start_of_today = time.time() - (time.time() % 86400)

falls_today_count = logs_col.count_documents({
    "is_fall": True,
    "timestamp": {"$gte": start_of_today}
})

print(f"📈 Total distinct fall warnings triggered today: {falls_today_count}")
```
