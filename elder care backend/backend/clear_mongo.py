"""
Wipe ALL collections from MongoDB Atlas JEEVAN before migrating to Firebase.
"""
import sys
import os
from dotenv import load_dotenv
sys.path.insert(0, '.')
load_dotenv()

from pymongo import MongoClient

ATLAS_URI = os.getenv("MONGO_URI")
if not ATLAS_URI:
    raise ValueError("MONGO_URI environment variable is required.")
client = MongoClient(ATLAS_URI)
db = client["JEEVAN"]

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
