"""
Wipe ALL collections from Firebase Firestore.
"""
import sys
sys.path.insert(0, '.')

from database import db

collections = [
    "bpm_logs", "fall_logs", "system_state", "events",
    "medicines", "reports", "fall_events", "medbox_schedule",
    "medbox_events", "device_status"
]

print("=" * 50)
print("  Deleting all Firebase Firestore data...")
print("=" * 50)

for col_name in collections:
    col_ref = db.collection(col_name)
    docs = col_ref.list_documents()
    deleted_count = 0
    for doc in docs:
        doc.delete()
        deleted_count += 1
    print(f"  [{col_name}] deleted {deleted_count} document(s)")

print()
print("  Firebase Firestore cleared successfully.")
print("=" * 50)
