"""
Wipe ALL collections from MongoDB Atlas eldercare_db before migrating to Firebase.
"""
import sys
sys.path.insert(0, '.')

from pymongo import MongoClient

ATLAS_URI = "mongodb+srv://souma9830:Souma2006@cluster0.nro7rjv.mongodb.net/"
client = MongoClient(ATLAS_URI)
db = client["eldercare_db"]

collections = [
    "bpm_logs", "fall_logs", "system_state", "events",
    "medicines", "reports", "fall_events", "medbox_schedule",
    "medbox_events", "device_status"
]

print("=" * 50)
print("  Deleting all MongoDB Atlas data...")
print("=" * 50)
for col in collections:
    result = db[col].delete_many({})
    print(f"  [{col}] deleted {result.deleted_count} document(s)")

# Drop all collections entirely
for col in db.list_collection_names():
    db.drop_collection(col)
    print(f"  Dropped collection: {col}")

print()
print("  MongoDB Atlas cleared successfully.")
print("=" * 50)
client.close()
