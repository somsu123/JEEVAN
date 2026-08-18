import sys
sys.path.insert(0, '.')

print("=" * 52)
print("  ELDERCARE -- MongoDB Atlas Connection Test")
print("=" * 52)

try:
    from database import DatabaseLayer
    print()

    print("[TEST 1] system state...")
    state = DatabaseLayer.get_full_state()
    print(f"  PASS  keys found: {list(state.keys())[:5]} ...")
    print(f"  PASS  bpm={state.get('bpm', 'N/A')}  is_fall={state.get('is_fall', 'N/A')}")

    print()
    print("[TEST 2] BPM history...")
    history = DatabaseLayer.get_bpm_history(limit=5)
    print(f"  PASS  {len(history)} BPM record(s) retrieved")

    print()
    print("[TEST 3] Medicines catalogue...")
    meds = DatabaseLayer.get_all_medicines()
    print(f"  PASS  {len(meds)} medicine(s) in Atlas")
    for m in meds[:3]:
        print(f"        - {m.get('name')} {m.get('dosage','')}")

    print()
    print("[TEST 4] Event log...")
    events = DatabaseLayer.get_events(limit=5)
    print(f"  PASS  {len(events)} recent event(s) found")

    print()
    print("[TEST 5] Reports...")
    reports = DatabaseLayer.get_reports(limit=3)
    print(f"  PASS  {len(reports)} report(s) stored in Atlas")

    print()
    print("=" * 52)
    print("  ALL TESTS PASSED")
    print("  MongoDB Atlas is CONNECTED and HEALTHY!")
    print("  Database: JEEVAN")
    print("=" * 52)

except Exception as e:
    print(f"\n  FAILED: {e}")
    import traceback
    traceback.print_exc()
